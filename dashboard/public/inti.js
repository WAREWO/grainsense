// =====================================================================
//  GrainSense - logika inti dashboard (dipakai bersama)
// ---------------------------------------------------------------------
//  Riwayat, kejadian, peringatan, ringkasan harian, dan CSV.
//  Dipakai oleh server.js (Node, data dari MQTT sungguhan) dan oleh
//  demo.js (browser, data dari simulator) supaya perilakunya identik.
//  Penyimpanan & siaran diserahkan ke pemanggil lewat `opsi`.
// =====================================================================
(function (akar, pabrik) {
  if (typeof module === 'object' && module.exports) module.exports = pabrik();
  else akar.GrainSenseInti = pabrik();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const JAM = 3600e3;
  const RENTANG = { '1h': JAM, '24h': 24 * JAM, '72h': 72 * JAM };
  const SIMPAN_RAM_MS = 72 * JAM;
  const MAKS_KEJADIAN_RAM = 1000;
  const MAKS_TITIK_GRAFIK = 600;

  // kolom yang disimpan per baris telemetri (backlog hanya punya sebagian)
  const KOLOM = ['t_dalam', 'rh_dalam', 't_masuk', 'rh_masuk', 'co2', 'massa_g', 'kap_adc', 'kadar_air',
    'blower', 'simulasi', 'demo', 'mode', 'prioritas', 'alarm_co2', 'massa_beku', 'massa_stabil',
    'butuh_aerasi', 'udara_layak', 'rssi', 'alasan'];
  const KOLOM_ANGKA = ['t_dalam', 'rh_dalam', 't_masuk', 'rh_masuk', 'co2', 'massa_g', 'kadar_air'];
  const KOLOM_CSV = [...KOLOM, 'kelompok'];

  // Perintah yang boleh diteruskan ke ESP (sesuai firmware)
  const POLA_PERINTAH = new RegExp('^(' + [
    'auto', 'manual (on|off)( \\d{1,2})?', 'demo (on|off)',
    'sim (tdalam|rhdalam|tmasuk|rhmasuk|co2) -?\\d{1,5}(\\.\\d{1,2})?', 'sim off',
    'tara', 'status', 'scan', 'wifi',
    'kal (lihat|hx nol|hx \\d{1,5}(\\.\\d)?|kap (list|hitung|reset|\\d{1,2}(\\.\\d)?)|sht (\\d{1,3}|batal|reset)|co2 (abc|nol ya))',
  ].join('|') + ')$');

  // ============================== UTILITAS =============================
  // t dari ESP: epoch detik, 0 = belum sinkron -> pakai waktu terima (dikurangi umur bila backlog)
  function tsDari(t, umurS = 0) {
    return (typeof t === 'number' && t > 1.6e9) ? t * 1000 : Date.now() - umurS * 1000;
  }

  function waktuLokal(ms) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function lamaTeks(ms) {
    const m = Math.round(ms / 60e3);
    if (m < 60) return `${m} menit`;
    return `${Math.floor(m / 60)} jam ${m % 60} menit`;
  }

  function selCsv(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function teksKejadian(jenis, d = {}, ts = Date.now()) {
    switch (jenis) {
      case 'blower': return `Blower ${d.blower ? 'MENYALA' : 'MATI'} (${d.mode || '-'}): ${d.alasan || ''}`;
      case 'transaksi': return `Gabah ${d.arah === 'masuk' ? 'masuk' : 'keluar'} ${Math.abs(d.delta_g)} g → massa ${d.massa_g} g`;
      case 'mode': return d.mode === 'MANUAL'
        ? `Mode MANUAL: blower dipaksa ${d.blower ? 'nyala' : 'mati'} selama ${d.menit} menit`
        : 'Mode kembali AUTO';
      case 'manual_timeout': return d.pesan || 'Batas waktu mode manual habis, kembali ke AUTO';
      case 'simulasi': {
        if (!d.aktif) return 'Simulasi dimatikan, kembali ke data sensor asli';
        const isi = Object.entries(d).filter(([k]) => k !== 'aktif').map(([k, v]) => `${k} = ${v}`).join(', ');
        return `Simulasi AKTIF: ${isi}`;
      }
      case 'demo': return d.aktif ? 'Mode DEMO aktif (durasi minimum dipersingkat jadi 60 detik)' : 'Mode DEMO dimatikan';
      case 'tara': return `Tara timbangan (offset ${d.offset})`;
      case 'online': return `ESP32 tersambung ke broker (${d.buffer} data offline akan dikirim)`;
      case 'status': return d.status === 'online' ? 'ESP32 ONLINE' : 'ESP32 OFFLINE (koneksi terputus)';
      case 'peringatan': return d.aktif ? `${d.judul}: ${d.pemicu}`
        : `${d.judul} selesai (berlangsung ${lamaTeks(ts - (d.mulai || ts))})`;
      case 'batch': return `Kelompok gabah diatur: ${d.kode}${d.tanggal_masuk ? `, masuk ${d.tanggal_masuk}` : ''}${d.asal ? `, asal ${d.asal}` : ''}`;
      case 'alarm': return d.pesan || '';                           // format lama (sebelum ada peringatan)
      case 'sensor': return `Sensor ${d.sensor}: ${d.dari || '-'} → ${d.ke}`;
      case 'perintah': return `Perintah dikirim ke ESP: "${d.cmd}"`;
      default: return JSON.stringify(d);
    }
  }

  const denganTeks = (k) => ({ ...k, teks: teksKejadian(k.jenis, k.data, k.ts) });

  // CSV dari baris tersimpan (sudah urut waktu)
  function buatCsv(jenis, data) {
    const tele = jenis !== 'kejadian';
    const kepala = tele ? ['waktu', 'epoch_s', 'sumber', ...KOLOM_CSV] : ['waktu', 'epoch_s', 'jenis', 'sumber', 'keterangan', 'data_json'];
    const baris = ['﻿' + kepala.join(',')];
    for (const r of data) {
      const isi = tele
        ? [waktuLokal(r.ts), Math.round(r.ts / 1000), r.sumber, ...KOLOM_CSV.map((k) => r[k])]
        : [waktuLokal(r.ts), Math.round(r.ts / 1000), r.jenis, r.sumber, teksKejadian(r.jenis, r.data, r.ts), JSON.stringify(r.data)];
      baris.push(isi.map(selCsv).join(','));
    }
    return baris.join('\r\n') + '\r\n';
  }

  // =====================================================================
  //  buatInti(opsi)
  //   opsi.silo, opsi.labelCo2, opsi.dayaW, opsi.anomaliG
  //   opsi.simpanBaris(baris)   opsi.simpanKejadian(k)   opsi.simpanBatch(b)
  //   opsi.siarkan(nama, data)  opsi.kirimWaktu() -> bool
  // =====================================================================
  function buatInti(opsi) {
    const SILO_ID = opsi.silo || 'silo01';
    const LABEL_CO2 = opsi.labelCo2 || 'CO₂';
    const DAYA_BLOWER_W = opsi.dayaW || 32;
    const ANOMALI_G = opsi.anomaliG || 15;
    const BASIS = `grainsense/${SILO_ID}`;
    const TOPIK = {
      tele: `${BASIS}/telemetry`, event: `${BASIS}/event`, backlog: `${BASIS}/backlog`,
      status: `${BASIS}/status`, cmd: `${BASIS}/cmd`, waktu: 'grainsense/time',
    };
    const kosong = () => {};
    const simpanBaris = opsi.simpanBaris || kosong;
    const simpanKejadian = opsi.simpanKejadian || kosong;
    const siarkan = opsi.siarkan || kosong;
    const kirimWaktu = opsi.kirimWaktu || (() => false);

    // ---- keadaan ----
    let riwayat = [];          // baris telemetri 72 jam terakhir, urut ts
    let kejadian = [];         // kejadian terbaru (maks MAKS_KEJADIAN_RAM)
    let terakhir = null;       // telemetri terakhir + waktu terima
    let statusEsp = 'tidak diketahui';
    let statusSejak = Date.now();
    let batch = null;                  // identitas kelompok gabah yang sedang disimpan
    const peringatanAktif = new Map(); // kunci -> peringatan yang sedang berlangsung
    let peringatanSelesai = [];

    let jedaRiwayat = null;
    function siarkanRiwayatBerubah() {        // backlog datang berombongan -> cukup 1 sinyal
      clearTimeout(jedaRiwayat);
      jedaRiwayat = setTimeout(() => siarkan('riwayat', { ts: Date.now() }), 1500);
    }

    const infoStatus = () => ({ status: statusEsp, sejak: statusSejak });

    // ---- penyimpanan ----
    function tambahRiwayat(baris) {
      const n = riwayat.length;
      if (!n || riwayat[n - 1].ts <= baris.ts) riwayat.push(baris);
      else {                                  // backlog: sisipkan sesuai urutan waktu
        let i = n;
        while (i > 0 && riwayat[i - 1].ts > baris.ts) i--;
        riwayat.splice(i, 0, baris);
      }
      simpanBaris(baris);
    }

    function tambahKejadian(k) {
      kejadian.push(k);
      if (kejadian.length > MAKS_KEJADIAN_RAM) kejadian = kejadian.slice(-MAKS_KEJADIAN_RAM);
      simpanKejadian(k);
      siarkan('kejadian', denganTeks(k));
    }

    function pangkasRam() {
      const batas = Date.now() - SIMPAN_RAM_MS;
      const i = riwayat.findIndex((r) => r.ts >= batas);
      riwayat = i < 0 ? [] : riwayat.slice(i);
    }

    // ---- riwayat grafik ----
    function indeksDari(ts) {                 // indeks baris pertama dengan waktu >= ts
      let lo = 0, hi = riwayat.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (riwayat[m].ts < ts) lo = m + 1; else hi = m; }
      return lo;
    }

    function ringkasBaris(r) {
      const o = { ts: r.ts, blower: !!r.blower, simulasi: !!r.simulasi };
      for (const k of KOLOM_ANGKA) o[k] = typeof r[k] === 'number' ? r[k] : null;
      return o;
    }

    // Ambil riwayat sesuai rentang; bila titik terlalu banyak, rata-rata per ember waktu
    function ambilRiwayat(rentang) {
      const lebarRentang = RENTANG[rentang] || RENTANG['1h'];
      const sampai = Date.now(), dari = sampai - lebarRentang;
      const data = riwayat.slice(indeksDari(dari));

      if (data.length <= MAKS_TITIK_GRAFIK) {
        return { rentang, dari, sampai, celah_ms: 90e3, titik: data.map(ringkasBaris) };
      }
      const lebar = lebarRentang / MAKS_TITIK_GRAFIK;
      const ember = new Map();
      for (const r of data) {
        const k = Math.floor((r.ts - dari) / lebar);
        let e = ember.get(k);
        if (!e) { e = { n: 0, ts: 0, blower: false, simulasi: false, jum: {}, hit: {} }; ember.set(k, e); }
        e.n++; e.ts += r.ts;
        if (r.blower) e.blower = true;       // ember ditandai blower ON bila ada satu saja titik ON
        if (r.simulasi) e.simulasi = true;
        for (const c of KOLOM_ANGKA) {
          if (typeof r[c] === 'number') { e.jum[c] = (e.jum[c] || 0) + r[c]; e.hit[c] = (e.hit[c] || 0) + 1; }
        }
      }
      const titik = [...ember.values()].map((e) => {
        const o = { ts: Math.round(e.ts / e.n), blower: e.blower, simulasi: e.simulasi };
        for (const c of KOLOM_ANGKA) o[c] = e.hit[c] ? +(e.jum[c] / e.hit[c]).toFixed(2) : null;
        return o;
      });
      return { rentang, dari, sampai, celah_ms: Math.max(90e3, lebar * 3), titik };
    }

    // ---- ringkasan harian ----
    function awalHari(ms = Date.now()) {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }

    // Siklus blower ON di antara dua waktu, dihitung dari riwayat telemetri
    // (termasuk backlog), sehingga jam operasi tetap benar walau sempat offline.
    function siklusBlower(dari, sampai) {
      const hasil = [];
      let buka = null, prev = null, terpotong = false;
      for (let i = indeksDari(dari - 90e3); i < riwayat.length; i++) {
        const r = riwayat[i];
        if (r.ts > sampai) { terpotong = true; break; }
        if (buka && prev && r.ts - prev.ts > 90e3) { buka.selesai = prev.ts; hasil.push(buka); buka = null; }
        if (buka && !r.blower) { buka.selesai = r.ts; hasil.push(buka); buka = null; }
        if (!buka && r.blower) buka = { mulai: r.ts, selesai: null, mode: r.mode || null, alasan: r.alasan || null, simulasi: !!r.simulasi };
        prev = r;
      }
      if (buka) {
        if (terpotong) buka.selesai = sampai;
        else if (Date.now() - prev.ts > 30e3) buka.selesai = prev.ts;   // data berhenti (ESP terputus)
        hasil.push(buka);
      }
      return hasil
        .map((s) => ({ ...s, mulai: Math.max(s.mulai, dari) }))
        .filter((s) => (s.selesai ?? Date.now()) > s.mulai)
        .map((s) => ({ ...s, menit: +(((s.selesai ?? Date.now()) - s.mulai) / 60e3).toFixed(1) }));
    }

    function ringkasanAerasi() {
      const h0 = awalHari(), k0 = awalHari(h0 - 1);
      const hari = siklusBlower(h0, Date.now()), kemarin = siklusBlower(k0, h0);
      const total = (a) => +a.reduce((s, x) => s + x.menit, 0).toFixed(1);
      return {
        dayaW: DAYA_BLOWER_W,
        hariIni: { siklus: hari, menit: total(hari), wh: +((total(hari) / 60) * DAYA_BLOWER_W).toFixed(1) },
        kemarin: { jumlah: kemarin.length, menit: total(kemarin) },
      };
    }

    // Perubahan stok sejak awal hari (atau sejak tara terakhir) dibandingkan
    // jumlah transaksi tercatat. Selisih yang tidak dijelaskan transaksi = anomali
    // (kebocoran, tumpahan, atau drift load cell).
    function ringkasanStok() {
      const h0 = awalHari();
      let tara = null;
      for (const k of kejadian) if (k.jenis === 'tara' && k.ts >= h0) tara = k;
      const sejak = tara ? tara.ts : h0;
      const stabil = (r) => typeof r.massa_g === 'number' && !r.massa_beku && r.massa_stabil !== false;
      let awal = null, kini = null;
      for (let i = indeksDari(sejak); i < riwayat.length; i++) {
        const r = riwayat[i];
        if (!stabil(r)) continue;
        if (!awal) awal = r;
        kini = r;
      }
      if (!awal) return null;
      let masuk = 0, keluar = 0, nMasuk = 0, nKeluar = 0;
      for (const k of kejadian) {
        if (k.jenis !== 'transaksi' || k.ts < awal.ts || k.ts > kini.ts + 10e3) continue;
        const d = Number(k.data && k.data.delta_g) || 0;
        if (d > 0) { masuk += d; nMasuk++; } else { keluar += d; nKeluar++; }
      }
      const bersih = kini.massa_g - awal.massa_g;
      const takTercatat = Math.round(bersih - (masuk + keluar));
      const cukupData = kini.ts - awal.ts >= 30 * 60e3;
      return {
        sejak: awal.ts, setelahTara: !!tara, awal_g: awal.massa_g, kini_g: kini.massa_g, bersih_g: bersih,
        masuk_g: masuk, keluar_g: keluar, nMasuk, nKeluar, takTercatat_g: takTercatat, ambang_g: ANOMALI_G,
        cukupData, anomali: cukupData && Math.abs(takTercatat) >= ANOMALI_G,
      };
    }

    // ---- peringatan ----
    // Tabel 3.4 proposal: tiap kondisi menyimpan pemicu, tindakan sistem, waktu mulai & selesai.
    const URUT_PRIORITAS = { tinggi: 0, waspada: 1, info: 2 };
    const SENSOR_PERINGATAN = {
      sht_dalam: ['SHT31 RUANG SIMPAN', 'Keputusan otomatis dihentikan, blower dimatikan; lakukan pemeriksaan manual'],
      sht_masuk: ['SHT31 UDARA MASUK', 'Keputusan otomatis dihentikan, blower dimatikan; lakukan pemeriksaan manual'],
      co2: [`SENSOR ${LABEL_CO2}`, 'Kebutuhan aerasi dari CO₂ diabaikan; keputusan memakai suhu ruang saja'],
      hx711: ['LOAD CELL HX711', 'Pencatatan stok dan transaksi berhenti sementara'],
      kapasitif: ['SENSOR KAPASITIF', 'Kadar air tidak ditampilkan sampai sensor normal'],
    };
    const f1 = (v) => (typeof v === 'number' ? v.toFixed(1).replace('.', ',') : '–');

    function kondisiPeringatan(now) {
      const hasil = [];
      const t = terakhir;
      const usang = !t || now - t.diterima > 30e3;
      if (statusEsp === 'offline' || (t && usang)) {
        hasil.push({ kunci: 'esp_terputus', prioritas: 'waspada', judul: 'ESP32 TERPUTUS',
          pemicu: t ? `Tidak ada data dari ESP32 sejak ${waktuLokal(t.diterima).slice(11, 16)}` : 'ESP32 mengirim status offline',
          tindakan: 'Kendali aerasi tetap berjalan lokal di ESP32; data disimpan di buffer (maks 3 jam) lalu dikirim saat tersambung' });
      }
      if (usang) return { hasil, usang };

      const sensor = t.sensor || {};
      const dihentikan = (t.alasan || '').startsWith('Keputusan otomatis dihentikan');
      if (t.alarm_co2) {
        hasil.push({ kunci: 'co2_alarm', prioritas: 'tinggi', judul: `${LABEL_CO2} MELEWATI AMBANG ALARM`,
          pemicu: `${t.co2} ppm > 3.000 ppm${t.simulasi ? ' (SIMULASI)' : ''}`,
          tindakan: 'Prioritas pemeriksaan dinaikkan; periksa silo secara manual (indikasi aktivitas jamur)' });
      } else if (t.co2 >= 1500 && sensor.co2 === 'ok') {
        hasil.push({ kunci: 'co2_tinggi', prioritas: 'waspada', judul: `${LABEL_CO2} DI ATAS AMBANG AERASI`,
          pemicu: `${t.co2} ppm ≥ 1.500 ppm${t.simulasi ? ' (SIMULASI)' : ''}`,
          tindakan: 'Dipantau; blower menyala bila bertahan 30 menit dan udara masuk layak' });
      }
      if (dihentikan) {
        hasil.push({ kunci: 'kendali_dihentikan', prioritas: 'tinggi', judul: 'KENDALI OTOMATIS DIHENTIKAN',
          pemicu: t.alasan, tindakan: 'Blower dimatikan; prosedur cadangan: pemeriksaan manual' });
      } else if (t.prioritas === 'tinggi' && !t.alarm_co2) {
        hasil.push({ kunci: 'penyimpangan_bertahan', prioritas: 'tinggi', judul: 'PENYIMPANGAN BERTAHAN SETELAH AERASI',
          pemicu: t.alasan, tindakan: 'Prioritas pemeriksaan silo dinaikkan' });
      }
      if (t.butuh_aerasi && !t.udara_layak && !t.blower && t.mode === 'AUTO' && !dihentikan) {
        const syarat = [];
        if (t.rh_masuk > 70) syarat.push(`RH masuk ${f1(t.rh_masuk)} % > 70 %`);
        if (t.t_dalam - t.t_masuk < 3) syarat.push(`udara masuk hanya ${f1(t.t_dalam - t.t_masuk)} °C lebih dingin (syarat ≥ 3 °C)`);
        hasil.push({ kunci: 'aerasi_tertunda', prioritas: 'waspada', judul: 'AERASI TERTUNDA',
          pemicu: `Aerasi diperlukan, tetapi ${syarat.join(' dan ') || 'udara masuk tidak layak'}`,
          tindakan: 'Blower ditahan agar gabah tidak menyerap uap air; menunggu udara masuk layak' });
      }
      for (const [k, [nama, tindakan]] of Object.entries(SENSOR_PERINGATAN)) {
        if (sensor[k] !== 'gangguan') continue;
        hasil.push({ kunci: `sensor_${k}`, prioritas: k.startsWith('sht') ? 'tinggi' : 'waspada',
          judul: `GANGGUAN ${nama}`, pemicu: 'Pembacaan tidak valid atau sensor terputus', tindakan });
      }
      const stok = ringkasanStok();
      if (stok && stok.anomali) {
        hasil.push({ kunci: 'anomali_stok', prioritas: 'waspada', judul: 'ANOMALI STOK',
          pemicu: `Massa berubah ${stok.takTercatat_g > 0 ? '+' : ''}${stok.takTercatat_g} g tanpa catatan transaksi sejak ${waktuLokal(stok.sejak).slice(11, 16)}`,
          tindakan: 'Periksa kebocoran/tumpahan wadah atau drift load cell; lakukan tara bila perlu' });
      }
      if (t.simulasi) {
        hasil.push({ kunci: 'simulasi', prioritas: 'info', judul: 'MODE SIMULASI AKTIF',
          pemicu: 'Sebagian nilai berasal dari perintah sim, bukan sensor',
          tindakan: 'Data ditandai SIMULASI di dashboard dan file CSV' });
      }
      return { hasil, usang };
    }

    function catatPeringatan(p, aktif) {
      tambahKejadian({ ts: aktif ? p.mulai : p.selesai, jenis: 'peringatan', sumber: 'server',
        data: { kunci: p.kunci, aktif, prioritas: p.prioritas, judul: p.judul, pemicu: p.pemicu, tindakan: p.tindakan, mulai: p.mulai } });
    }

    function evaluasiPeringatan() {
      if (!terakhir && statusEsp === 'tidak diketahui') return;     // belum tahu apa-apa (baru start)
      const now = Date.now();
      const { hasil, usang } = kondisiPeringatan(now);
      const ada = new Set();
      let berubah = false;
      for (const p of hasil) {
        ada.add(p.kunci);
        const lama = peringatanAktif.get(p.kunci);
        if (lama) { lama.pemicu = p.pemicu; lama.hilangSejak = 0; continue; }
        const baru = { ...p, mulai: now, hilangSejak: 0 };
        peringatanAktif.set(p.kunci, baru);
        catatPeringatan(baru, true);
        berubah = true;
      }
      for (const [kunci, p] of peringatanAktif) {
        if (ada.has(kunci)) continue;
        if (usang && kunci !== 'esp_terputus') continue;   // tanpa data baru, kondisi lama belum bisa dinyatakan selesai
        if (!p.hilangSejak) p.hilangSejak = now;
        if (kunci !== 'esp_terputus' && now - p.hilangSejak < 30e3) continue;   // cegah kedip di sekitar ambang
        peringatanAktif.delete(kunci);
        const { hilangSejak, ...isi } = p;
        const selesai = { ...isi, selesai: now };
        peringatanSelesai.push(selesai);
        if (peringatanSelesai.length > 300) peringatanSelesai = peringatanSelesai.slice(-300);
        catatPeringatan(selesai, false);
        berubah = true;
      }
      if (berubah) siarkan('ringkasan', ringkasan());
    }

    function ringkasan() {
      const aktif = [...peringatanAktif.values()]
        .map(({ hilangSejak, ...p }) => p)
        .sort((a, b) => URUT_PRIORITAS[a.prioritas] - URUT_PRIORITAS[b.prioritas] || b.mulai - a.mulai);
      const batasSelesai = Date.now() - 24 * JAM;
      const selesai = peringatanSelesai.filter((p) => p.selesai >= batasSelesai).slice(-30).reverse();
      return { dibuat: Date.now(), aerasi: ringkasanAerasi(), stok: ringkasanStok(), peringatan: { aktif, selesai } };
    }

    function pulihkanPeringatan() {          // dari log kejadian setelah server dinyalakan ulang
      for (const k of kejadian) {
        if (k.jenis !== 'peringatan') continue;
        const d = k.data;
        const isi = { kunci: d.kunci, prioritas: d.prioritas, judul: d.judul, pemicu: d.pemicu, tindakan: d.tindakan, mulai: d.mulai ?? k.ts };
        if (d.aktif) peringatanAktif.set(d.kunci, { ...isi, hilangSejak: 0 });
        else { peringatanAktif.delete(d.kunci); peringatanSelesai.push({ ...isi, selesai: k.ts }); }
      }
    }

    // ---- kelompok gabah ----
    function aturBatch(isi) {
      const teks = (v, n) => String(v ?? '').trim().slice(0, n);
      const b = {
        kode: teks(isi.kode, 30), tanggal_masuk: /^\d{4}-\d{2}-\d{2}$/.test(isi.tanggal_masuk || '') ? isi.tanggal_masuk : '',
        asal: teks(isi.asal, 60), kondisi_awal: teks(isi.kondisi_awal, 80), catatan: teks(isi.catatan, 120),
      };
      if (!b.kode) throw new Error('Kode kelompok wajib diisi');
      batch = b;
      if (opsi.simpanBatch) opsi.simpanBatch(b);
      tambahKejadian({ ts: Date.now(), jenis: 'batch', sumber: 'server', data: b });
      siarkan('batch', b);
      return b;
    }

    // ---- pesan MQTT ----
    function ubahStatus(st) {
      if (st === statusEsp) return;
      statusEsp = st;
      statusSejak = Date.now();
      tambahKejadian({ ts: Date.now(), jenis: 'status', sumber: 'server', data: { status: st } });
      siarkan('status', infoStatus());
      if (st === 'online') kirimWaktu();
      evaluasiPeringatan();
    }

    function terimaTelemetri(d) {
      const ts = tsDari(d.t);
      const baris = { ts, sumber: 'live' };
      for (const k of KOLOM) if (k in d) baris[k] = d[k];
      if (batch) baris.kelompok = batch.kode;
      tambahRiwayat(baris);
      terakhir = { ...d, ts, diterima: Date.now() };
      if (statusEsp !== 'online') ubahStatus('online');   // ada data = pasti online
      siarkan('telemetri', terakhir);
      evaluasiPeringatan();
    }

    // tambah telemetri ke riwayat tanpa siaran/peringatan (mengisi riwayat contoh di demo)
    function isiRiwayat(d) {
      const baris = { ts: tsDari(d.t), sumber: 'live' };
      for (const k of KOLOM) if (k in d) baris[k] = d[k];
      if (batch) baris.kelompok = batch.kode;
      tambahRiwayat(baris);
    }

    function terimaBacklog(d) {
      const baris = { ts: tsDari(d.t, d.umur_s || 0), sumber: 'backlog' };
      for (const k of KOLOM) if (k in d) baris[k] = d[k];
      tambahRiwayat(baris);
      siarkanRiwayatBerubah();
    }

    function terimaEvent(e) {
      tambahKejadian({ ts: tsDari(e.t), jenis: e.jenis || 'lain', sumber: 'esp', data: e.data || {} });
    }

    // dipanggil untuk setiap pesan MQTT yang masuk (topik, isi teks)
    function terimaPesan(topik, isi) {
      if (topik === TOPIK.status) ubahStatus(isi === 'online' ? 'online' : 'offline');
      else if (topik === TOPIK.tele) terimaTelemetri(JSON.parse(isi));
      else if (topik === TOPIK.backlog) terimaBacklog(JSON.parse(isi));
      else if (topik === TOPIK.event) terimaEvent(JSON.parse(isi));
    }

    // Normalisasi + validasi perintah dari browser. Mengembalikan teks perintah atau melempar galat.
    function catatPerintah(cmd) {
      const teks = String(cmd || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!POLA_PERINTAH.test(teks)) throw new Error(`Perintah tidak dikenal: "${teks}"`);
      tambahKejadian({ ts: Date.now(), jenis: 'perintah', sumber: 'server', data: { cmd: teks } });
      return teks;
    }

    function keadaanAwal(tambahan = {}) {
      return {
        konfig: { silo: SILO_ID, labelCo2: LABEL_CO2 },
        waktuServer: Date.now(),
        esp: infoStatus(),
        terakhir,
        kejadian: kejadian.slice(-150).map(denganTeks),
        ringkasan: ringkasan(),
        batch,
        ...tambahan,
      };
    }

    // isi awal dari penyimpanan (server) atau data yang dibangkitkan (demo)
    function muat(data) {
      riwayat = (data.riwayat || []).slice().sort((a, b) => a.ts - b.ts);
      kejadian = (data.kejadian || []).slice(-MAKS_KEJADIAN_RAM);
      batch = data.batch || null;
      pulihkanPeringatan();
    }

    return {
      TOPIK, terimaPesan, terimaTelemetri, terimaBacklog, terimaEvent, ubahStatus, isiRiwayat,
      tambahRiwayat, tambahKejadian, catatPerintah, aturBatch, ambilRiwayat, ringkasan,
      evaluasiPeringatan, keadaanAwal, muat, pangkasRam,
      riwayatSejak: (ts) => riwayat.slice(indeksDari(ts)),
      kejadianSejak: (ts) => kejadian.filter((k) => k.ts >= ts),
    };
  }

  return {
    buatInti, buatCsv, teksKejadian, waktuLokal, tsDari,
    KOLOM, KOLOM_ANGKA, KOLOM_CSV, POLA_PERINTAH, RENTANG, SIMPAN_RAM_MS, MAKS_KEJADIAN_RAM,
  };
}));
