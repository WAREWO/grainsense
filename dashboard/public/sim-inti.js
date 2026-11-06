// =====================================================================
//  GrainSense - inti SIMULATOR ESP32 (dipakai bersama)
// ---------------------------------------------------------------------
//  Fisika sederhana + logika aerasi Tabel 3.5 yang sama dengan
//  evaluasiAerasi() di firmware, dengan format JSON persis firmware.
//  Dipakai oleh simulator.js (Node + MQTT) dan demo.js (browser).
//
//  buatSimulator({ silo, kirim(topik, teks, opsiPublish), log(teks),
//                  jam: () => ms, demo, gangguan, bocor })
// =====================================================================
(function (akar, pabrik) {
  if (typeof module === 'object' && module.exports) module.exports = pabrik();
  else akar.GrainSenseSim = pabrik();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- ambang Tabel 3.5 (sama dengan struct Ambang di firmware) ----
  const amb = { tNyala: 28, tMati: 25, co2Nyala: 1500, co2Lepas: 1200, co2Alarm: 3000,
    rhMasukMaks: 70, rhMasukMati: 75, dtMin: 3, dtLepas: 0,
    kaNyala: 18, kaLepas: 16, rhMasukBasah: 85 };
  const DEMO_DURASI_S = 3, DUR_KA_BERTAHAN_S = 3;
  const DUR_PENYIMPANGAN_S = 60 * 60;
  const MANUAL_DEFAULT_DETIK = 5, MANUAL_MAKS_MENIT = 30;
  const PEMANASAN_CO2_MS = 180e3, BEKU_SETELAH_MS = 15e3, TRANSAKSI_G = 20;

  function buatSimulator(opsi) {
    const SILO_ID = opsi.silo || 'silo01';
    const BASIS = `grainsense/${SILO_ID}`;
    const TOPIK = {
      tele: `${BASIS}/telemetry`, event: `${BASIS}/event`, backlog: `${BASIS}/backlog`,
      status: `${BASIS}/status`, cmd: `${BASIS}/cmd`, waktu: 'grainsense/time',
    };
    const jam = opsi.jam || (() => Date.now());
    const kirim = opsi.kirim || (() => {});
    const log = opsi.log || (() => {});

    let DUR_MIN_NYALA_S = 3, DUR_MIN_MATI_S = 3, DUR_CO2_BERTAHAN_S = 3;

    // ---- keadaan ----
    const tBoot = jam();
    const millis = () => jam() - tBoot;
    let epochOffset = null;                         // null = belum sinkron (t = 0)
    const epochSekarang = () => (epochOffset === null ? 0 : Math.floor(millis() / 1000 + epochOffset));

    const fisik = {                                 // kondisi "nyata" di dalam silo
      tDalam: 29.8, rhDalam: 69, co2: 950, massaKotor: 6400, adc: 3108, kadar: 15.8,
      ...(opsi.awal || {}),                          // kondisi awal lain (demo beberapa silo)
    };
    const d = {                                     // hasil "pembacaan sensor"
      tDalam: null, rhDalam: null, tMasuk: null, rhMasuk: null, co2: null,
      massa: null, massaBeku: false, massaStabil: false, kapAdc: 3108, kadarAir: null,
      sDalam: 'ok', sMasuk: 'ok', sCo2: 'pemanasan', sHx: 'ok', sKap: 'ok',
    };
    let sim = { aktif: false, tDalam: null, rhDalam: null, tMasuk: null, rhMasuk: null, co2: null, ka: null };

    let mode = 'AUTO', manualNyala = false, manualSampaiMs = 0, modeDemo = false;
    let blowerNyala = false, msBlowerNyala = 0, msBlowerMati = 0, msCo2MulaiTinggi = 0;
    let butuhAerasi = false, udaraLayak = false, perluSetelahAerasi = false;
    let modeLembap = false, msKaMulaiTinggi = 0, msKaTurun = 0;
    let alasan = 'Menunggu data sensor', prioritas = 'normal';
    let taraOffset = 0, massaTercatat = null, jendela = [];
    let transaksi = null;                            // {sisa, laju} saat gabah sedang dituang/diambil
    let gangguanSampai = 0;

    const acak = (a, b) => a + Math.random() * (b - a);
    const f1 = (v) => v.toFixed(1);
    const angka = (v, des) => (v === null || Number.isNaN(v) ? null : Number(v.toFixed(des)));

    // ---- nilai yang dipakai logika (asli atau simulasi), sama seperti nTDalam() dst ----
    const nTDalam = () => (sim.aktif && sim.tDalam !== null ? sim.tDalam : d.tDalam);
    const nRhDalam = () => (sim.aktif && sim.rhDalam !== null ? sim.rhDalam : d.rhDalam);
    const nTMasuk = () => (sim.aktif && sim.tMasuk !== null ? sim.tMasuk : d.tMasuk);
    const nRhMasuk = () => (sim.aktif && sim.rhMasuk !== null ? sim.rhMasuk : d.rhMasuk);
    const nCo2 = () => (sim.aktif && sim.co2 !== null ? sim.co2 : d.co2);
    const nKa = () => (sim.aktif && sim.ka !== null ? sim.ka : d.kadarAir);
    const okDalam = () => (sim.aktif && sim.tDalam !== null) || d.sDalam === 'ok';
    const okMasuk = () => (sim.aktif && sim.tMasuk !== null && sim.rhMasuk !== null) || d.sMasuk === 'ok';
    const okCo2 = () => (sim.aktif && sim.co2 !== null) || d.sCo2 === 'ok';

    function aturDemo(nyala) {
      modeDemo = nyala;
      DUR_MIN_NYALA_S = DUR_MIN_MATI_S = DUR_CO2_BERTAHAN_S = nyala ? DEMO_DURASI_S : 3;
    }

    // ========================= FISIKA SEDERHANA ======================
    // Udara luar berayun (periode 20 menit, dipercepat agar demo menarik):
    // saat sejuk & kering -> layak untuk aerasi; saat lembap -> tidak layak.
    function udaraLuar() {
      const fase = (jam() / 1000) * (2 * Math.PI / 1200);
      return {
        t: 28.2 + 3.6 * Math.sin(fase) + acak(-0.15, 0.15),
        rh: 70.5 + 7.5 * Math.sin(fase + 0.9) + acak(-0.4, 0.4),
      };
    }

    function langkah(dt) {
      const luar = udaraLuar();
      if (blowerNyala) {
        fisik.tDalam += (luar.t - fisik.tDalam) * 0.006 * dt;
        fisik.rhDalam += (luar.rh - fisik.rhDalam) * 0.004 * dt;
        fisik.co2 += (600 - fisik.co2) * 0.008 * dt;
      } else {
        fisik.tDalam += (33.6 - fisik.tDalam) * 0.0009 * dt;   // panas respirasi gabah
        fisik.rhDalam += (72 - fisik.rhDalam) * 0.001 * dt;
        const targetCo2 = 2500 + 900 * Math.sin(jam() / 1000 / 2400);
        fisik.co2 += (targetCo2 - fisik.co2) * 0.0012 * dt;
      }
      fisik.co2 += acak(-6, 6);

      if (!transaksi && Math.random() < dt / 300) {            // rata-rata tiap ~5 menit
        // gabah diambil/ditambah 120-450 g; makin penuh wadah (maks ~11 kg) makin sering diambil
        const pKeluar = 0.25 + 0.5 * Math.min(1, Math.max(0, (fisik.massaKotor - 3000) / 6000));
        const delta = Math.round(acak(120, 450)) * (Math.random() < pKeluar ? -1 : 1);
        transaksi = { sisa: delta, laju: delta / 4 };            // dituang selama ~8 detik
      }
      if (transaksi) {
        const l = Math.abs(transaksi.sisa) < Math.abs(transaksi.laju) ? transaksi.sisa : transaksi.laju;
        fisik.massaKotor = Math.max(0, fisik.massaKotor + l);
        transaksi.sisa -= l;
        if (Math.abs(transaksi.sisa) < 0.5) transaksi = null;
      }
      if (opsi.bocor) fisik.massaKotor -= (0.8 / 60) * dt;     // ~0,8 g/menit, di bawah ambang transaksi
      // kadar air gabah: turun pelan saat diaerasi, naik pelan bila ruang lembap (dipercepat agar demo terlihat)
      if (blowerNyala) fisik.kadar -= 0.0002 * dt * (luar.rh < 72 ? 1 : 0.3);
      else fisik.kadar += (fisik.rhDalam - 66) * 0.000015 * dt;
      fisik.kadar = Math.min(19, Math.max(11.5, fisik.kadar));
      fisik.adc = 3108 + Math.round((fisik.rhDalam - 70) * 6 + acak(-4, 4));

      if (opsi.gangguan && !gangguanSampai && Math.random() < dt / 5400) {   // ~1x per 1,5 jam
        gangguanSampai = millis() + 25e3;
        log('[sim] gangguan acak: SHT31 udara masuk dicabut 25 detik');
      }
      if (gangguanSampai && millis() > gangguanSampai) gangguanSampai = 0;

      // ---- "baca sensor" ----
      d.tDalam = fisik.tDalam + acak(-0.05, 0.05);
      d.rhDalam = fisik.rhDalam + acak(-0.2, 0.2);
      if (gangguanSampai) { d.tMasuk = null; d.rhMasuk = null; d.sMasuk = 'gangguan'; }
      else { d.tMasuk = luar.t; d.rhMasuk = Math.min(100, Math.max(0, luar.rh)); d.sMasuk = 'ok'; }
      d.co2 = Math.round(fisik.co2);
      d.sCo2 = millis() < PEMANASAN_CO2_MS ? 'pemanasan' : 'ok';
      d.kapAdc = fisik.adc;
      d.kadarAir = fisik.kadar + acak(-0.05, 0.05);
      bacaMassa();
      evaluasiAerasi();
    }

    function bacaMassa() {                           // meniru bacaMassa() firmware
      const beku = blowerNyala || (msBlowerMati && millis() - msBlowerMati < BEKU_SETELAH_MS);
      d.massaBeku = !!beku;
      if (beku) { jendela = []; return; }
      const g = fisik.massaKotor - taraOffset + acak(-1.5, 1.5);
      d.massa = g;
      jendela.push(g); if (jendela.length > 3) jendela.shift();
      d.massaStabil = false;
      if (jendela.length < 3) return;
      const mn = Math.min(...jendela), mx = Math.max(...jendela);
      if (mx - mn > 10) return;
      const stabil = jendela.reduce((a, b) => a + b, 0) / 3;
      d.massa = stabil; d.massaStabil = true;
      if (massaTercatat === null) { massaTercatat = stabil; return; }
      const delta = stabil - massaTercatat;
      if (Math.abs(delta) < TRANSAKSI_G) { massaTercatat += delta * 0.15; return; }
      kirimEvent('transaksi', { delta_g: Math.round(delta), massa_g: Math.round(stabil), arah: delta > 0 ? 'masuk' : 'keluar' });
      massaTercatat = stabil;
    }

    // ============================ AERASI =============================
    function setBlower(on, sebab) {
      if (on === blowerNyala) return;
      blowerNyala = on;
      if (on) msBlowerNyala = millis(); else msBlowerMati = millis();
      kirimEvent('blower', { blower: on, mode, alasan: sebab });
      log(`[sim] Blower ${on ? 'NYALA' : 'MATI'}: ${sebab}`);
    }

    function evaluasiAerasi() {
      const now = millis();
      if (mode === 'MANUAL') {
        if (now >= manualSampaiMs) {
          mode = 'AUTO';
          kirimEvent('manual_timeout', { pesan: 'Batas waktu mode manual habis, kembali ke AUTO' });
          setBlower(false, 'Batas waktu manual habis');
        } else {
          setBlower(manualNyala, manualNyala ? 'Perintah manual operator' : 'Perintah manual operator (mati)');
          const sisaDetik = Math.floor((manualSampaiMs - now) / 1000) + 1;
          alasan = `MANUAL: blower ${manualNyala ? 'nyala' : 'mati'}, sisa ${sisaDetik < 60 ? `${sisaDetik} detik` : `${Math.floor(sisaDetik / 60) + 1} menit`}`;
          return;
        }
      }

      if (!okDalam() || !okMasuk()) {
        butuhAerasi = false; udaraLayak = false;
        setBlower(false, 'Data suhu/kelembapan tidak valid');
        alasan = 'Keputusan otomatis dihentikan: ' + (!okDalam() ? 'SHT31 ruang dalam ' : '') +
          (!okMasuk() ? 'SHT31 udara masuk ' : '') + 'gangguan. Prosedur cadangan: pemeriksaan manual.';
        prioritas = 'tinggi';
        return;
      }

      const tD = nTDalam(), tM = nTMasuk(), rhM = nRhMasuk(), co2 = nCo2();
      const co2Valid = okCo2();

      if (co2Valid && co2 >= amb.co2Nyala) { if (!msCo2MulaiTinggi) msCo2MulaiTinggi = now || 1; }
      else if (!co2Valid || co2 < amb.co2Lepas) msCo2MulaiTinggi = 0;
      const co2Bertahan = !!msCo2MulaiTinggi && (now - msCo2MulaiTinggi) / 1000 >= DUR_CO2_BERTAHAN_S;

      // ---- prioritas 1: gabah lembap (sama seperti firmware) ----
      const ka = nKa();
      const kaValid = ka !== null;
      if (kaValid && ka >= amb.kaNyala) { if (!msKaMulaiTinggi) msKaMulaiTinggi = now || 1; }
      else if (!kaValid || ka < amb.kaLepas) msKaMulaiTinggi = 0;
      const kaBertahan = !!msKaMulaiTinggi && (now - msKaMulaiTinggi) / 1000 >= DUR_KA_BERTAHAN_S;
      const butuhLembap = modeLembap ? (kaValid && ka >= amb.kaLepas) : kaBertahan;
      const sKa = kaValid ? `kadar air ${f1(ka)}%` : 'kadar air n/a';
      const alarmCo2 = co2Valid && co2 > amb.co2Alarm;
      if (butuhLembap) {
        const terlaluBasah = rhM > amb.rhMasukBasah;
        msKaTurun = 0; butuhAerasi = true; udaraLayak = !terlaluBasah;
        modeLembap = !terlaluBasah;
        setBlower(!terlaluBasah, terlaluBasah ? `Udara masuk sangat basah (RH ${f1(rhM)}%)` : `Gabah lembap (${sKa})`);
        alasan = terlaluBasah
          ? `PRIORITAS LEMBAP: ${sKa}, tetapi udara masuk sangat basah (RH ${f1(rhM)}% > ${f1(amb.rhMasukBasah)}%), blower ditahan`
          : `Blower nyala - PRIORITAS LEMBAP: ${sKa} (berhenti bila < ${f1(amb.kaLepas)}%)`;
        prioritas = alarmCo2 ? 'tinggi' : 'waspada';
        return;
      }
      if (modeLembap && blowerNyala) {
        if (!msKaTurun) msKaTurun = now || 1;
        const lamaTurun = Math.floor((now - msKaTurun) / 1000);
        prioritas = alarmCo2 ? 'tinggi' : 'normal';
        if (lamaTurun < DUR_KA_BERTAHAN_S) {
          alasan = `Gabah tidak lembap lagi (${sKa}), blower mati dalam ${DUR_KA_BERTAHAN_S - lamaTurun} detik`;
          return;
        }
        modeLembap = false; msKaTurun = 0;
        setBlower(false, `Gabah tidak lembap lagi (${sKa})`);
        alasan = `Blower mati: gabah tidak lembap lagi (${sKa}), kembali ke aturan suhu/CO2`;
        return;
      }
      modeLembap = false;

      const butuhSuhu = blowerNyala ? tD > amb.tMati : tD >= amb.tNyala;
      const butuhCo2 = blowerNyala ? (co2Valid && co2 >= amb.co2Lepas && !!msCo2MulaiTinggi) : co2Bertahan;
      butuhAerasi = butuhSuhu || butuhCo2;

      const selisih = tD - tM;
      udaraLayak = blowerNyala ? (rhM <= amb.rhMasukMati && selisih > amb.dtLepas)
        : (rhM <= amb.rhMasukMaks && selisih >= amb.dtMin);

      const detailMasuk = `udara masuk RH ${f1(rhM)}%, ${f1(selisih)} C lebih dingin`;
      let detailButuh = butuhSuhu ? `suhu ruang ${f1(tD)} C` : '';
      if (butuhCo2) detailButuh += (detailButuh ? ' dan ' : '') + `CO2 ${co2} ppm bertahan`;

      const lamaNyala = (now - msBlowerNyala) / 1000;
      const lamaMati = (now - msBlowerMati) / 1000;

      if (!blowerNyala) {
        if (butuhAerasi && udaraLayak) {
          if (msBlowerMati !== 0 && lamaMati < DUR_MIN_MATI_S) {
            alasan = `Aerasi perlu & udara layak, menunggu durasi minimum mati (${DUR_MIN_MATI_S - lamaMati} detik lagi)`;
          } else {
            const sebab = `Aerasi perlu (${detailButuh}) dan ${detailMasuk}`;
            setBlower(true, sebab);
            alasan = 'Blower nyala: ' + sebab;
          }
        } else if (butuhAerasi) {
          alasan = `Blower DITUNDA: aerasi perlu (${detailButuh}) tetapi udara masuk tidak layak (${detailMasuk}; syarat RH <= ${f1(amb.rhMasukMaks)}% dan >= ${f1(amb.dtMin)} C lebih dingin)`;
        } else if (msCo2MulaiTinggi) {
          alasan = `CO2 ${co2} ppm >= ${amb.co2Nyala}, dipantau (${Math.floor((now - msCo2MulaiTinggi) / 1000)}/${DUR_CO2_BERTAHAN_S} detik)`;
        } else {
          alasan = `Kondisi stabil: suhu ruang ${f1(tD)} C, CO2 ${co2Valid ? co2 + ' ppm' : 'n/a'}, aerasi tidak diperlukan`;
        }
      } else if (!udaraLayak) {
        const sebab = `Udara masuk tidak layak lagi (${detailMasuk})`;
        perluSetelahAerasi = butuhAerasi;
        setBlower(false, sebab);
        alasan = 'Blower mati: ' + sebab;
      } else if (!butuhAerasi) {
        if (lamaNyala < DUR_MIN_NYALA_S) {
          alasan = `Kebutuhan aerasi selesai, menunggu durasi minimum nyala (${DUR_MIN_NYALA_S - lamaNyala} detik lagi)`;
        } else {
          perluSetelahAerasi = false;
          setBlower(false, `Kebutuhan aerasi selesai (suhu ruang ${f1(tD)} C)`);
          alasan = 'Blower mati: kebutuhan aerasi selesai';
        }
      } else {
        alasan = `Blower nyala: aerasi masih diperlukan (${detailButuh}), ${detailMasuk}`;
        if (lamaNyala >= DUR_PENYIMPANGAN_S) perluSetelahAerasi = true;
      }

      if ((co2Valid && co2 > amb.co2Alarm) || perluSetelahAerasi) prioritas = 'tinggi';
      else if ((butuhAerasi && !udaraLayak) || (co2Valid && co2 >= amb.co2Nyala) ||
        d.sCo2 === 'gangguan' || d.sHx === 'gangguan' || d.sKap === 'gangguan') prioritas = 'waspada';
      else prioritas = 'normal';
    }

    // ============================== JSON =============================
    function buatTelemetri() {
      const co2 = nCo2();
      return {
        silo: SILO_ID, t: epochSekarang(), up: Math.floor(millis() / 1000),
        mode, simulasi: sim.aktif, demo: modeDemo,
        massa_g: angka(d.massa, 0), massa_beku: d.massaBeku, massa_stabil: d.massaStabil,
        t_dalam: angka(nTDalam(), 1), rh_dalam: angka(nRhDalam(), 1),
        t_masuk: angka(nTMasuk(), 1), rh_masuk: angka(nRhMasuk(), 1),
        co2: co2 === null ? null : co2, kap_adc: d.kapAdc, kadar_air: angka(nKa(), 1),
        blower: blowerNyala, butuh_aerasi: butuhAerasi, udara_layak: udaraLayak,
        alasan, prioritas, alarm_co2: co2 !== null && co2 > amb.co2Alarm,
        sensor: { sht_dalam: d.sDalam, sht_masuk: d.sMasuk, co2: d.sCo2, hx711: d.sHx, kapasitif: d.sKap },
        rssi: Math.round(acak(-62, -50)),
      };
    }

    function kirimEvent(jenis, data) {
      const j = JSON.stringify({ silo: SILO_ID, t: epochSekarang(), jenis, data });
      log(`[event] ${j}`);
      kirim(TOPIK.event, j);
    }

    function kirimTelemetri() {
      const t = buatTelemetri();
      kirim(TOPIK.tele, JSON.stringify(t));
      return t;
    }

    function kirimBacklog(n) {                       // data "tersimpan saat offline" (snapshot tiap 30 s)
      for (let i = n; i >= 1; i--) {
        kirim(TOPIK.backlog, JSON.stringify({
          silo: SILO_ID, t: 0, umur_s: i * 30,          // t=0: waktu belum sinkron saat data dibuat
          t_dalam: angka(fisik.tDalam - i * 0.02, 1), rh_dalam: angka(fisik.rhDalam, 1),
          t_masuk: angka(28 + acak(-1, 1), 1), rh_masuk: angka(71 + acak(-2, 2), 1),
          co2: Math.round(fisik.co2 - i * 4), massa_g: Math.round(fisik.massaKotor), kap_adc: fisik.adc,
          blower: false, simulasi: false,
        }));
      }
      log(`[sim] ${n} data backlog dikirim`);
    }

    // dipanggil saat tersambung ke broker (seperti jagaKoneksi() di firmware)
    function tersambung(buffer = 0) {
      kirim(TOPIK.status, 'online', { retain: true, qos: 1 });
      kirimEvent('online', { buffer });
      if (buffer) kirimBacklog(buffer);
    }

    function sinkronWaktu(epochDetik) {
      if (!(epochDetik > 1700000000)) return;
      if (epochOffset === null) log('[sim] waktu tersinkron dari laptop');
      epochOffset = epochDetik - Math.floor(millis() / 1000);
    }

    function jalankanPerintah(teks) {
      const cmd = String(teks).trim().toLowerCase();
      if (!cmd) return;
      log(`[cmd mqtt] ${cmd}`);
      const [a, b = '', ...sisa] = cmd.split(' ');
      const c = sisa.join(' ');

      if (a === 'status') log(JSON.stringify(buatTelemetri(), null, 1));
      else if (a === 'auto') { mode = 'AUTO'; kirimEvent('mode', { mode: 'AUTO' }); }
      else if (a === 'manual') {
        let detik = (parseInt(c, 10) || 0) * (/d$/.test(c || '') ? 1 : 60);   // "5d" = 5 detik, "5" = 5 menit
        detik = Math.min(detik || MANUAL_DEFAULT_DETIK, MANUAL_MAKS_MENIT * 60);
        mode = 'MANUAL'; manualNyala = b === 'on'; manualSampaiMs = millis() + detik * 1000;
        kirimEvent('mode', { mode: 'MANUAL', blower: manualNyala, ...(detik % 60 ? { detik } : { menit: detik / 60 }) });
      } else if (a === 'sim') {
        if (b === 'off') {
          sim = { aktif: false, tDalam: null, rhDalam: null, tMasuk: null, rhMasuk: null, co2: null, ka: null };
          kirimEvent('simulasi', { aktif: false });
        } else {
          const v = parseFloat(c) || 0;
          const kunci = { tdalam: 'tDalam', rhdalam: 'rhDalam', tmasuk: 'tMasuk', rhmasuk: 'rhMasuk', co2: 'co2', ka: 'ka' }[b];
          if (!kunci) return log('Nama simulasi tidak dikenal');
          sim.aktif = true;
          sim[kunci] = kunci === 'co2' ? Math.round(v) : v;
          if (sim.tMasuk === null && sim.rhMasuk !== null) sim.tMasuk = d.tMasuk;
          if (sim.tMasuk !== null && sim.rhMasuk === null) sim.rhMasuk = d.rhMasuk;
          kirimEvent('simulasi', { aktif: true, [b]: Number(v.toFixed(1)) });
        }
      } else if (a === 'demo') {
        aturDemo(b === 'on');
        kirimEvent('demo', { aktif: modeDemo });
      } else if (a === 'tara') {
        taraOffset = fisik.massaKotor;
        jendela = []; massaTercatat = null; d.massa = null;
        kirimEvent('tara', { offset: 8388000 + Math.round(taraOffset * 412) });
      } else if (a === 'kal' || a === 'scan' || a === 'wifi') {
        log(`[sim] "${cmd}" diterima (di ESP asli hasilnya tampil di Serial Monitor)`);
      } else log('Perintah tidak dikenal');
    }

    if (opsi.demo) aturDemo(true);

    return { TOPIK, langkah, kirimTelemetri, buatTelemetri, tersambung, sinkronWaktu, jalankanPerintah, aturDemo };
  }

  return { buatSimulator };
}));
