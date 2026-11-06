// =====================================================================
//  GrainSense - MODE DEMO (tanpa server, untuk GitHub Pages)
// ---------------------------------------------------------------------
//  Aktif otomatis di *.github.io atau bila alamat diberi ?demo.
//  Menjalankan simulator ESP32 (sim-inti.js) dan logika server (inti.js)
//  langsung di browser untuk beberapa silo, lalu menyamar sebagai
//  /api/* dan /api/stream sehingga app.js berjalan tanpa diubah.
//  Semua data berlabel DEMO. Di laptop (node server.js) file ini diam.
// =====================================================================
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  if (!location.hostname.endsWith('github.io') && !q.has('demo')) return;

  const { buatInti, buatCsv, RENTANG, waktuLokal } = window.GrainSenseInti;
  const { buatSimulator } = window.GrainSenseSim;
  const JAM_CONTOH = 6;                       // riwayat contoh yang dibangkitkan saat halaman dibuka

  // ---------- beberapa silo, masing-masing "server" + "ESP32" sendiri ----------
  const p2 = (n) => String(n).padStart(2, '0');
  const SILO_DEMO = [
    { id: 'silo01', kode: 'DEMO-01', hari: 2, gangguan: true, awal: {} },
    { id: 'silo02', kode: 'DEMO-02', hari: 5, awal: { massaKotor: 9300, kadar: 13.1, tDalam: 27.2, rhDalam: 64, co2: 820 } },
    { id: 'silo03', kode: 'DEMO-03', hari: 1, awal: { massaKotor: 2700, kadar: 14.7, tDalam: 28.6, rhDalam: 71, co2: 1250 } },
  ];
  let waktuKirim = 0;
  const SILO = new Map();

  function buatSiloDemo(cfg) {
    const pendengar = new Set();
    const siarkan = (nama, data) => {
      const e = { data: JSON.stringify(data) };
      for (const es of pendengar) es._kirim(nama, e);
    };
    let sim = null;
    let mengisi = true;                       // true = sedang membangkitkan riwayat contoh
    const inti = buatInti({
      silo: cfg.id, siarkan,
      kirimWaktu: () => {
        if (sim) sim.sinkronWaktu(Math.floor(Date.now() / 1000));
        waktuKirim = Date.now();
        siarkan('waktu', { waktuTerakhirKirim: waktuKirim });
        return true;
      },
    });
    let jamVirtual = Date.now() - JAM_CONTOH * 3600e3;
    sim = buatSimulator({
      silo: cfg.id, gangguan: !!cfg.gangguan, awal: cfg.awal,
      jam: () => (mengisi ? jamVirtual : Date.now()),
      kirim: (topik, teks) => {
        if (!mengisi) return inti.terimaPesan(topik, teks);
        if (topik === inti.TOPIK.tele) inti.isiRiwayat(JSON.parse(teks));
        else if (topik === inti.TOPIK.event) inti.terimaEvent(JSON.parse(teks));
      },
    });
    const hariMasuk = new Date(Date.now() - cfg.hari * 86400e3);
    inti.aturBatch({ kode: cfg.kode, asal: 'Data contoh (demo)',
      tanggal_masuk: `${hariMasuk.getFullYear()}-${p2(hariMasuk.getMonth() + 1)}-${p2(hariMasuk.getDate())}` });
    // Bangkitkan riwayat contoh: simulator dijalankan cepat dengan jam virtual
    sim.sinkronWaktu(Math.floor(jamVirtual / 1000));
    for (let s = 0; jamVirtual < Date.now() - 5000; s += 2) {
      jamVirtual += 2000;
      sim.langkah(2);
      if (s % 6 === 4) sim.kirimTelemetri();   // tiap ~5-6 detik, seperti firmware
    }
    mengisi = false;
    // Sejak sekarang berjalan waktu nyata: ESP "tersambung", mode demo dinyalakan
    sim.tersambung(0);
    sim.jalankanPerintah('demo on');
    sim.kirimTelemetri();
    return { id: cfg.id, inti, sim, pendengar, siarkan };
  }
  for (const cfg of SILO_DEMO) SILO.set(cfg.id, buatSiloDemo(cfg));
  const siloDari = (url) => SILO.get(url.searchParams.get('silo')) || SILO.get('silo01');

  let msLalu = Date.now();
  setInterval(() => { const now = Date.now(); for (const s of SILO.values()) s.sim.langkah((now - msLalu) / 1000); msLalu = now; }, 2000);
  setInterval(() => { for (const s of SILO.values()) s.sim.kirimTelemetri(); }, 5000);
  setInterval(() => { for (const s of SILO.values()) { s.inti.evaluasiPeringatan(); s.siarkan('ringkasan', s.inti.ringkasan()); } }, 10e3);

  // ---------- pengganti EventSource('/api/stream') ----------
  class DemoEventSource {
    constructor(alamat) {
      this.silo = siloDari(new URL(alamat, location.href));
      this.pendengar = {};
      this.onopen = null;
      this.onerror = null;
      this.silo.pendengar.add(this);
      setTimeout(() => {
        if (this.onopen) this.onopen();
        this._kirim('awal', { data: JSON.stringify(this.silo.inti.keadaanAwal({
          mqtt: true, waktuTerakhirKirim: waktuKirim, daftarSilo: [...SILO.keys()] })) });
      }, 0);
    }
    addEventListener(nama, fn) { (this.pendengar[nama] = this.pendengar[nama] || []).push(fn); }
    _kirim(nama, e) { (this.pendengar[nama] || []).forEach((fn) => fn(e)); }
    close() { this.silo.pendengar.delete(this); }
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
    const { inti, sim, siarkan } = siloDari(url);
    switch (cocok[1]) {
      case 'silo': return jawab(200, { mqtt: true, silo: [...SILO.values()].map((s) => s.inti.ringkasSilo()) });
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
        for (const s of SILO.values()) s.sim.sinkronWaktu(Math.floor(Date.now() / 1000));
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
    const { inti, id } = siloDari(url);
    const data = jenis === 'kejadian' ? inti.kejadianSejak(batas) : inti.riwayatSejak(batas);
    const blob = new Blob([buatCsv(jenis, data)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grainsense_DEMO_${id}_${jenis}_${rentang}_${waktuLokal(Date.now()).replace(/[: ]/g, '-')}.csv`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  window.GS_DEMO = { unduh };

  // ---------- penanda DEMO yang jelas ----------
  document.addEventListener('DOMContentLoaded', () => {
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
