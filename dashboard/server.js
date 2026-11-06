'use strict';
// =====================================================================
//  GrainSense - backend dashboard
// ---------------------------------------------------------------------
//  - Langganan MQTT grainsense/<silo>/{telemetry,event,backlog,status}
//    untuk satu atau beberapa silo (SILO_ID=silo01,silo02,...)
//  - Simpan riwayat ke data/telemetri.jsonl & data/kejadian.jsonl
//    (silo pertama; silo berikutnya di data/<silo>/)
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
// Satu dashboard bisa memantau beberapa silo: SILO_ID=silo01,silo02,silo03
const DAFTAR_SILO = [...new Set((process.env.SILO_ID || 'silo01').split(',').map((s) => s.trim()).filter(Boolean))];
const SILO_UTAMA = DAFTAR_SILO[0];
const LABEL_CO2 = process.env.LABEL_CO2 || 'CO₂';   // isi "eCO₂" bila memakai ENS160
const DAYA_BLOWER_W = Number(process.env.DAYA_BLOWER_W) || 32;   // 12 V x 2,65 A (blower di RAB)
const ANOMALI_G = Number(process.env.ANOMALI_G) || 15;           // selisih massa tanpa transaksi yang dianggap anomali
const KAPASITAS_G = Number(process.env.KAPASITAS_G) || 11000;    // kapasitas wadah prototipe (proposal 3.1: ~11 kg gabah)

const DIR_DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIR_PUBLIK = path.join(__dirname, 'public');

let waktuTerakhirKirim = 0;
const klienSemua = new Set();   // klien SSE dari semua silo (untuk status MQTT & waktu)

// Satu "inti" per silo. Silo pertama memakai folder data/ seperti sebelumnya,
// silo berikutnya data/<silo>/ supaya data lama tetap terbaca.
const SILO = new Map();
for (const id of DAFTAR_SILO) {
  const dir = id === SILO_UTAMA ? DIR_DATA : path.join(DIR_DATA, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = {
    tele: path.join(dir, 'telemetri.jsonl'),
    kejadian: path.join(dir, 'kejadian.jsonl'),
    batch: path.join(dir, 'batch.json'),
  };
  const klien = new Set();
  const siarkan = (nama, data) => {
    const s = `event: ${nama}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of klien) res.write(s);
  };
  const inti = buatInti({
    silo: id, labelCo2: LABEL_CO2, dayaW: DAYA_BLOWER_W, anomaliG: ANOMALI_G, kapasitasG: KAPASITAS_G,
    simpanBaris: (b) => fs.appendFileSync(file.tele, JSON.stringify(b) + '\n'),
    simpanKejadian: (k) => fs.appendFileSync(file.kejadian, JSON.stringify(k) + '\n'),
    simpanBatch: (b) => fs.writeFileSync(file.batch, JSON.stringify(b, null, 1)),
    siarkan,
    kirimWaktu: () => kirimWaktu(),
  });
  SILO.set(id, { id, inti, file, klien, siarkan });
}

function siarkanSemua(nama, data) {
  const s = `event: ${nama}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of klienSemua) res.write(s);
}

const siloDari = (url) => SILO.get(url.searchParams.get('silo')) || SILO.get(SILO_UTAMA);

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

function muatBatch(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ============================== MQTT =================================
const klienMqtt = mqtt.connect(MQTT_URL, {
  clientId: `grainsense-dashboard-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 3000,
  connectTimeout: 5000,
});

function kirimWaktu() {
  if (!klienMqtt.connected) return false;
  klienMqtt.publish(SILO.get(SILO_UTAMA).inti.TOPIK.waktu, String(Math.floor(Date.now() / 1000)));
  waktuTerakhirKirim = Date.now();
  siarkanSemua('waktu', { waktuTerakhirKirim });
  return true;
}

klienMqtt.on('connect', () => {
  console.log(`[mqtt] tersambung ke ${MQTT_URL}`);
  for (const { inti } of SILO.values()) {
    const T = inti.TOPIK;
    klienMqtt.subscribe([T.tele, T.event, T.backlog, T.status]);
  }
  kirimWaktu();
  siarkanSemua('mqtt', { tersambung: true });
});
klienMqtt.on('close', () => siarkanSemua('mqtt', { tersambung: false }));
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
    const silo = SILO.get(topik.split('/')[1]);     // grainsense/<silo>/...
    if (silo) silo.inti.terimaPesan(topik, buf.toString().trim());
  } catch (e) {
    console.log(`[mqtt] pesan ${topik} tidak bisa dibaca: ${e.message}`);
  }
});

setInterval(kirimWaktu, 60e3);
setInterval(() => { for (const s of SILO.values()) s.inti.pangkasRam(); }, 10 * 60e3);
setInterval(() => {                       // ESP diam tanpa Last Will tetap terdeteksi; ringkasan tetap segar
  for (const s of SILO.values()) {
    s.inti.evaluasiPeringatan();
    s.siarkan('ringkasan', s.inti.ringkasan());
  }
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

function bukaSse(req, res, silo) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const awal = silo.inti.keadaanAwal({ mqtt: klienMqtt.connected, waktuTerakhirKirim, daftarSilo: DAFTAR_SILO });
  res.write(`retry: 3000\nevent: awal\ndata: ${JSON.stringify(awal)}\n\n`);
  silo.klien.add(res);
  klienSemua.add(res);
  const detak = setInterval(() => res.write(': detak\n\n'), 20e3);
  req.on('close', () => { clearInterval(detak); silo.klien.delete(res); klienSemua.delete(res); });
}

async function eksporCsv(res, silo, jenis, rentang) {
  const batas = rentang === 'semua' ? 0 : Date.now() - (RENTANG[rentang] || RENTANG['24h']);
  const tele = jenis !== 'kejadian';
  const data = await bacaJsonl(tele ? silo.file.tele : silo.file.kejadian, batas);
  const nama = `grainsense_${silo.id}_${tele ? 'telemetri' : 'kejadian'}_${rentang}_${waktuLokal(Date.now()).replace(/[: ]/g, '-')}.csv`;
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nama}"` });
  res.end(buatCsv(tele ? 'telemetri' : 'kejadian', data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const silo = siloDari(url);
  const { inti } = silo;
  try {
    if (req.method === 'GET' && p === '/api/silo') {
      return kirimJson(res, 200, { mqtt: klienMqtt.connected, silo: [...SILO.values()].map((s) => s.inti.ringkasSilo()) });
    }
    if (req.method === 'GET' && p === '/api/stream') return bukaSse(req, res, silo);
    if (req.method === 'GET' && p === '/api/riwayat') return kirimJson(res, 200, inti.ambilRiwayat(url.searchParams.get('rentang')));
    if (req.method === 'GET' && p === '/api/ekspor.csv') {
      return await eksporCsv(res, silo, url.searchParams.get('jenis'), url.searchParams.get('rentang') || '24h');
    }
    if (req.method === 'POST' && p === '/api/perintah') {
      const { cmd } = JSON.parse(await bacaBody(req) || '{}');
      if (!klienMqtt.connected) return kirimJson(res, 503, { galat: 'Broker MQTT belum tersambung' });
      let teks;
      try { teks = inti.catatPerintah(cmd); } catch (e) { return kirimJson(res, 400, { galat: e.message }); }
      klienMqtt.publish(inti.TOPIK.cmd, teks);
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
  for (const s of SILO.values()) {
    const riwayat = await bacaJsonl(s.file.tele, batas);
    const kejadian = (await bacaJsonl(s.file.kejadian, batas)).slice(-MAKS_KEJADIAN_RAM);
    s.inti.muat({ riwayat, kejadian, batch: muatBatch(s.file.batch) });
    console.log(`[data] ${s.id}: dimuat ${riwayat.length} baris telemetri & ${kejadian.length} kejadian (72 jam terakhir)`);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[http] dashboard: http://localhost:${PORT}  (dari HP di hotspot: http://192.168.137.1:${PORT})`);
  });
})();
