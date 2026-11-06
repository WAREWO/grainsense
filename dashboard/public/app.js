'use strict';
// =====================================================================
//  GrainSense dashboard - logika browser
//  Data real-time dari server.js lewat Server-Sent Events (/api/stream),
//  riwayat grafik dari /api/riwayat, perintah ke ESP lewat /api/perintah.
// =====================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const WARNA = {
  g800: '#14532d', g700: '#1d6b45', g500: '#2f9e62', g300: '#7fcfa2',
  oranye: '#d9770b', merah: '#d23b30', tinta2: '#5b6660', tinta3: '#97a19b', garis: '#edf0ee',
};
const BASI_MS = 20000;           // > 20 s tanpa telemetri = data dianggap basi
const KOLOM_ANGKA = ['t_dalam', 'rh_dalam', 't_masuk', 'rh_masuk', 'co2', 'massa_g', 'kadar_air'];

const st = {
  labelCo2: 'CO₂', silo: 'silo01', kapasitasG: 11000, es: null,
  serverOk: false, mqtt: false, esp: { status: 'tidak diketahui', sejak: 0 },
  t: null, selisihJam: 0, waktuKirim: 0,
  kejadian: [], filter: 'semua',
  ringkasan: null, batch: null, tampilPeringatan: 'aktif',
  rentang: '1h', metrik: 'suhu', proyeksi: true,
  satuJam: null, riwayat: null, geo: null,
};

// ============================== UTILITAS =============================
const kini = () => Date.now() + st.selisihJam;          // jam server (laptop)
const p2 = (n) => String(n).padStart(2, '0');
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const jeda = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(v, des = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString('id-ID', { minimumFractionDigits: des, maximumFractionDigits: des });
}
function jam(ms, detik = false) {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}${detik ? ':' + p2(d.getSeconds()) : ''}`;
}
const tanggal = (ms) => { const d = new Date(ms); return `${d.getDate()} ${BULAN[d.getMonth()]}`; };
const hariIni = (ms) => new Date(ms).toDateString() === new Date(kini()).toDateString();
function lama(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} dtk`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt`;
  const j = Math.floor(m / 60);
  return j < 48 ? `${j} j ${m % 60} mnt` : `${Math.floor(j / 24)} hari`;
}
function hms(detik) {
  detik = Math.max(0, Math.floor(detik));
  return `${p2(Math.floor(detik / 3600))}:${p2(Math.floor((detik % 3600) / 60))}:${p2(detik % 60)}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ikon = (id) => `<svg><use href="#${id}"/></svg>`;

function toast(teks, jenis = '') {
  const el = document.createElement('div');
  el.className = `toast ${jenis}`;
  el.textContent = teks;
  $('#toast-wadah').append(el);
  setTimeout(() => el.remove(), 4000);
}

const basi = () => !st.t || kini() - st.t.diterima > BASI_MS;
const espOnline = () => st.esp.status === 'online';

// ============================== PERINTAH =============================
function konfirmasi({ judul, pesan, perintah, tombol = 'Kirim perintah', bahaya = false }) {
  const dlg = $('#dlg-konfirmasi');
  $('#konf-judul').textContent = judul;
  $('#konf-pesan').textContent = pesan;
  $('#konf-perintah').innerHTML = perintah.map((c) => `<code>${esc(c)}</code>`).join('');
  const ok = $('#konf-ok');
  ok.textContent = tombol;
  ok.classList.toggle('bahaya', bahaya);
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
}

async function kirim(daftar) {
  for (const cmd of daftar) {
    const r = await fetch(api('/api/perintah'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.galat || `Gagal mengirim (${r.status})`);
    if (daftar.length > 1) await jeda(350);
  }
}

async function aksi(opsi) {
  if (!(await konfirmasi(opsi))) return;
  try {
    await kirim(opsi.perintah);
    toast(`Terkirim: ${opsi.perintah.join('  ·  ')}`);
  } catch (e) { toast(e.message, 'buruk'); }
}

// silo yang dibuka (?silo=silo02); semua panggilan /api/* membawa parameter ini
let SILO_PILIH = new URLSearchParams(location.search).get('silo');
function api(alamat) {
  if (!SILO_PILIH) return alamat;
  return alamat + (alamat.includes('?') ? '&' : '?') + `silo=${encodeURIComponent(SILO_PILIH)}`;
}
const namaSilo = (id) => `Silo ${String(id || '').replace(/^silo[-_ ]?/i, '').toUpperCase() || '—'}`;

function unduh(alamat) {
  if (window.GS_DEMO) window.GS_DEMO.unduh(alamat);   // mode demo: CSV dibuat di browser
  else window.location.href = alamat;
}

const menitManual = () => $('#pilih-menit').value;
const lamaManual = () => $('#pilih-menit').selectedOptions[0].textContent;

const AKSI = {
  auto: () => aksi({ judul: 'Kembali ke mode AUTO?', pesan: 'Blower akan dikendalikan lagi oleh logika Tabel 3.5.', perintah: ['auto'] }),
  manualOn: () => aksi({
    judul: 'Nyalakan blower manual?',
    pesan: `Blower dipaksa NYALA selama ${lamaManual()} tanpa memedulikan kelayakan udara, lalu otomatis kembali AUTO.`,
    perintah: [`manual on ${menitManual()}`], tombol: 'Nyalakan',
  }),
  manualOff: () => aksi({
    judul: 'Paksa blower mati?',
    pesan: `Blower dipaksa MATI selama ${lamaManual()}, lalu otomatis kembali AUTO.`,
    perintah: [`manual off ${menitManual()}`], tombol: 'Matikan', bahaya: true,
  }),
  demo: () => {
    const nyala = !st.t?.demo;
    aksi({
      judul: nyala ? 'Aktifkan mode DEMO?' : 'Matikan mode DEMO?',
      pesan: nyala ? 'Durasi minimum nyala/mati dan CO₂ bertahan 3 detik (untuk presentasi juri).'
        : 'Durasi tetap 3 detik.',
      perintah: [nyala ? 'demo on' : 'demo off'],
    });
  },
  tara: () => aksi({
    judul: 'Tara timbangan?',
    pesan: 'Bacaan massa saat ini akan dijadikan NOL. Pastikan wadah sudah terpasang dan KOSONG dari gabah.',
    perintah: ['tara'], tombol: 'Tara sekarang', bahaya: true,
  }),
};

async function sinkronWaktu() {
  const r = await fetch(api('/api/sinkron-waktu'), { method: 'POST' }).catch(() => null);
  if (r?.ok) toast('Waktu laptop dikirim ke grainsense/time');
  else toast('Gagal: broker MQTT belum tersambung', 'buruk');
}

// ============================== RENDER: KONEKSI ======================
function setChip(el, kelas, teks) {
  el.classList.remove('ok', 'buruk');
  if (kelas) el.classList.add(kelas);
  el.lastChild.textContent = teks;
}

function renderKoneksi() {
  setChip($('#kon-server'), st.serverOk ? 'ok' : 'buruk', st.serverOk ? 'Server' : 'Server terputus');
  setChip($('#kon-mqtt'), st.mqtt ? 'ok' : 'buruk', st.mqtt ? 'Broker MQTT' : 'Broker MQTT putus');
  let kelas = '', teks = 'ESP32 —';
  if (st.esp.status === 'offline') { kelas = 'buruk'; teks = 'ESP32 offline'; }
  else if (st.t && basi()) { kelas = 'buruk'; teks = `ESP32 diam ${lama(kini() - st.t.diterima)}`; }
  else if (espOnline() && st.t) { kelas = 'ok'; teks = 'ESP32 online'; }
  else if (espOnline()) { kelas = 'ok'; teks = 'ESP32 online (menunggu data)'; }
  setChip($('#kon-esp'), kelas, teks);

  const rssi = st.t?.rssi;
  const mutu = !rssi ? '' : rssi >= -60 ? ' · kuat' : rssi >= -72 ? ' · sedang' : ' · lemah';
  $('#kon-rssi b').textContent = rssi ? `${rssi} dBm${mutu}` : '— dBm';
  document.body.classList.toggle('data-basi', !!st.t && basi());

  // banner offline / menunggu
  const ban = $('#banner-offline');
  let pesan = '';
  if (!st.serverOk) pesan = 'Server dashboard tidak terjangkau. Pastikan <code>node server.js</code> masih berjalan.';
  else if (!st.mqtt) pesan = 'Server belum tersambung ke broker MQTT. Jalankan Mosquitto: <code>mosquitto -c mosquitto.conf -v</code>';
  else if (st.esp.status === 'offline') {
    pesan = `<b>ESP32 offline</b> sejak ${jam(st.esp.sejak)} (${lama(kini() - st.esp.sejak)} lalu).` +
      (st.t ? ` Nilai yang tampil adalah data terakhir pukul ${jam(st.t.diterima, true)}.` : '');
  } else if (st.t && basi()) {
    pesan = `<b>Tidak ada data</b> dari ESP32 selama ${lama(kini() - st.t.diterima)}. Cek daya, WiFi hotspot, dan broker.`;
  } else if (!st.t) {
    pesan = 'Menunggu data pertama dari ESP32… Tanpa hardware? Jalankan simulator: <code>npm run sim</code>';
  }
  ban.hidden = !pesan;
  $('#banner-offline-teks').innerHTML = pesan;
}

// ============================== RENDER: TELEMETRI ====================
function deltaSatuJam(k) {
  const titik = st.satuJam?.titik;
  if (!titik || st.t?.[k] == null) return null;
  const lamaP = titik.find((p) => p[k] != null);
  if (!lamaP) return null;
  const menit = Math.round((kini() - lamaP.ts) / 60000);
  if (menit < 3) return null;
  return { d: st.t[k] - lamaP[k], menit };
}

function htmlDelta(k, des, satuan) {
  const x = deltaSatuJam(k);
  if (!x) return null;
  const arah = Math.abs(x.d) < 10 ** -des / 2 ? '=' : x.d > 0 ? '▲' : '▼';
  const kapan = x.menit >= 55 ? '1 jam lalu' : `${x.menit} mnt lalu`;
  return `<span class="delta">${arah} ${fmt(Math.abs(x.d), des)}${satuan}</span> dibanding ${kapan}`;
}

const NAMA_STATUS = { ok: 'OK', pemanasan: 'PEMANASAN', belum_kalibrasi: 'BELUM KALIBRASI', gangguan: 'GANGGUAN' };

function renderStat() {
  const t = st.t;
  $('#v-tdalam').textContent = fmt(t.t_dalam, 1);
  $('#v-rhdalam').textContent = fmt(t.rh_dalam, 1);
  $('#v-co2').textContent = t.co2 == null ? '—' : fmt(t.co2, 0);
  $('#v-massa').textContent = t.massa_g == null ? '—' : fmt(t.massa_g / 1000, 2);

  const kartu = (m) => $(`.stat[data-metrik="${m}"]`);
  kartu('suhu').classList.toggle('waspada', t.t_dalam != null && t.t_dalam >= 28);
  kartu('co2').classList.toggle('waspada', t.co2 != null && t.co2 >= 1500 && t.co2 <= 3000);
  kartu('co2').classList.toggle('bahaya', !!t.alarm_co2);

  const sen = t.sensor || {};
  const kakiSensor = (s) => (s && s !== 'ok' ? `Sensor: ${NAMA_STATUS[s] || s}` : null);

  $('#d-tdalam').innerHTML = kakiSensor(sen.sht_dalam) || htmlDelta('t_dalam', 1, ' °C') ||
    (t.t_dalam >= 28 ? 'Di atas ambang aerasi 28 °C' : 'Ambang aerasi 28 °C');
  $('#d-rhdalam').innerHTML = kakiSensor(sen.sht_dalam) || htmlDelta('rh_dalam', 1, ' %') || 'Kelembapan ruang simpan';

  let kakiCo2 = kakiSensor(sen.co2);
  if (sen.co2 === 'pemanasan') kakiCo2 = 'Sensor pemanasan (±3 menit), belum dipakai logika';
  if (t.alarm_co2) kakiCo2 = '⚠ Di atas 3000 ppm — periksa manual';
  $('#d-co2').innerHTML = kakiCo2 || htmlDelta('co2', 0, '') ||
    (t.co2 >= 1500 ? 'Di atas ambang aerasi 1500 ppm' : 'Ambang aerasi 1500 ppm');

  let chip;
  if (sen.hx711 && sen.hx711 !== 'ok') chip = `<span class="chip-massa bergerak">${NAMA_STATUS[sen.hx711]}</span>`;
  else if (t.massa_beku) chip = '<span class="chip-massa beku">BEKU</span> ditahan selama blower menyala (getaran)';
  else if (!t.massa_stabil) chip = '<span class="chip-massa bergerak">MENIMBANG</span> menunggu angka stabil';
  else {
    const tr = st.kejadian.find((k) => k.jenis === 'transaksi');
    chip = '<span class="chip-massa">STABIL</span>' +
      (tr ? ` terakhir ${tr.data.delta_g > 0 ? 'masuk' : 'keluar'} ${fmt(Math.abs(tr.data.delta_g) / 1000, 2)} kg, ${jam(tr.ts)}` : ' belum ada transaksi');
  }
  $('#d-massa').innerHTML = chip;

  // tabel nilai proses di samping tangki (warna hanya saat tidak normal)
  const kal = sen.kapasitif === 'ok' && t.kadar_air != null;
  const pv = (id, nilai, des, tingkat) => {
    const tr = $(id);
    tr.querySelector('b').textContent = nilai == null ? '—' : fmt(nilai, des);
    tr.classList.toggle('waspada', tingkat === 'waspada');
    tr.classList.toggle('bahaya', tingkat === 'bahaya');
  };
  pv('#pv-kadar', kal ? t.kadar_air : null, 1, !kal ? '' : t.kadar_air > AIR.basah ? 'bahaya' : t.kadar_air > AIR.aman ? 'waspada' : '');
  pv('#pv-suhu', t.t_dalam, 1, t.t_dalam != null && t.t_dalam >= 28 ? 'waspada' : '');
  pv('#pv-rh', t.rh_dalam, 1, '');
  pv('#pv-co2', t.co2, 0, t.alarm_co2 ? 'bahaya' : t.co2 != null && t.co2 >= 1500 ? 'waspada' : '');
  pv('#pv-tmasuk', t.t_masuk, 1, '');
  pv('#pv-rhmasuk', t.rh_masuk, 1, t.rh_masuk != null && t.rh_masuk > 70 ? 'waspada' : '');
}

// alasan singkat 1 baris; teks lengkap dari firmware muncul saat kursor diarahkan
function ringkasAlasan(t) {
  if (t.mode === 'MANUAL') {
    const sisa = /sisa (\d+ (?:menit|detik))/.exec(t.alasan || '');
    return `${t.blower ? 'Dipaksa nyala' : 'Dipaksa mati'} oleh operator${sisa ? `, sisa ${sisa[1]}` : ''}`;
  }
  if ((t.alasan || '').startsWith('Keputusan otomatis dihentikan')) return 'Kendali otomatis berhenti: sensor suhu/RH gangguan';
  if (t.blower) {
    if (t.t_dalam != null && t.t_dalam >= 28) return 'Mendinginkan ruang simpan (suhu ≥ 28 °C)';
    if (t.co2 != null && t.co2 >= 1500) return `Mengganti udara, ${st.labelCo2} tinggi`;
    return 'Aerasi berjalan sampai kondisi turun';
  }
  if (t.butuh_aerasi && !t.udara_layak) {
    if (t.rh_masuk != null && t.rh_masuk > 70) return `Ditunda: udara masuk terlalu lembap (RH ${fmt(t.rh_masuk, 0)} %)`;
    return 'Ditunda: udara masuk kurang sejuk';
  }
  if (t.butuh_aerasi) return 'Menunggu jeda minimum sebelum menyala';
  return 'Tidak perlu aerasi saat ini';
}

function lamaJam(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const j = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return j ? `${j}:${p2(m)}:${p2(s % 60)}` : `${p2(m)}:${p2(s % 60)}`;
}

function renderDurasiBlower() {
  const t = st.t;
  if (!t) return;
  const ev = st.kejadian.find((k) => k.jenis === 'blower');
  const cocok = ev && !!ev.data.blower === !!t.blower;
  $('#blower-durasi').textContent = cocok ? lamaJam(kini() - ev.ts) : '--:--';
  $('#blower-sejak').textContent = cocok
    ? `lama ${t.blower ? 'menyala' : 'mati'} · sejak ${jam(ev.ts)}`
    : 'belum ada catatan perubahan';
}

// syarat aerasi Tabel 3.5 beserta nilainya (✓ terpenuhi, ✕ tidak)
function renderAturan(t) {
  const ada = (...v) => v.every((x) => x != null);
  const cek = (ok, adaNilai) => (!adaNilai ? '' : ok ? 'ya' : 'tidak');
  const selisih = ada(t.t_dalam, t.t_masuk) ? t.t_dalam - t.t_masuk : null;
  const kepala = (judul, ok) => `<li class="kelompok ${ok ? 'ya' : 'tidak'}"><span>${judul}</span><b>${ok ? 'YA' : 'TIDAK'}</b></li>`;
  const baris = (k, nama, nilai) => `<li class="${k}"><span>${nama}</span><b>${nilai}</b></li>`;
  $('#aturan').innerHTML = [
    kepala('Butuh aerasi <small>(salah satu)</small>', !!t.butuh_aerasi),
    baris(cek(t.t_dalam >= 28, ada(t.t_dalam)), 'Suhu ruang ≥ 28 °C', `${fmt(t.t_dalam)} °C`),
    baris(cek(t.co2 >= 1500, ada(t.co2)), `${esc(st.labelCo2)} ≥ 1500 ppm selama 3 detik`, `${t.co2 == null ? '—' : fmt(t.co2, 0)} ppm`),
    kepala('Udara masuk layak <small>(keduanya)</small>', !!t.udara_layak),
    baris(cek(t.rh_masuk <= 70, ada(t.rh_masuk)), 'RH udara masuk ≤ 70 %', `${fmt(t.rh_masuk)} %`),
    baris(cek(selisih >= 3, selisih != null), 'Udara masuk ≥ 3 °C lebih dingin', selisih == null ? '—' : `${fmt(selisih)} °C`),
  ].join('');
}

function renderAerasi() {
  const t = st.t;
  const bs = $('#blower-status');
  bs.classList.toggle('nyala', !!t.blower);
  bs.classList.toggle('mati', !t.blower);
  $('#blower-teks').textContent = t.blower ? 'MENYALA' : 'MATI';
  renderDurasiBlower();
  renderAturan(t);
  $('#alasan').textContent = ringkasAlasan(t);
  $('#alasan').title = t.alasan || '';

  const chips = [`<span class="${t.mode === 'MANUAL' ? 'manual' : ''}">${esc(t.mode)}</span>`];
  if (t.demo) chips.push('<span class="demo">DEMO</span>');
  if (t.simulasi) chips.push('<span class="sim">SIMULASI</span>');
  $('#chips-mode').innerHTML = chips.join('');

  const btn = $('#btn-blower');
  btn.classList.toggle('mati', !!t.blower);
  btn.querySelector('span').textContent = t.blower ? `Matikan · ${lamaManual()}` : `Nyalakan · ${lamaManual()}`;

  $('#mode-kontrol').textContent = t.mode + (t.demo ? ' + DEMO' : '');
  $('#mode-kontrol').className = `pil-kecil ${t.mode === 'MANUAL' ? 'waspada' : ''}`;
  $('[data-cmd="auto"]').classList.toggle('aktif', t.mode === 'AUTO');
  $('#btn-manual-on').closest('.btn-kontrol').classList.toggle('aktif', t.mode === 'MANUAL' && !!t.blower);
  $('#btn-manual-off').classList.toggle('aktif', t.mode === 'MANUAL' && !t.blower);
}

function renderSensor() {
  const t = st.t || {};
  const sen = t.sensor || {};
  const SENSOR = [
    { k: 'sht_dalam', nama: 'SHT31 ruang simpan', ket: `${fmt(t.t_dalam)} °C · ${fmt(t.rh_dalam)} %RH`, ikon: 'i-thermo' },
    { k: 'sht_masuk', nama: 'SHT31 udara masuk', ket: `${fmt(t.t_masuk)} °C · ${fmt(t.rh_masuk)} %RH`, ikon: 'i-wave' },
    { k: 'co2', nama: `Sensor ${st.labelCo2}`, ket: t.co2 == null ? 'tidak ada data' : `${fmt(t.co2, 0)} ppm`, ikon: 'i-cloud' },
    { k: 'hx711', nama: 'Load cell HX711', ket: t.massa_g == null ? 'tidak ada data' : `${fmt(t.massa_g, 0)} g`, ikon: 'i-scale' },
    { k: 'kapasitif', nama: 'Sensor kapasitif', ket: `ADC mentah ${t.kap_adc ?? '—'}`, ikon: 'i-drop' },
  ];
  const baris = SENSOR.map((s) => {
    const v = st.t ? sen[s.k] || 'gangguan' : 'netral';
    return `<li><span class="ikon-sensor ${v}">${ikon(s.ikon)}</span>
      <div class="info-sensor"><b>${esc(s.nama)}</b><small>${esc(s.ket)}</small></div>
      <span class="status-sensor ${v}">${NAMA_STATUS[v] || '—'}</span></li>`;
  });
  const on = espOnline() && st.t && !basi();
  const ketEsp = st.t ? (on ? `aktif ${hms(t.up)} · RSSI ${t.rssi} dBm` : `data terakhir ${jam(st.t.diterima, true)}`) : 'belum ada data';
  baris.push(`<li><span class="ikon-sensor ${on ? 'ok' : st.t ? 'gangguan' : 'netral'}">${ikon('i-chip')}</span>
    <div class="info-sensor"><b>ESP32 ${esc(st.silo)}</b><small>${esc(ketEsp)}</small></div>
    <span class="status-sensor ${on ? 'ok' : st.t ? 'gangguan' : 'netral'}">${on ? 'ONLINE' : 'OFFLINE'}</span></li>`);
  $('#daftar-sensor').innerHTML = baris.join('');

  const pr = $('#prioritas');
  const p = t.prioritas || '—';
  pr.textContent = `Prioritas ${p}`;
  pr.className = `pil-kecil ${p === 'waspada' ? 'waspada' : p === 'tinggi' ? 'tinggi' : ''}`;
}

// ============================== TANGKI ===============================
//  Isi tangki = massa load cell / kapasitas wadah (proposal 3.1: ~11 kg gabah).
//  Kadar air menentukan efek basah pada gabah (warna gelap, kabut, embun).
const TANGKI = { lantai: 372, tinggi: 268 };       // koordinat SVG: lantai berlubang & tinggi isi penuh
const AIR = { min: 10, maks: 20, aman: 14, basah: 16 };
const persenAir = (v) => Math.max(0, Math.min(100, ((v - AIR.min) / (AIR.maks - AIR.min)) * 100));

function gambarSkala() {
  const kap = st.kapasitasG / 1000;
  const garis = [];
  for (let i = 0; i <= 20; i++) {
    const f = i / 20;
    const y = (TANGKI.lantai - f * TANGKI.tinggi).toFixed(1);
    const besar = i % 5 === 0;
    garis.push(`<line ${besar ? '' : 'class="kecil"'} x1="290" x2="${besar ? 300 : 296}" y1="${y}" y2="${y}"/>`);
    if (besar) garis.push(`<text x="305" y="${(+y + 3.5).toFixed(1)}">${fmt(kap * f, (kap * f) % 1 ? 1 : 0)} kg</text>`);
  }
  $('#skala').innerHTML = garis.join('');
  $('#v-kapasitas').textContent = fmt(kap, kap % 1 ? 1 : 0);
}

function buatEmbun() {               // titik embun di dinding (posisi tetap, dibuat sekali)
  let benih = 7;
  const acak = () => { benih = (benih * 9301 + 49297) % 233280; return benih / 233280; };
  const isi = [];
  for (let i = 0; i < 16; i++) {
    const x = acak() < 0.5 ? 79 + acak() * 9 : 272 + acak() * 9;
    const y = 104 + acak() * 250;
    const r = 1.2 + acak() * 1.6;
    isi.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${r.toFixed(1)}" ry="${(r * 1.25).toFixed(1)}"/>`);
    if (r > 2.4) isi.push(`<path class="alur-tetes" d="M${x.toFixed(1)} ${(y + r * 1.2).toFixed(1)}v${(8 + acak() * 16).toFixed(0)}"/>`);
  }
  $('#embun').innerHTML = isi.join('');
}

function buatGelembung() {           // udara aerasi naik dari lantai berlubang saat blower nyala
  const x = [96, 122, 148, 170, 192, 214, 236, 258, 110, 246];
  $('#udara').innerHTML = x.map((cx, i) => `<circle cx="${cx}" cy="368" r="${2 + (i % 3)}"/>`).join('');
}

function buatKipas() {               // kipas besar 5 bilah lengkung, berputar saat blower nyala
  const bilah = [];
  for (let i = 0; i < 5; i++) {
    bilah.push(`<path transform="rotate(${i * 72})" d="M-6 -14 C -13 -38 -19 -60 -13 -78 Q 14 -86 40 -68 C 26 -50 15 -31 7 -14 Z"/>`);
  }
  $('#kipas-besar').innerHTML = bilah.join('');
}

function kategoriAir(v) {
  if (v < 12) return ['kering', 'Kering'];
  if (v <= AIR.aman) return ['aman', 'Aman'];
  if (v <= AIR.basah) return ['lembap', 'Lembap'];
  return ['basah', 'Basah'];
}

function renderTangki() {
  const t = st.t;
  const svg = $('#tangki');
  const ada = t.massa_g != null;
  const f = ada ? Math.max(0, Math.min(1, t.massa_g / st.kapasitasG)) : 0;
  $('#gabah').style.transform = `translateY(${((1 - f) * TANGKI.tinggi).toFixed(1)}px)`;
  $('#penunjuk').style.transform = `translateY(${(TANGKI.lantai - f * TANGKI.tinggi).toFixed(1)}px)`;
  $('#udara').style.setProperty('--naik', `-${Math.max(20, f * TANGKI.tinggi - 6).toFixed(0)}px`);
  svg.classList.toggle('kosong', !ada);
  svg.classList.toggle('nyala', !!t.blower);
  // animasi naik-turun baru aktif setelah posisi pertama tergambar (tidak meluncur dari kosong saat dibuka)
  if (!svg.classList.contains('siap')) requestAnimationFrame(() => requestAnimationFrame(() => svg.classList.add('siap')));

  const persen = ada ? Math.max(0, (t.massa_g / st.kapasitasG) * 100) : null;
  $('#penunjuk-teks').textContent = ada ? `${fmt(persen, 0)}%` : '—';
  $('#v-persen').textContent = ada ? `${fmt(persen, 0)}%` : '—';
  $('.persen-isi').classList.toggle('penuh', ada && persen >= 95);

  // ---- kadar air -> efek basah pada tangki + ubin kadar air ----
  const kal = t.sensor?.kapasitif === 'ok' && t.kadar_air != null;
  const w = kal ? Math.max(0, Math.min(1, (t.kadar_air - 13) / 5)) : 0;   // 0..1: mulai di 13 %, penuh di 18 %
  const naik = (a, b) => Math.max(0, Math.min(1, (w - a) / (b - a))).toFixed(2);
  $('#gabah-basah').setAttribute('opacity', w.toFixed(2));
  $('#kabut').setAttribute('opacity', naik(0.3, 1));
  $('#embun').setAttribute('opacity', naik(0.2, 0.7));
  const lbl = $('#label-permukaan');
  lbl.textContent = kal && t.kadar_air > AIR.basah ? 'BASAH' : 'LEMBAP';
  lbl.setAttribute('opacity', kal && t.kadar_air > AIR.aman ? '1' : '0');

  const ubin = $('#kadar');
  const pil = $('#v-kadar-status');
  const penanda = $('#air-penanda');
  ubin.classList.toggle('belum', !kal);
  ubin.classList.toggle('waspada', kal && t.kadar_air > AIR.aman && t.kadar_air <= AIR.basah);
  ubin.classList.toggle('bahaya', kal && t.kadar_air > AIR.basah);
  if (!kal) {
    $('#v-kadar').textContent = t.kap_adc != null ? `ADC ${t.kap_adc}` : '—';
    $('#v-kadar-ket').textContent = t.sensor?.kapasitif === 'gangguan' ? 'Sensor gangguan' : 'Belum kalibrasi · angka mentah (Subbab 3.8)';
    pil.textContent = t.sensor?.kapasitif === 'gangguan' ? 'Gangguan' : 'Belum kalibrasi';
    pil.className = 'pil-air';
    penanda.style.display = 'none';
    return;
  }
  const v = t.kadar_air;
  const [kelas, nama] = kategoriAir(v);
  $('#v-kadar').textContent = fmt(v, 1);
  $('#v-kadar-ket').innerHTML = v <= AIR.aman ? 'Aman untuk disimpan (≤ 14 %)'
    : `${fmt(v - AIR.aman, 1)} poin di atas batas aman, perlu dikeringkan`;
  pil.textContent = nama;
  pil.className = `pil-air ${kelas}`;
  penanda.style.display = 'block';
  penanda.style.left = `${persenAir(v)}%`;
}

// grafik mini 1 jam di tiap ubin sensor
function renderSpark() {
  const titik = st.satuJam?.titik || [];
  $$('.spark').forEach((svg) => {
    const k = svg.dataset.k;
    const p = titik.filter((x) => x[k] != null);
    if (p.length < 3) { svg.innerHTML = ''; return; }
    const t0 = p[0].ts, t1 = p[p.length - 1].ts || t0 + 1;
    let mn = Math.min(...p.map((x) => x[k])), mx = Math.max(...p.map((x) => x[k]));
    const minRentang = { kadar_air: 1.5, t_dalam: 2, rh_dalam: 4, co2: 200 }[k] || 1;
    if (mx - mn < minRentang) { const c = (mx + mn) / 2; mn = c - minRentang / 2; mx = c + minRentang / 2; }
    const X = (ts) => ((ts - t0) / Math.max(1, t1 - t0)) * 200;
    const Y = (v) => 40 - ((v - mn) / (mx - mn)) * 34;
    const langkah = Math.max(1, Math.floor(p.length / 120));
    const d = p.filter((_, i) => i % langkah === 0 || i === p.length - 1)
      .map((x, i) => `${i ? 'L' : 'M'}${X(x.ts).toFixed(1)} ${Y(x[k]).toFixed(1)}`).join('');
    svg.innerHTML = `<path class="spark-isi" d="${d}L200 44L0 44Z"/><path class="spark-garis" d="${d}"/>`;
  });
}

// teks firmware memakai titik desimal & simbol ASCII; rapikan untuk dibaca
const rapikanAlasan = (teks) => String(teks ?? '')
  .replace(/(\d)\.(\d)/g, '$1,$2').replace(/(\d) ?C\b/g, '$1 °C')
  .replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/\bCO2\b/g, 'CO₂').replace(/(\d)%/g, '$1 %');

const NAMA_SENSOR = { sht_dalam: 'Sensor suhu ruang', sht_masuk: 'Sensor udara masuk', co2: 'Sensor CO₂', hx711: 'Load cell', kapasitif: 'Sensor kadar air' };

// ringkasan kondisi dalam kalimat biasa (paling penting dulu)
function renderKondisi() {
  const t = st.t;
  let tingkat = 'baik', judul = 'Kondisi aman', teks = 'Gabah aman disimpan. Semua sensor membaca normal.';
  const kal = t && t.sensor?.kapasitif === 'ok' && t.kadar_air != null;
  if (!t) { tingkat = 'netral'; judul = 'Menunggu data'; teks = 'Dashboard menunggu data pertama dari ESP32.'; }
  else if (basi() || st.esp.status === 'offline') { tingkat = 'buruk'; judul = 'Data tidak masuk'; teks = `Tidak ada data baru dari ESP32 selama ${lama(kini() - t.diterima)}. Angka di bawah adalah data terakhir.`; }
  else if (t.alarm_co2) { tingkat = 'buruk'; judul = `${st.labelCo2} sangat tinggi`; teks = `${fmt(t.co2, 0)} ppm, di atas 3000 ppm. Periksa silo secara manual.`; }
  else if (Object.values(t.sensor || {}).includes('gangguan')) {
    const rusak = Object.entries(t.sensor).filter(([, v]) => v === 'gangguan').map(([k]) => NAMA_SENSOR[k] || k);
    tingkat = 'buruk'; judul = 'Sensor bermasalah'; teks = `${rusak.join(', ')} tidak terbaca. Keputusan otomatis bisa terganggu, periksa kabel sensor.`;
  } else if (kal && t.kadar_air > AIR.aman) {
    tingkat = t.kadar_air > AIR.basah ? 'buruk' : 'waspada';
    judul = t.kadar_air > AIR.basah ? 'Gabah basah' : 'Gabah terlalu lembap';
    teks = `Kadar air ${fmt(t.kadar_air)} %, batas aman ${AIR.aman} %. ` +
      (t.blower ? 'Blower sedang menyala.' : t.butuh_aerasi && !t.udara_layak ? `${ringkasAlasan(t).replace('Ditunda: ', 'Aerasi tertunda karena ')}.` : 'Pantau kadar air dan keringkan gabah bila terus naik.');
  } else if (t.t_dalam != null && t.t_dalam >= 28) {
    tingkat = 'waspada'; judul = 'Ruang simpan panas';
    teks = `Suhu ruang ${fmt(t.t_dalam)} °C. ` + (t.blower ? 'Blower sedang mendinginkan.' : `${ringkasAlasan(t)}.`);
  } else if (t.co2 != null && t.co2 >= 1500) {
    tingkat = 'waspada'; judul = `${st.labelCo2} naik`; teks = `${fmt(t.co2, 0)} ppm. Bila bertahan 3 detik, blower menyala untuk mengganti udara.`;
  } else if (t.prioritas === 'waspada') {
    tingkat = 'waspada'; judul = 'Perlu perhatian'; teks = 'Lihat kartu Peringatan & Prioritas di bawah.';
  }
  // CLAUDE.md §6.7: alarm wajib mencolok untuk alarm_co2 dan prioritas tinggi
  if (t?.prioritas === 'tinggi' && tingkat !== 'buruk') {
    const aman = tingkat === 'baik';
    tingkat = 'buruk';
    judul = aman ? 'Prioritas pemeriksaan TINGGI' : `${judul} · prioritas TINGGI`;
    teks = `${aman ? '' : `${teks} `}ESP32 menandai penyimpangan yang bertahan setelah aerasi. Lakukan pemeriksaan manual silo.`;
  }
  if (t?.simulasi) teks += ' Sebagian nilai berasal dari SIMULASI.';
  $('#kondisi').dataset.tingkat = tingkat;
  $('#kondisi-judul').textContent = judul;
  $('#kondisi-teks').textContent = teks;
}

function renderBanner() {
  const t = st.t;
  $('#banner-sim').hidden = !t.simulasi;
  document.body.classList.toggle('mode-sim', !!t.simulasi);
  $$('.tag-sim').forEach((e) => { e.hidden = !t.simulasi; });
  const simEv = st.kejadian.find((k) => k.jenis === 'simulasi');
  $('#banner-sim-detail').textContent = t.simulasi && simEv?.data.aktif ? `(terakhir: ${simEv.teks.replace('Simulasi AKTIF: ', '')})` : '';
  $('#status-sim').textContent = t.simulasi ? 'AKTIF' : 'Nonaktif';
  $('#status-sim').className = `pil-kecil ${t.simulasi ? 'oranye-pil' : ''}`;

  // banner alarm (alarm_co2 / prioritas tinggi) = bilah kondisi merah, lihat renderKondisi()

  const demo = !!t.demo;
  $('.promo').classList.toggle('aktif', demo);
  $('#promo-judul').textContent = demo ? 'Mode Demo AKTIF' : 'Mode Demo';
  $('#btn-demo').textContent = demo ? 'Matikan Demo' : 'Aktifkan Demo';
  $('#teks-demo-2').textContent = demo ? 'DEMO OFF' : 'DEMO ON';
  $('#btn-demo-2').classList.toggle('aktif', demo);
}

function renderTelemetri() {
  renderKoneksi();
  renderSensor();
  renderKondisi();
  if (!st.t) return;
  renderStat();
  renderAerasi();
  renderTangki();
  renderBanner();
}

function tikDetik() {
  $('#jam').textContent = (() => {
    const d = new Date(kini());
    return `${HARI[d.getDay()]}, ${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()} · ${jam(d, true)}`;
  })();
  if (st.t) {
    const jalan = espOnline() && !basi();
    $('#uptime').textContent = hms(st.t.up + (jalan ? (kini() - st.t.diterima) / 1000 : 0));
    $('#info-sinkron').textContent = st.t.t > 0
      ? `Waktu ESP tersinkron${st.waktuKirim ? ` · dikirim ${jam(st.waktuKirim, true)}` : ''}`
      : 'Waktu ESP BELUM sinkron (t = 0) → pakai jam laptop';
    const usia = $('#sub-pembaruan');
    usia.textContent = `pembaruan ${lama(kini() - st.t.diterima)} lalu`;
    usia.classList.toggle('basi', basi());
  }
  renderKoneksi();
  renderKondisi();
  renderDurasiBlower();
}

// ============================== KEJADIAN =============================
const GRUP = {
  blower: ['blower'], transaksi: ['transaksi'], mode: ['mode', 'manual_timeout', 'demo', 'simulasi'],
  alarm: ['peringatan', 'alarm', 'sensor'], sistem: ['status', 'online', 'tara', 'perintah', 'batch'],
};
const KELAS_PRIORITAS = { tinggi: 'gangguan', waspada: 'pemanasan', info: 'belum_kalibrasi' };
const WARNA_PRIORITAS = { tinggi: 'merah', waspada: 'kuning', info: 'oranye' };

function gayaKejadian(k) {
  const d = k.data || {};
  switch (k.jenis) {
    case 'blower': return { ikon: 'i-fan', w: d.blower ? 'hijau' : 'abu', judul: d.blower ? 'Blower menyala' : 'Blower mati', lencana: [d.mode || '', d.blower ? 'ok' : 'netral'] };
    case 'transaksi': {
      const masuk = d.arah === 'masuk';
      return { ikon: 'i-swap', w: masuk ? 'hijau' : 'kuning', judul: `Gabah ${masuk ? 'masuk' : 'keluar'} ${Math.abs(d.delta_g)} g`, lencana: [masuk ? 'Masuk' : 'Keluar', masuk ? 'ok' : 'pemanasan'] };
    }
    case 'mode': return { ikon: 'i-sliders', w: d.mode === 'MANUAL' ? 'kuning' : 'hijau', judul: `Mode ${d.mode}`, lencana: [d.mode, d.mode === 'MANUAL' ? 'pemanasan' : 'ok'] };
    case 'manual_timeout': return { ikon: 'i-clock', w: 'kuning', judul: 'Batas waktu manual habis', lencana: ['AUTO', 'ok'] };
    case 'simulasi': return { ikon: 'i-flask', w: 'oranye', judul: d.aktif ? 'Simulasi aktif' : 'Simulasi dimatikan', lencana: [d.aktif ? 'SIM' : 'Selesai', d.aktif ? 'pemanasan' : 'netral'] };
    case 'demo': return { ikon: 'i-clock', w: 'biru', judul: d.aktif ? 'Mode demo aktif' : 'Mode demo mati', lencana: ['Demo', 'belum_kalibrasi'] };
    case 'tara': return { ikon: 'i-scale', w: 'abu', judul: 'Tara timbangan', lencana: ['Tara', 'netral'] };
    case 'online': return { ikon: 'i-wifi', w: 'hijau', judul: 'ESP32 tersambung', lencana: ['Online', 'ok'] };
    case 'status': return { ikon: 'i-power', w: d.status === 'online' ? 'hijau' : 'merah', judul: d.status === 'online' ? 'ESP32 online' : 'ESP32 offline', lencana: [d.status === 'online' ? 'Online' : 'Offline', d.status === 'online' ? 'ok' : 'gangguan'] };
    case 'alarm': return { ikon: 'i-alert', w: d.aktif ? 'merah' : 'hijau', judul: d.aktif ? 'Alarm' : 'Alarm selesai', lencana: [d.aktif ? 'Alarm' : 'Normal', d.aktif ? 'gangguan' : 'ok'] };
    case 'sensor': return { ikon: 'i-chip', w: d.ke === 'gangguan' ? 'merah' : 'hijau', judul: `Sensor ${d.sensor}`, lencana: [NAMA_STATUS[d.ke] || d.ke, d.ke] };
    case 'peringatan': return d.aktif
      ? { ikon: 'i-alert', w: WARNA_PRIORITAS[d.prioritas] || 'abu', judul: `Peringatan: ${d.judul.toLowerCase()}`, lencana: [d.prioritas, KELAS_PRIORITAS[d.prioritas] || 'netral'] }
      : { ikon: 'i-alert', w: 'hijau', judul: `Selesai: ${d.judul.toLowerCase()}`, lencana: ['Selesai', 'ok'] };
    case 'batch': return { ikon: 'i-list', w: 'hijau', judul: `Kelompok gabah ${d.kode}`, lencana: ['Batch', 'netral'] };
    case 'perintah': return { ikon: 'i-send', w: 'abu', judul: 'Perintah dari dashboard', lencana: ['Perintah', 'netral'] };
    default: return { ikon: 'i-list', w: 'abu', judul: k.jenis, lencana: ['', 'netral'] };
  }
}

function renderKejadian() {
  const daftar = st.filter === 'semua' ? st.kejadian : st.kejadian.filter((k) => GRUP[st.filter]?.includes(k.jenis));
  const el = $('#daftar-kejadian');
  if (!daftar.length) { el.innerHTML = '<li class="kosong">Belum ada kejadian.</li>'; }
  else {
    el.innerHTML = daftar.slice(0, 120).map((k) => {
      const g = gayaKejadian(k);
      const waktu = hariIni(k.ts) ? jam(k.ts, true) : `${tanggal(k.ts)} ${jam(k.ts)}`;
      return `<li><span class="ikon-kejadian ${g.w}">${ikon(g.ikon)}</span>
        <div class="isi-kejadian"><b>${esc(g.judul)}</b><small title="${esc(k.teks)}">${esc(k.teks)}</small></div>
        <div class="kanan-kejadian"><time>${waktu}</time>${g.lencana[0] ? `<span class="status-sensor ${g.lencana[1]}">${esc(g.lencana[0])}</span>` : ''}</div></li>`;
    }).join('');
  }
  const hari = st.kejadian.filter((k) => hariIni(k.ts)).length;
  $('#menu-jml-kejadian').textContent = hari > 99 ? '99+' : hari;
}

// ============================== RINGKASAN ============================
function renderPeringatan() {
  const p = st.ringkasan?.peringatan;
  if (!p) return;
  const selesaiHariIni = p.selesai.filter((x) => hariIni(x.selesai)).length;
  $('#ringkas-peringatan').textContent = `${p.aktif.length} aktif · ${selesaiHariIni} selesai hari ini · diurutkan menurut prioritas`;
  const aktif = st.tampilPeringatan === 'aktif';
  const daftar = aktif ? p.aktif : p.selesai;
  const el = $('#daftar-peringatan');
  if (!daftar.length) {
    el.innerHTML = `<li class="kosong">${aktif ? '✓ Tidak ada peringatan aktif — kondisi silo normal.' : 'Belum ada peringatan yang selesai dalam 24 jam.'}</li>`;
  } else {
    el.innerHTML = daftar.map((x) => {
      const waktu = aktif
        ? `sejak ${hariIni(x.mulai) ? '' : tanggal(x.mulai) + ' '}${jam(x.mulai)} · ${lama(kini() - x.mulai)}`
        : `${jam(x.mulai)}–${jam(x.selesai)} · ${lama(x.selesai - x.mulai)}`;
      const label = aktif ? x.prioritas : 'selesai';
      return `<li class="${aktif ? x.prioritas : 'selesai'}">
        <div class="p-isi"><b>${esc(x.judul)}</b><p>${esc(x.pemicu)}</p><small><span>Tindakan sistem:</span> ${esc(x.tindakan)}</small></div>
        <div class="p-waktu"><span class="status-sensor ${aktif ? KELAS_PRIORITAS[x.prioritas] : 'ok'}">${esc(label.toUpperCase())}</span><time>${waktu}</time></div></li>`;
    }).join('');
  }
  renderLonceng();
}

function renderLonceng() {
  const n = (st.ringkasan?.peringatan.aktif || []).filter((x) => x.prioritas !== 'info').length;
  for (const el of [$('#jml-alarm'), $('#menu-jml-peringatan')]) {
    el.hidden = n === 0;
    el.textContent = n > 9 ? '9+' : n;
  }
}

function renderAerasiHari() {
  const a = st.ringkasan?.aerasi;
  if (!a) return;
  const h = a.hariIni;
  $('#ah-siklus').textContent = h.siklus.length;
  $('#ah-menit').textContent = fmt(h.menit, 0);
  const el = $('#daftar-siklus');
  el.innerHTML = h.siklus.length
    ? [...h.siklus].reverse().map((s) => {
      const tanda = [s.mode === 'MANUAL' ? 'manual' : '', s.simulasi ? 'SIMULASI' : ''].filter(Boolean).join(' · ');
      return `<li><span class="titik ${s.selesai ? '' : 'nyala'}"></span><div>
        <b>${jam(s.mulai)} · ON ${fmt(s.menit, 0)} mnt${s.selesai ? '' : ' (berjalan)'}${tanda ? ` · ${tanda}` : ''}</b>
        <small title="${esc(s.alasan || '')}">${esc(s.alasan || 'data offline (tanpa alasan)')}</small></div></li>`;
    }).join('')
    : '<li class="kosong">Blower belum menyala hari ini.</li>';
  $('#ah-energi').innerHTML = `Perkiraan energi ≈ <b>${fmt(h.wh, 1)} Wh</b> (blower ${a.dayaW} W)` +
    ` · kemarin ${a.kemarin.jumlah} siklus, ${fmt(a.kemarin.menit, 0)} mnt`;
}

function renderStok() {
  const s = st.ringkasan?.stok;
  const tanda = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), 0)} g`;
  const status = $('#stok-status');
  if (!s) {
    $('#stok-bersih').textContent = '—';
    status.textContent = '—';
    status.className = 'pil-kecil';
    return;
  }
  $('#stok-bersih').textContent = `${s.bersih_g > 0 ? '+' : s.bersih_g < 0 ? '−' : ''}${fmt(Math.abs(s.bersih_g), 0)}`;
  $('#stok-dari').textContent = `${fmt(s.awal_g, 0)} g → ${fmt(s.kini_g, 0)} g sejak ${jam(s.sejak)}${s.setelahTara ? ' (setelah tara)' : ''}`;
  $('#stok-masuk').textContent = `${tanda(s.masuk_g)} (${s.nMasuk}×)`;
  $('#stok-keluar').textContent = `${tanda(s.keluar_g)} (${s.nKeluar}×)`;
  $('#stok-tak').textContent = tanda(s.takTercatat_g);
  $('#stok-tak').parentElement.classList.toggle('anomali', s.anomali);
  $('#stok-ket').textContent = s.cukupData
    ? `Perubahan massa tanpa transaksi ≥ ${s.ambang_g} g ditandai anomali (kebocoran, tumpahan, atau drift load cell).`
    : `Deteksi anomali aktif setelah 30 menit data (ambang ±${s.ambang_g} g).`;
  status.textContent = s.anomali ? 'ANOMALI' : 'Sesuai catatan';
  status.className = `pil-kecil ${s.anomali ? 'waspada' : ''}`;
}

function renderBatch() {
  const b = st.batch;
  const tgl = (s) => { const [y, m, d] = s.split('-').map(Number); return `${d} ${BULAN[m - 1]} ${y}`; };
  $('#sub-batch').innerHTML = b
    ? `Kelompok gabah <b>${esc(b.kode)}</b>${b.tanggal_masuk ? ` · masuk ${tgl(b.tanggal_masuk)}` : ''}${b.asal ? ` · ${esc(b.asal)}` : ''}`
    : 'Kelompok gabah belum diisi';
  $('#btn-ubah-batch').textContent = b ? 'ubah' : 'Isi kelompok';
}

function renderRingkasan() {
  renderPeringatan();
  renderAerasiHari();
  renderStok();
}

// ============================== GRAFIK ===============================
const METRIK = {
  suhu: { satuan: '°C', des: 1, minRentang: 2, seri: [{ k: 't_dalam', nama: 'Ruang simpan', warna: WARNA.g700 }, { k: 't_masuk', nama: 'Udara masuk', warna: WARNA.g300 }],
    ambang: [{ v: 28, teks: 'nyala ≥ 28 °C' }, { v: 25, teks: 'mati ≤ 25 °C' }] },
  rh: { satuan: '%', des: 1, minRentang: 4, batas: [0, 100], seri: [{ k: 'rh_dalam', nama: 'RH dalam', warna: WARNA.g700 }, { k: 'rh_masuk', nama: 'RH udara masuk', warna: WARNA.g300 }],
    ambang: [{ v: 70, teks: 'syarat masuk ≤ 70 %' }, { v: 75, teks: 'mati > 75 %' }] },
  co2: { satuan: 'ppm', des: 0, minRentang: 200, batas: [0, 10000], seri: [{ k: 'co2', nama: 'CO₂', warna: WARNA.g700 }],
    ambang: [{ v: 1500, teks: 'aerasi ≥ 1500' }, { v: 3000, teks: 'alarm > 3000', merah: true }] },
  kadar: { satuan: '%', des: 1, minRentang: 1.5, batas: [0, 40], seri: [{ k: 'kadar_air', nama: 'Kadar air gabah', warna: WARNA.g700 }],
    ambang: [{ v: 14, teks: 'batas aman 14 %' }, { v: 16, teks: 'basah > 16 %', merah: true }] },
  massa: { satuan: 'g', des: 0, minRentang: 20, batas: [0, 1e6], seri: [{ k: 'massa_g', nama: 'Massa gabah', warna: WARNA.g700 }], ambang: [] },
};

async function muatRiwayat() {
  try {
    const ambil = (r) => fetch(api(`/api/riwayat?rentang=${r}`)).then((x) => x.json());
    st.satuJam = await ambil('1h');
    st.riwayat = st.rentang === '1h' ? st.satuJam : await ambil(st.rentang);
    gambarGrafik();
    renderSpark();
    if (st.t) renderStat();
  } catch { /* server belum siap, dicoba lagi pada siklus berikutnya */ }
}

function tambahTitikLangsung(t) {
  const s = st.satuJam;
  if (!s) return;
  const p = { ts: t.ts, blower: !!t.blower, simulasi: !!t.simulasi };
  for (const k of KOLOM_ANGKA) p[k] = t[k] ?? null;
  s.titik.push(p);
  s.sampai = Math.max(s.sampai, t.ts);
  s.dari = s.sampai - 3600e3;
  while (s.titik.length && s.titik[0].ts < s.dari) s.titik.shift();
  if (st.rentang === '1h') gambarGrafik();
  renderSpark();
}

function hitungProyeksi(titik, k, dari, sampai, batas) {
  const lebar = sampai - dari;
  const jendela = Math.max(lebar * 0.25, 10 * 60e3);
  const akhir = titik.length ? titik[titik.length - 1].ts : sampai;
  const pts = titik.filter((p) => p.ts >= akhir - jendela && p[k] != null);
  if (pts.length < 8) return null;
  const t0 = pts[0].ts;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { const x = (p.ts - t0) / 60e3; sx += x; sy += p[k]; sxx += x * x; sxy += x * p[k]; }
  const n = pts.length, pb = n * sxx - sx * sx;
  if (Math.abs(pb) < 1e-9) return null;
  const b = (n * sxy - sx * sy) / pb, a = (sy - b * sx) / n;      // b = laju per menit
  const horizon = lebar * 0.25;
  const jepit = (v) => (batas ? Math.min(batas[1], Math.max(batas[0], v)) : v);
  const xa = (akhir - t0) / 60e3, xb = (akhir + horizon - t0) / 60e3;
  return { t1: akhir, v1: jepit(a + b * xa), t2: akhir + horizon, v2: jepit(a + b * xb), lajuMenit: b, horizon, jendela };
}

function skalaRapi(lo, hi, n = 5) {
  const kasar = (hi - lo) / n;
  const pangkat = 10 ** Math.floor(Math.log10(kasar));
  const langkah = [1, 2, 2.5, 5, 10].map((v) => v * pangkat).find((v) => v >= kasar);
  const a = Math.floor(lo / langkah) * langkah, b = Math.ceil(hi / langkah) * langkah;
  const ticks = [];
  for (let v = a; v <= b + langkah / 2; v += langkah) ticks.push(+v.toFixed(6));
  return { a, b, ticks };
}

function rentangBendera(titik, k, celah) {
  const hasil = [];
  let mulai = null, prev = null;
  for (const p of titik) {
    if (p[k]) {
      if (mulai !== null && prev && p.ts - prev.ts > celah) { hasil.push([mulai, prev.ts]); mulai = null; }
      if (mulai === null) mulai = p.ts;
    } else if (mulai !== null) { hasil.push([mulai, p.ts]); mulai = null; }
    prev = p;
  }
  if (mulai !== null) hasil.push([mulai, prev.ts]);
  return hasil;
}

function segmen(titik, k, celah) {
  const hasil = [];
  let kini_ = [], prev = null;
  for (const p of titik) {
    if (p[k] == null || (prev && p.ts - prev.ts > celah)) { if (kini_.length) hasil.push(kini_); kini_ = []; }
    if (p[k] != null) kini_.push(p);
    prev = p;
  }
  if (kini_.length) hasil.push(kini_);
  return hasil;
}

function gambarGrafik() {
  const wadah = $('#grafik');
  const data = st.riwayat;
  if (!data) return;
  const m = METRIK[st.metrik];
  m.seri[0].nama = st.metrik === 'co2' ? st.labelCo2 : m.seri[0].nama;
  const W = wadah.clientWidth, H = wadah.clientHeight;
  const P = { l: 48, r: 14, t: 14, b: 28 };
  const titik = data.titik;
  const utama = m.seri[0].k;
  const proy = st.proyeksi ? hitungProyeksi(titik, utama, data.dari, data.sampai, m.batas) : null;

  const ys = [];
  for (const p of titik) for (const s of m.seri) if (p[s.k] != null) ys.push(p[s.k]);
  if (!ys.length) {
    st.geo = null;
    wadah.innerHTML = '<div class="grafik-kosong">Belum ada data pada rentang ini.</div>';
    renderLegenda(m, false, null);
    return;
  }
  if (proy) ys.push(proy.v1, proy.v2);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const span0 = Math.max(hi - lo, m.minRentang);
  for (const a of m.ambang) if (a.v >= lo - span0 * 0.6 && a.v <= hi + span0 * 0.6) { lo = Math.min(lo, a.v); hi = Math.max(hi, a.v); }
  if (hi - lo < m.minRentang) { const c = (hi + lo) / 2; lo = c - m.minRentang / 2; hi = c + m.minRentang / 2; }
  const pad = (hi - lo) * 0.08;
  const sk = skalaRapi(lo - pad, hi + pad);

  const x0 = data.dari, x1 = proy ? Math.max(data.sampai, proy.t2) : data.sampai;
  const lebarPlot = W - P.l - P.r, tinggiPlot = H - P.t - P.b;
  const x = (ts) => P.l + ((ts - x0) / (x1 - x0)) * lebarPlot;
  const y = (v) => P.t + (1 - (v - sk.a) / (sk.b - sk.a)) * tinggiPlot;
  const f = (v) => v.toFixed(1);

  let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <pattern id="arsir-blower" patternUnits="userSpaceOnUse" width="9" height="9" patternTransform="rotate(45)">
        <rect width="9" height="9" fill="#f3f6f4"/><rect width="3" height="9" fill="#c3cec8"/></pattern>
      <pattern id="arsir-sim" patternUnits="userSpaceOnUse" width="9" height="9" patternTransform="rotate(-45)">
        <rect width="9" height="9" fill="#fff6ea"/><rect width="3" height="9" fill="#f7c58a"/></pattern>
      <linearGradient id="isi-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${WARNA.g500}" stop-opacity=".28"/><stop offset="1" stop-color="${WARNA.g500}" stop-opacity="0"/></linearGradient>
      <clipPath id="klip"><rect x="${P.l}" y="${P.t}" width="${lebarPlot}" height="${tinggiPlot}"/></clipPath>
    </defs>`;

  // grid & label sumbu Y
  for (const v of sk.ticks) {
    s += `<line x1="${P.l}" x2="${W - P.r}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="${WARNA.garis}"/>`;
    s += `<text class="sumbu" x="${P.l - 8}" y="${f(y(v) + 4)}" text-anchor="end">${fmt(v, sk.ticks.some((t) => t % 1) ? 1 : 0)}</text>`;
  }

  // arsir periode blower ON & simulasi
  s += '<g clip-path="url(#klip)">';
  for (const [a, b] of rentangBendera(titik, 'simulasi', data.celah_ms)) {
    s += `<rect x="${f(x(a))}" y="${P.t}" width="${f(Math.max(3, x(b) - x(a)))}" height="${tinggiPlot}" fill="url(#arsir-sim)" opacity=".9"/>`;
  }
  for (const [a, b] of rentangBendera(titik, 'blower', data.celah_ms)) {
    s += `<rect x="${f(x(a))}" y="${P.t + 2}" width="${f(Math.max(4, x(b) - x(a)))}" height="${tinggiPlot - 4}" rx="10" fill="url(#arsir-blower)"/>`;
  }

  // garis ambang
  for (const a of m.ambang) {
    if (a.v < sk.a || a.v > sk.b) continue;
    const warna = a.merah ? WARNA.merah : WARNA.tinta3;
    s += `<line x1="${P.l}" x2="${W - P.r}" y1="${f(y(a.v))}" y2="${f(y(a.v))}" stroke="${warna}" stroke-dasharray="3 4" stroke-width="1.2"/>`;
    s += `<text class="label-ambang" x="${W - P.r - 4}" y="${f(y(a.v) - 5)}" text-anchor="end" fill="${warna}">${esc(a.teks)}</text>`;
  }

  // area + garis seri
  m.seri.forEach((sr, i) => {
    for (const seg of segmen(titik, sr.k, data.celah_ms)) {
      const d = seg.map((p, j) => `${j ? 'L' : 'M'}${f(x(p.ts))},${f(y(p[sr.k]))}`).join('');
      if (i === 0 && seg.length > 1) {
        s += `<path d="${d}L${f(x(seg[seg.length - 1].ts))},${P.t + tinggiPlot}L${f(x(seg[0].ts))},${P.t + tinggiPlot}Z" fill="url(#isi-area)"/>`;
      }
      if (seg.length === 1) s += `<circle cx="${f(x(seg[0].ts))}" cy="${f(y(seg[0][sr.k]))}" r="2.5" fill="${sr.warna}"/>`;
      else s += `<path d="${d}" fill="none" stroke="${sr.warna}" stroke-width="${i === 0 ? 2.6 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  });

  // proyeksi
  if (proy) {
    s += `<line x1="${f(x(proy.t1))}" x2="${f(x(proy.t1))}" y1="${P.t}" y2="${P.t + tinggiPlot}" stroke="${WARNA.tinta3}" stroke-dasharray="2 3"/>`;
    s += `<path d="M${f(x(proy.t1))},${f(y(proy.v1))}L${f(x(proy.t2))},${f(y(proy.v2))}" stroke="${WARNA.oranye}" stroke-width="2.4" stroke-dasharray="6 5" fill="none" stroke-linecap="round"/>`;
    s += `<circle cx="${f(x(proy.t2))}" cy="${f(y(proy.v2))}" r="4" fill="#fff" stroke="${WARNA.oranye}" stroke-width="2"/>`;
    const lx = Math.min(x(proy.t2) - 4, W - P.r - 4);
    s += `<text class="label-proyeksi" x="${f(lx)}" y="${f(Math.max(P.t + 12, y(proy.v2) - 10))}" text-anchor="end">proyeksi</text>`;
  }
  s += '</g>';

  // label sumbu X (diselaraskan ke jam lokal)
  const LANGKAH = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((v) => v * 60e3);
  const maksLabel = Math.max(2, Math.floor(lebarPlot / 78));
  const langkah = LANGKAH.find((v) => (x1 - x0) / v <= maksLabel) || LANGKAH[LANGKAH.length - 1];
  const tz = new Date().getTimezoneOffset() * 60e3;
  for (let t = Math.ceil((x0 - tz) / langkah) * langkah + tz; t <= x1; t += langkah) {
    const d = new Date(t);
    const label = d.getHours() === 0 && d.getMinutes() === 0 ? tanggal(t) : jam(t);
    s += `<text class="sumbu" x="${f(x(t))}" y="${H - 8}" text-anchor="middle">${label}</text>`;
  }

  // elemen hover
  s += `<line id="hover-garis" y1="${P.t}" y2="${P.t + tinggiPlot}" stroke="${WARNA.g800}" stroke-width="1" visibility="hidden"/>`;
  m.seri.forEach((sr, i) => { s += `<circle id="hover-titik-${i}" r="4.5" fill="#fff" stroke="${sr.warna}" stroke-width="2.5" visibility="hidden"/>`; });
  s += '</svg>';
  wadah.innerHTML = s;

  st.geo = { x, y, x0, x1, P, lebarPlot, titik, m };
  renderLegenda(m, titik.some((p) => p.simulasi), proy);
}

function renderLegenda(m, adaSim, proy) {
  const isi = m.seri.map((sr) => `<span><i class="garis-l" style="background:${sr.warna}"></i>${esc(sr.nama)}</span>`);
  isi.push('<span><i class="arsir"></i>Blower ON</span>');
  if (adaSim) isi.push('<span><i class="arsir-sim"></i>Data simulasi</span>');
  if (proy) isi.push(`<span><i class="garis-putus" style="border-color:${WARNA.oranye}"></i>Proyeksi</span>`);
  $('#legenda').innerHTML = isi.join('');

  const el = $('#teks-proyeksi');
  if (!proy) {
    el.innerHTML = st.proyeksi ? 'Proyeksi muncul setelah ada cukup data (minimal 8 titik).' : '';
    return;
  }
  const lajuJam = proy.lajuMenit * 60;
  let teks = `Proyeksi ${lama(proy.horizon)} ke depan: <b>${fmt(proy.v2, m.des)} ${m.satuan}</b> ` +
    `(laju ${lajuJam >= 0 ? '+' : '−'}${fmt(Math.abs(lajuJam), m.des)} ${m.satuan}/jam).`;
  const target = { suhu: 28, co2: 3000, kadar: 14 }[st.metrik];
  if (target && proy.v1 < target && proy.lajuMenit > 0) {
    const menit = (target - proy.v1) / proy.lajuMenit;
    if (menit < 24 * 60) teks += ` Diperkirakan mencapai ${fmt(target, 0)} ${m.satuan} dalam ±${lama(menit * 60e3)}.`;
  }
  el.innerHTML = `${teks} <span>Regresi linear sederhana dari ${lama(proy.jendela)} terakhir — perkiraan tren, bukan prediksi AI.</span>`;
}

function hoverGrafik(e) {
  const g = st.geo;
  const tt = $('#tooltip');
  if (!g || !g.titik.length) return;
  const r = $('#grafik').getBoundingClientRect();
  const mx = e.clientX - r.left;
  if (mx < g.P.l || mx > g.P.l + g.lebarPlot) return sembunyikanHover();
  const ts = g.x0 + ((mx - g.P.l) / g.lebarPlot) * (g.x1 - g.x0);
  let lo = 0, hi = g.titik.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (g.titik[m].ts < ts) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(g.titik[lo - 1].ts - ts) < Math.abs(g.titik[lo].ts - ts)) lo--;
  const p = g.titik[lo];
  const px = g.x(p.ts);
  const garis = $('#hover-garis');
  garis.setAttribute('x1', px); garis.setAttribute('x2', px); garis.setAttribute('visibility', 'visible');
  const baris = [];
  g.m.seri.forEach((sr, i) => {
    const c = $(`#hover-titik-${i}`);
    if (p[sr.k] == null) { c.setAttribute('visibility', 'hidden'); return; }
    c.setAttribute('cx', px); c.setAttribute('cy', g.y(p[sr.k])); c.setAttribute('visibility', 'visible');
    baris.push(`<div><i style="background:${sr.warna}"></i>${esc(sr.nama)}: <b>${fmt(p[sr.k], g.m.des)} ${g.m.satuan}</b></div>`);
  });
  baris.push(`<div>Blower: <b>${p.blower ? 'ON' : 'OFF'}</b>${p.simulasi ? ' · <b style="color:#f7c58a">SIMULASI</b>' : ''}</div>`);
  tt.innerHTML = `<div class="tt-waktu">${hariIni(p.ts) ? '' : tanggal(p.ts) + ' '}${jam(p.ts, true)}</div>${baris.join('')}`;
  tt.hidden = false;
  const kiri = e.clientX + 16 + tt.offsetWidth > window.innerWidth ? e.clientX - tt.offsetWidth - 16 : e.clientX + 16;
  tt.style.left = `${kiri}px`;
  tt.style.top = `${e.clientY - tt.offsetHeight - 12}px`;
}

function sembunyikanHover() {
  $('#tooltip').hidden = true;
  $('#hover-garis')?.setAttribute('visibility', 'hidden');
  $$('[id^="hover-titik-"]').forEach((c) => c.setAttribute('visibility', 'hidden'));
}

function pilihMetrik(metrik) {
  st.metrik = metrik;
  $$('#tab-metrik button').forEach((b) => b.classList.toggle('aktif', b.dataset.metrik === metrik));
  gambarGrafik();
}

// ============================== SSE ==================================
function terapkanLabelCo2() {
  $$('.label-co2').forEach((e) => { e.textContent = st.labelCo2; });
  $$('.label-co2-judul').forEach((e) => { e.textContent = `${st.labelCo2} Respirasi`; });
}

function sambung() {
  if (st.es) st.es.close();             // pindah silo: tutup aliran silo sebelumnya
  const es = new EventSource(api('/api/stream'));
  st.es = es;
  es.onopen = () => { st.serverOk = true; renderKoneksi(); };
  es.onerror = () => { st.serverOk = false; renderKoneksi(); };

  es.addEventListener('awal', (e) => {
    const d = JSON.parse(e.data);
    st.serverOk = true;
    st.labelCo2 = d.konfig.labelCo2;
    if (d.konfig.kapasitasG > 0) st.kapasitasG = d.konfig.kapasitasG;
    gambarSkala();
    st.silo = d.konfig.silo;
    st.multiSilo = (d.daftarSilo || []).length > 1;
    st.selisihJam = d.waktuServer - Date.now();
    st.mqtt = d.mqtt;
    st.esp = d.esp;
    st.t = d.terakhir;
    st.waktuKirim = d.waktuTerakhirKirim;
    st.kejadian = d.kejadian.reverse();
    st.ringkasan = d.ringkasan;
    st.batch = d.batch;
    renderRingkasan();
    renderBatch();
    $('#silo-id').textContent = st.silo;
    $('#topik-cmd').textContent = `grainsense/${st.silo}/cmd`;
    $('#judul-silo').textContent = st.multiSilo ? namaSilo(st.silo) : 'Dashboard';
    document.title = `${namaSilo(st.silo)} · GrainSense${window.GS_DEMO ? ' (DEMO)' : ''}`;
    terapkanLabelCo2();
    renderKejadian();
    renderTelemetri();
    tikDetik();
    muatRiwayat();
  });
  es.addEventListener('telemetri', (e) => {
    st.t = JSON.parse(e.data);
    renderTelemetri();
    tambahTitikLangsung(st.t);
  });
  es.addEventListener('kejadian', (e) => {
    const k = JSON.parse(e.data);
    st.kejadian.unshift(k);
    if (st.kejadian.length > 500) st.kejadian.length = 500;
    if (k.jenis === 'peringatan' && k.data.aktif && k.data.prioritas !== 'info') toast(k.teks, 'buruk');
    renderKejadian();
  });
  es.addEventListener('ringkasan', (e) => { st.ringkasan = JSON.parse(e.data); renderRingkasan(); });
  es.addEventListener('batch', (e) => { st.batch = JSON.parse(e.data); renderBatch(); });
  es.addEventListener('status', (e) => { st.esp = JSON.parse(e.data); renderTelemetri(); });
  es.addEventListener('mqtt', (e) => { st.mqtt = JSON.parse(e.data).tersambung; renderKoneksi(); });
  es.addEventListener('waktu', (e) => { st.waktuKirim = JSON.parse(e.data).waktuTerakhirKirim; });
  es.addEventListener('riwayat', () => muatRiwayat());     // backlog dari ESP masuk
}

// ============================== EVENT UI =============================
function pasangUi() {
  $$('#tab-rentang button').forEach((b) => b.addEventListener('click', () => {
    st.rentang = b.dataset.rentang;
    $$('#tab-rentang button').forEach((x) => x.classList.toggle('aktif', x === b));
    $('#grafik').innerHTML = '<div class="grafik-kosong">Memuat riwayat…</div>';
    st.riwayat = null;
    muatRiwayat();
  }));
  $$('#tab-metrik button').forEach((b) => b.addEventListener('click', () => pilihMetrik(b.dataset.metrik)));
  $$('.stat').forEach((k) => k.addEventListener('click', () => {
    pilihMetrik(k.dataset.metrik);
    $('#bagian-riwayat').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  $('#cek-proyeksi').addEventListener('change', (e) => { st.proyeksi = e.target.checked; gambarGrafik(); });

  const grafik = $('#grafik');
  grafik.addEventListener('mousemove', hoverGrafik);
  grafik.addEventListener('mouseleave', sembunyikanHover);
  let antre = 0;
  new ResizeObserver(() => { cancelAnimationFrame(antre); antre = requestAnimationFrame(gambarGrafik); }).observe(grafik);

  $('#filter-kejadian').addEventListener('change', (e) => { st.filter = e.target.value; renderKejadian(); });
  $('#btn-lonceng').addEventListener('click', () => {
    st.tampilPeringatan = 'aktif';
    $$('#tab-peringatan button').forEach((x) => x.classList.toggle('aktif', x.dataset.tampil === 'aktif'));
    renderPeringatan();
    $('#bagian-peringatan').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $$('#tab-peringatan button').forEach((b) => b.addEventListener('click', () => {
    st.tampilPeringatan = b.dataset.tampil;
    $$('#tab-peringatan button').forEach((x) => x.classList.toggle('aktif', x === b));
    renderPeringatan();
  }));

  // kelompok gabah
  $('#btn-ubah-batch').addEventListener('click', () => {
    const b = st.batch || {};
    $('#b-kode').value = b.kode || '';
    const d = new Date(kini());
    $('#b-tanggal').value = b.tanggal_masuk || `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    $('#b-asal').value = b.asal || '';
    $('#b-kondisi').value = b.kondisi_awal || '';
    $('#b-catatan').value = b.catatan || '';
  });
  $('#dlg-batch').addEventListener('close', async () => {
    if ($('#dlg-batch').returnValue !== 'ok') return;
    const isi = { kode: $('#b-kode').value, tanggal_masuk: $('#b-tanggal').value, asal: $('#b-asal').value,
      kondisi_awal: $('#b-kondisi').value, catatan: $('#b-catatan').value };
    const r = await fetch(api('/api/batch'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isi) }).catch(() => null);
    const j = await r?.json().catch(() => ({}));
    if (r?.ok) toast(`Kelompok gabah ${j.kode} disimpan`);
    else toast(j?.galat || 'Gagal menyimpan kelompok gabah', 'buruk');
  });

  // menu samping: tandai aktif
  $$('.menu a[href^="#"]').forEach((a) => a.addEventListener('click', () => {
    if (a.getAttribute('href') === '#') return;
    $$('.menu a').forEach((x) => x.classList.toggle('aktif', x === a));
  }));
  $$('[data-buka]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); $(`#${el.dataset.buka}`).showModal(); }));
  $('#dlg-ekspor').addEventListener('close', () => {
    if ($('#dlg-ekspor').returnValue !== 'ok') return;
    unduh(api(`/api/ekspor.csv?jenis=${$('#ekspor-jenis').value}&rentang=${$('#ekspor-rentang').value}`));
  });
  $('#btn-csv-log').addEventListener('click', () => unduh(api('/api/ekspor.csv?jenis=kejadian&rentang=72h')));
  $('#menu-sinkron').addEventListener('click', (e) => { e.preventDefault(); sinkronWaktu(); });

  // mode presentasi: satu layar besar untuk proyektor / layar juri (1366x768)
  const aturPresentasi = (on) => {
    document.body.classList.toggle('presentasi', on);
    $('#menu-presentasi').lastChild.textContent = on ? 'Keluar Presentasi' : 'Mode Presentasi';
    $('#btn-presentasi').classList.toggle('aktif', on);
    try { localStorage.setItem('gs-presentasi', on ? '1' : '0'); } catch { /* boleh gagal */ }
    requestAnimationFrame(gambarGrafik);
  };
  let awalPresentasi = new URLSearchParams(location.search).has('presentasi');
  try { awalPresentasi = awalPresentasi || localStorage.getItem('gs-presentasi') === '1'; } catch { /* boleh gagal */ }
  aturPresentasi(awalPresentasi);
  const tukarPresentasi = (e) => { e.preventDefault(); aturPresentasi(!document.body.classList.contains('presentasi')); };
  $('#btn-presentasi').addEventListener('click', tukarPresentasi);
  $('#menu-presentasi').addEventListener('click', tukarPresentasi);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('presentasi') && !document.querySelector('dialog[open]')) aturPresentasi(false);
  });

  // strip semua silo: pindah silo tanpa memuat ulang halaman
  $('#daftar-silo').addEventListener('click', (e) => {
    const a = e.target.closest('.kartu-silo');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    if (a.dataset.silo === st.silo) return;
    SILO_PILIH = a.dataset.silo;
    try { history.replaceState(null, '', a.getAttribute('href')); } catch { /* boleh gagal */ }
    $$('.kartu-silo').forEach((k) => k.classList.toggle('aktif', k === a));
    st.satuJam = st.riwayat = null;
    sambung();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#btn-sinkron-2').addEventListener('click', sinkronWaktu);

  // kontrol
  $('[data-cmd="auto"]').addEventListener('click', AKSI.auto);
  $('#btn-auto-cepat').addEventListener('click', AKSI.auto);
  $('#btn-manual-on').addEventListener('click', AKSI.manualOn);
  $('#btn-manual-off').addEventListener('click', AKSI.manualOff);
  $('#btn-off-cepat').addEventListener('click', AKSI.manualOff);
  $('#btn-blower').addEventListener('click', () => (st.t?.blower ? AKSI.manualOff() : AKSI.manualOn()));
  $('#pilih-menit').addEventListener('change', () => st.t && renderAerasi());
  $('#btn-demo').addEventListener('click', AKSI.demo);
  $('#btn-demo-2').addEventListener('click', AKSI.demo);
  $('#btn-tara').addEventListener('click', AKSI.tara);
  $('#form-perintah').addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = $('#input-perintah').value.trim().toLowerCase();
    if (!cmd) return;
    aksi({ judul: 'Kirim perintah lanjutan?', pesan: 'Perintah dikirim apa adanya ke ESP32. Hasil kalibrasi tampil di Serial Monitor ESP.', perintah: [cmd] })
      .then(() => { $('#input-perintah').value = ''; });
  });

  // simulasi
  $('#btn-sim-kirim').addEventListener('click', () => {
    const daftar = $$('[data-sim]').filter((i) => i.value !== '').map((i) => `sim ${i.dataset.sim} ${i.value}`);
    if (!daftar.length) return toast('Isi minimal satu nilai simulasi dulu', 'buruk');
    aksi({ judul: 'Aktifkan simulasi?', pesan: 'Nilai berikut menggantikan bacaan sensor untuk logika aerasi. Data akan ditandai SIMULASI.', perintah: daftar, tombol: 'Aktifkan simulasi' });
  });
  const SKENARIO = {
    panas: { perintah: ['sim tdalam 32', 'sim tmasuk 26', 'sim rhmasuk 65'], pesan: 'Ruang 32 °C, udara masuk 26 °C & RH 65 % → blower FISIK akan menyala (mode AUTO).' },
  basah: { perintah: ['sim ka 20'], pesan: 'Kadar air 20 % → blower FISIK akan menyala dalam beberapa detik (mode AUTO), sampai simulasi dimatikan.' },
    lembap: { perintah: ['sim tdalam 32', 'sim tmasuk 27', 'sim rhmasuk 80'], pesan: 'Ruang 32 °C tetapi udara masuk RH 80 % → blower seharusnya DITUNDA / MATI.' },
    co2: { perintah: ['sim co2 3200'], pesan: `${st.labelCo2} 3200 ppm → alarm pemeriksaan manual & prioritas tinggi.` },
  };
  $$('[data-skenario]').forEach((b) => b.addEventListener('click', () => {
    const sk = SKENARIO[b.dataset.skenario];
    aksi({ judul: 'Jalankan skenario simulasi?', pesan: sk.pesan, perintah: sk.perintah, tombol: 'Jalankan' });
  }));
  const simOff = () => aksi({ judul: 'Matikan simulasi?', pesan: 'Semua nilai kembali dari sensor asli.', perintah: ['sim off'], tombol: 'Matikan simulasi' });
  $('#btn-sim-off').addEventListener('click', simOff);
  $('#btn-banner-simoff').addEventListener('click', simOff);
}

// ============================ SEMUA SILO =============================
//  Satu dashboard bisa memantau beberapa silo (SILO_ID=silo01,silo02 di server).
//  Strip ini merangkum semua silo; klik kartu untuk membuka detail silo itu.
function tingkatSilo(x) {
  const t = x.terakhir;
  const online = x.esp?.status === 'online' && t && kini() - (t.diterima || t.ts || 0) < 60e3;
  if (!online) return 'offline';
  // aturan sama dengan bilah kondisi: merah untuk alarm CO₂, prioritas tinggi, gabah basah, atau sensor rusak
  const rusak = Object.values(t.sensor || {}).includes('gangguan');
  if (t.alarm_co2 || t.prioritas === 'tinggi' || t.kadar_air > AIR.basah || rusak) return 'bahaya';
  if (x.peringatan?.waspada || t.kadar_air > AIR.aman || t.t_dalam >= 28 || t.co2 >= 1500) return 'waspada';
  return 'normal';
}

function kartuSilo(x, aktif) {
  const t = x.terakhir || {};
  const tingkat = tingkatSilo(x);
  const persen = t.massa_g != null ? Math.max(0, Math.min(100, (t.massa_g / x.kapasitasG) * 100)) : null;
  const kal = t.sensor?.kapasitif === 'ok' && t.kadar_air != null;
  const lebih = (cek) => (cek ? ' class="lebih"' : '');
  const q = new URLSearchParams(location.search);
  q.set('silo', x.silo);
  const status = { offline: 'OFFLINE', bahaya: 'ALARM', waspada: 'WASPADA', normal: 'NORMAL' }[tingkat];
  return `<a class="kartu-silo ${tingkat}${aktif ? ' aktif' : ''}" href="?${q}" data-silo="${esc(x.silo)}" ${aktif ? 'aria-current="page"' : ''}>
    <div class="ks-kepala"><b>${esc(namaSilo(x.silo))}</b><span class="ks-batch">${esc(x.batch?.kode || '—')}</span><span class="ks-status">${status}</span></div>
    <div class="ks-isi">
      <div class="ks-level" aria-hidden="true"><i style="height:${persen == null ? 0 : persen.toFixed(0)}%"></i></div>
      <dl>
        <div><dt>Berat</dt><dd><b>${t.massa_g == null ? '—' : fmt(t.massa_g / 1000, 2)}</b> kg <small>${persen == null ? '' : `${fmt(persen, 0)}%`}</small></dd></div>
        <div><dt>Kadar air</dt><dd${lebih(kal && t.kadar_air > AIR.aman)}><b>${kal ? fmt(t.kadar_air, 1) : '—'}</b> %</dd></div>
        <div><dt>Suhu</dt><dd${lebih(t.t_dalam >= 28)}><b>${fmt(t.t_dalam, 1)}</b> °C</dd></div>
        <div><dt>${esc(x.labelCo2 || 'CO₂')}</dt><dd${lebih(t.co2 >= 1500)}><b>${t.co2 == null ? '—' : fmt(t.co2, 0)}</b> ppm</dd></div>
        <div><dt>Blower</dt><dd><b class="${t.blower ? 'on' : ''}">${t.blower ? 'ON' : 'OFF'}</b></dd></div>
      </dl>
    </div>
  </a>`;
}

async function muatSemuaSilo() {
  const r = await fetch('/api/silo').then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const wadah = $('#semua-silo');
  if (!r || !Array.isArray(r.silo) || r.silo.length < 2) { wadah.hidden = true; return; }   // satu silo: strip tidak perlu
  wadah.hidden = false;
  const aktif = SILO_PILIH || st.silo || r.silo[0]?.silo;
  const jmlAlarm = r.silo.filter((x) => tingkatSilo(x) === 'bahaya').length;
  const jmlWaspada = r.silo.filter((x) => tingkatSilo(x) === 'waspada').length;
  $('#semua-silo-ket').textContent = `${r.silo.length} silo · ${jmlAlarm} alarm · ${jmlWaspada} waspada`;
  $('#daftar-silo').innerHTML = r.silo.map((x) => kartuSilo(x, x.silo === aktif)).join('');
}

// ============================== MULAI ================================
gambarSkala();
buatEmbun();
buatGelembung();
buatKipas();
pasangUi();
sambung();
tikDetik();
setInterval(tikDetik, 1000);
muatSemuaSilo();
setInterval(muatSemuaSilo, 5000);
setInterval(() => { if (st.rentang !== '1h') muatRiwayat(); else if (st.t) renderStat(); }, 60e3);
