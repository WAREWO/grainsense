'use strict';
// =====================================================================
//  GrainSense - backend dashboard
// ---------------------------------------------------------------------
//  - Langganan MQTT grainsense/<silo>/{telemetry,event,backlog,status}
//  - Simpan riwayat ke data/telemetri.jsonl & data/kejadian.jsonl
//    (tetap tersimpan walau browser ditutup -> uji stabilitas 3 hari)
//  - Kirim data ke browser lewat Server-Sent Events (/api/stream)
//  - Publish epoch ke grainsense/time tiap 60 s (ESP tidak punya NTP)
//  - Teruskan perintah dari browser ke grainsense/<silo>/cmd
//  - Ekspor CSV untuk laporan
//  Logika (ringkasan, peringatan, CSV) ada di public/inti.js, dipakai
//  bersama dengan mode demo di browser.
//  Jalankan: node server.js   lalu buka http://localhost:8080
// =====================================================================
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mqtt = require('mqtt');
const { buatInti, buatCsv, waktuLokal, RENTANG, SIMPAN_RAM_MS, MAKS_KEJADIAN_RAM } = require('./public/inti.js');

// ============================ KONFIGURASI ============================
const PORT = Number(process.env.PORT) || 8080;
const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';
const SILO_ID = process.env.SILO_ID || 'silo01';
const LABEL_CO2 = process.env.LABEL_CO2 || 'CO₂';   // isi "eCO₂" bila memakai ENS160
const DAYA_BLOWER_W = Number(process.env.DAYA_BLOWER_W) || 32;   // 12 V x 2,65 A (blower di RAB)
const ANOMALI_G = Number(process.env.ANOMALI_G) || 15;           // selisih massa tanpa transaksi yang dianggap anomali

const DIR_DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIR_PUBLIK = path.join(__dirname, 'public');
const FILE_TELE = path.join(DIR_DATA, 'telemetri.jsonl');
const FILE_KEJADIAN = path.join(DIR_DATA, 'kejadian.jsonl');
const FILE_BATCH = path.join(DIR_DATA, 'batch.json');

fs.mkdirSync(DIR_DATA, { recursive: true });

const klienSse = new Set();
let waktuTerakhirKirim = 0;

function siarkan(nama, data) {
  const s = `event: ${nama}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of klienSse) res.write(s);
}

const inti = buatInti({
  silo: SILO_ID, labelCo2: LABEL_CO2, dayaW: DAYA_BLOWER_W, anomaliG: ANOMALI_G,
  simpanBaris: (b) => fs.appendFileSync(FILE_TELE, JSON.stringify(b) + '\n'),
  simpanKejadian: (k) => fs.appendFileSync(FILE_KEJADIAN, JSON.stringify(k) + '\n'),
  simpanBatch: (b) => fs.writeFileSync(FILE_BATCH, JSON.stringify(b, null, 1)),
  siarkan,
  kirimWaktu: () => kirimWaktu(),
});
const TOPIK = inti.TOPIK;

async function bacaJsonl(file, batasTs) {
  const hasil = [];
  if (!fs.existsSync(file)) return hasil;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const baris of rl) {
    if (!baris) continue;
    try {
      const o = JSON.parse(baris);
      if (o.ts >= batasTs) hasil.push(o);
    } catch { /* baris terpotong (mis. laptop mati saat menulis) dilewati */ }
  }
  return hasil.sort((a, b) => a.ts - b.ts);
}

function muatBatch() {
  try { return JSON.parse(fs.readFileSync(FILE_BATCH, 'utf8')); } catch { return null; }
}

// ============================== MQTT =================================
const klienMqtt = mqtt.connect(MQTT_URL, {
  clientId: `grainsense-dashboard-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 3000,
  connectTimeout: 5000,
});

function kirimWaktu() {
  if (!klienMqtt.connected) return false;
  klienMqtt.publish(TOPIK.waktu, String(Math.floor(Date.now() / 1000)));
  waktuTerakhirKirim = Date.now();
  siarkan('waktu', { waktuTerakhirKirim });
  return true;
}

klienMqtt.on('connect', () => {
  console.log(`[mqtt] tersambung ke ${MQTT_URL}`);
  klienMqtt.subscribe([TOPIK.tele, TOPIK.event, TOPIK.backlog, TOPIK.status]);
  kirimWaktu();
  siarkan('mqtt', { tersambung: true });
});
klienMqtt.on('close', () => siarkan('mqtt', { tersambung: false }));
klienMqtt.on('error', (e) => console.log(`[mqtt] ${e.message}`));
let pesanPutus = 0;
klienMqtt.on('reconnect', () => {
  if (Date.now() - pesanPutus > 30e3) {
    pesanPutus = Date.now();
    console.log(`[mqtt] mencoba menyambung ke ${MQTT_URL} ... (Mosquitto sudah jalan?)`);
  }
});

klienMqtt.on('message', (topik, buf) => {
  try {
    inti.terimaPesan(topik, buf.toString().trim());
  } catch (e) {
    console.log(`[mqtt] pesan ${topik} tidak bisa dibaca: ${e.message}`);
  }
});

setInterval(kirimWaktu, 60e3);
setInterval(inti.pangkasRam, 10 * 60e3);
setInterval(() => {                       // ESP diam tanpa Last Will tetap terdeteksi; ringkasan tetap segar
  inti.evaluasiPeringatan();
  siarkan('ringkasan', inti.ringkasan());
}, 10e3);

// ============================== HTTP =================================
const JENIS_FILE = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function kirimJson(res, kode, obj) {
  res.writeHead(kode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function bacaBody(req) {
  return new Promise((ok, gagal) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 4096) { gagal(new Error('terlalu besar')); req.destroy(); } });
    req.on('end', () => ok(s));
    req.on('error', gagal);
  });
}

function layaniStatis(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(DIR_PUBLIK, rel);
  if (!file.startsWith(DIR_PUBLIK + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, isi) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Tidak ditemukan'); }
    res.writeHead(200, { 'Content-Type': JENIS_FILE[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(isi);
  });
}

function bukaSse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const awal = inti.keadaanAwal({ mqtt: klienMqtt.connected, waktuTerakhirKirim });
  res.write(`retry: 3000\nevent: awal\ndata: ${JSON.stringify(awal)}\n\n`);
  klienSse.add(res);
  const detak = setInterval(() => res.write(': detak\n\n'), 20e3);
  req.on('close', () => { clearInterval(detak); klienSse.delete(res); });
}

async function eksporCsv(res, jenis, rentang) {
  const batas = rentang === 'semua' ? 0 : Date.now() - (RENTANG[rentang] || RENTANG['24h']);
  const tele = jenis !== 'kejadian';
  const data = await bacaJsonl(tele ? FILE_TELE : FILE_KEJADIAN, batas);
  const nama = `grainsense_${SILO_ID}_${tele ? 'telemetri' : 'kejadian'}_${rentang}_${waktuLokal(Date.now()).replace(/[: ]/g, '-')}.csv`;
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nama}"` });
  res.end(buatCsv(tele ? 'telemetri' : 'kejadian', data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/stream') return bukaSse(req, res);
    if (req.method === 'GET' && p === '/api/riwayat') return kirimJson(res, 200, inti.ambilRiwayat(url.searchParams.get('rentang')));
    if (req.method === 'GET' && p === '/api/ekspor.csv') {
      return await eksporCsv(res, url.searchParams.get('jenis'), url.searchParams.get('rentang') || '24h');
    }
    if (req.method === 'POST' && p === '/api/perintah') {
      const { cmd } = JSON.parse(await bacaBody(req) || '{}');
      if (!klienMqtt.connected) return kirimJson(res, 503, { galat: 'Broker MQTT belum tersambung' });
      let teks;
      try { teks = inti.catatPerintah(cmd); } catch (e) { return kirimJson(res, 400, { galat: e.message }); }
      klienMqtt.publish(TOPIK.cmd, teks);
      return kirimJson(res, 200, { ok: true, cmd: teks });
    }
    if (req.method === 'GET' && p === '/api/ringkasan') return kirimJson(res, 200, inti.ringkasan());
    if (req.method === 'POST' && p === '/api/batch') {
      try { return kirimJson(res, 200, inti.aturBatch(JSON.parse(await bacaBody(req) || '{}'))); }
      catch (e) { return kirimJson(res, 400, { galat: e.message }); }
    }
    if (req.method === 'POST' && p === '/api/sinkron-waktu') {
      return kirimWaktu() ? kirimJson(res, 200, { ok: true }) : kirimJson(res, 503, { galat: 'Broker MQTT belum tersambung' });
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return layaniStatis(res, p);
    kirimJson(res, 404, { galat: 'Tidak ditemukan' });
  } catch (e) {
    console.log(`[http] ${req.method} ${p}: ${e.message}`);
    if (!res.headersSent) kirimJson(res, 500, { galat: e.message });
    else res.end();
  }
});

// ============================== MULAI ================================
(async () => {
  const batas = Date.now() - SIMPAN_RAM_MS;
  const riwayat = await bacaJsonl(FILE_TELE, batas);
  const kejadian = (await bacaJsonl(FILE_KEJADIAN, batas)).slice(-MAKS_KEJADIAN_RAM);
  inti.muat({ riwayat, kejadian, batch: muatBatch() });
  console.log(`[data] dimuat ${riwayat.length} baris telemetri & ${kejadian.length} kejadian (72 jam terakhir)`);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[http] dashboard: http://localhost:${PORT}  (dari HP di hotspot: http://192.168.137.1:${PORT})`);
  });
})();
