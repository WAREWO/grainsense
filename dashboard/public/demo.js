// =====================================================================
//  GrainSense - MODE DEMO (tanpa server, untuk GitHub Pages)
// ---------------------------------------------------------------------
//  Aktif otomatis di *.github.io atau bila alamat diberi ?demo.
//  Menjalankan simulator ESP32 (sim-inti.js) dan logika server (inti.js)
//  langsung di browser, lalu menyamar sebagai /api/* dan /api/stream
//  sehingga app.js berjalan tanpa diubah. Semua data berlabel DEMO.
//  Di laptop (node server.js) file ini tidak melakukan apa-apa.
// =====================================================================
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  if (!location.hostname.endsWith('github.io') && !q.has('demo')) return;

  const { buatInti, buatCsv, RENTANG, waktuLokal } = window.GrainSenseInti;
  const { buatSimulator } = window.GrainSenseSim;
  const JAM_CONTOH = 6;                       // riwayat contoh yang dibangkitkan saat halaman dibuka

  // ---------- "server" ----------
  const pendengar = new Set();
  let waktuKirim = 0;
  function siarkan(nama, data) {
    const e = { data: JSON.stringify(data) };
    for (const es of pendengar) es._kirim(nama, e);
  }

  let sim = null;
  let mengisi = true;                         // true = sedang membangkitkan riwayat contoh
  const inti = buatInti({
    silo: 'silo01', siarkan,
    kirimWaktu: () => {
      if (sim) sim.sinkronWaktu(Math.floor(Date.now() / 1000));
      waktuKirim = Date.now();
      siarkan('waktu', { waktuTerakhirKirim: waktuKirim });
      return true;
    },
  });

  // ---------- "ESP32" ----------
  let jamVirtual = Date.now() - JAM_CONTOH * 3600e3;
  sim = buatSimulator({
    silo: 'silo01', gangguan: true,
    jam: () => (mengisi ? jamVirtual : Date.now()),
    kirim: (topik, teks) => {
      if (!mengisi) return inti.terimaPesan(topik, teks);
      if (topik === inti.TOPIK.tele) inti.isiRiwayat(JSON.parse(teks));
      else if (topik === inti.TOPIK.event) inti.terimaEvent(JSON.parse(teks));
    },
  });

  // Bangkitkan riwayat contoh: simulator dijalankan cepat dengan jam virtual
  const hariMasuk = new Date(Date.now() - 2 * 86400e3);
  const p2 = (n) => String(n).padStart(2, '0');
  inti.aturBatch({ kode: 'DEMO-01', asal: 'Data contoh (demo)',
    tanggal_masuk: `${hariMasuk.getFullYear()}-${p2(hariMasuk.getMonth() + 1)}-${p2(hariMasuk.getDate())}` });
  sim.sinkronWaktu(Math.floor(jamVirtual / 1000));
  for (let s = 0; jamVirtual < Date.now() - 5000; s += 2) {
    jamVirtual += 2000;
    sim.langkah(2);
    if (s % 6 === 4) sim.kirimTelemetri();     // tiap ~5-6 detik, seperti firmware
  }
  mengisi = false;

  // Sejak sekarang berjalan waktu nyata: ESP "tersambung", mode demo dinyalakan
  sim.tersambung(0);
  sim.jalankanPerintah('demo on');
  sim.kirimTelemetri();
  let msLalu = Date.now();
  setInterval(() => { const now = Date.now(); sim.langkah((now - msLalu) / 1000); msLalu = now; }, 2000);
  setInterval(() => sim.kirimTelemetri(), 5000);
  setInterval(() => { inti.evaluasiPeringatan(); siarkan('ringkasan', inti.ringkasan()); }, 10e3);

  // ---------- pengganti EventSource('/api/stream') ----------
  class DemoEventSource {
    constructor() {
      this.pendengar = {};
      this.onopen = null;
      this.onerror = null;
      pendengar.add(this);
      setTimeout(() => {
        if (this.onopen) this.onopen();
        this._kirim('awal', { data: JSON.stringify(inti.keadaanAwal({ mqtt: true, waktuTerakhirKirim: waktuKirim })) });
      }, 0);
    }
    addEventListener(nama, fn) { (this.pendengar[nama] = this.pendengar[nama] || []).push(fn); }
    _kirim(nama, e) { (this.pendengar[nama] || []).forEach((fn) => fn(e)); }
    close() { pendengar.delete(this); }
  }
  window.EventSource = DemoEventSource;

  // ---------- pengganti fetch('/api/...') ----------
  const fetchAsli = window.fetch.bind(window);
  const jawab = (kode, obj) => new Response(JSON.stringify(obj), { status: kode, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (masukan, init = {}) => {
    const url = new URL(typeof masukan === 'string' ? masukan : masukan.url, location.href);
    const cocok = url.pathname.match(/\/api\/([^/]+)$/);
    if (!cocok) return fetchAsli(masukan, init);
    const body = init.body ? JSON.parse(init.body) : {};
    switch (cocok[1]) {
      case 'riwayat': return jawab(200, inti.ambilRiwayat(url.searchParams.get('rentang')));
      case 'ringkasan': return jawab(200, inti.ringkasan());
      case 'perintah':
        try {
          const teks = inti.catatPerintah(body.cmd);
          setTimeout(() => sim.jalankanPerintah(teks), 150);   // seperti jeda jaringan ke ESP
          return jawab(200, { ok: true, cmd: teks });
        } catch (e) { return jawab(400, { galat: e.message }); }
      case 'batch':
        try { return jawab(200, inti.aturBatch(body)); } catch (e) { return jawab(400, { galat: e.message }); }
      case 'sinkron-waktu':                    // jam "laptop" = jam browser
        sim.sinkronWaktu(Math.floor(Date.now() / 1000));
        waktuKirim = Date.now();
        siarkan('waktu', { waktuTerakhirKirim: waktuKirim });
        return jawab(200, { ok: true });
      default: return jawab(404, { galat: 'Tidak tersedia di mode demo' });
    }
  };

  // ---------- ekspor CSV dibuat di browser ----------
  function unduh(alamat) {
    const url = new URL(alamat, location.href);
    const jenis = url.searchParams.get('jenis') === 'kejadian' ? 'kejadian' : 'telemetri';
    const rentang = url.searchParams.get('rentang') || '24h';
    const batas = rentang === 'semua' ? 0 : Date.now() - (RENTANG[rentang] || RENTANG['24h']);
    const data = jenis === 'kejadian' ? inti.kejadianSejak(batas) : inti.riwayatSejak(batas);
    const blob = new Blob([buatCsv(jenis, data)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grainsense_DEMO_${jenis}_${rentang}_${waktuLokal(Date.now()).replace(/[: ]/g, '-')}.csv`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  window.GS_DEMO = { unduh };
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href*="api/ekspor.csv"]');
    if (!a) return;
    e.preventDefault();
    unduh(a.getAttribute('href'));
  }, true);

  // ---------- penanda DEMO yang jelas ----------
  document.addEventListener('DOMContentLoaded', () => {
    document.title = 'GrainSense Dashboard (DEMO)';
    document.body.classList.add('mode-demo-online');
    const b = document.createElement('div');
    b.className = 'banner banner-demo';
    b.innerHTML = '<svg><use href="#i-flask"/></svg><div><b>DEMO ONLINE</b> — semua data di halaman ini dibangkitkan ' +
      'simulator di browser Anda, <u>bukan</u> dari sensor GrainSense sungguhan. ESP32 & broker MQTT ikut disimulasikan; ' +
      `riwayat ${JAM_CONTOH} jam terakhir dibuat otomatis saat halaman dibuka dan hilang saat halaman ditutup. ` +
      'Sistem asli berjalan lokal: ESP32 → Mosquitto → dashboard di laptop.</div>';
    document.querySelector('.konten').prepend(b);
  });
}());
