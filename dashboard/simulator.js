'use strict';
// =====================================================================
//  GrainSense - SIMULATOR ESP32 (pengganti hardware selama perbaikan)
// ---------------------------------------------------------------------
//  Mem-publish telemetry/event/status/backlog dengan format PERSIS firmware
//  dan menjalankan logika aerasi Tabel 3.5 yang sama (evaluasiAerasi()).
//  Merespons perintah di grainsense/silo01/cmd dan sinkron waktu dari
//  grainsense/time. Logikanya ada di public/sim-inti.js (dipakai juga
//  oleh mode demo di browser).
//
//  Pemakaian:
//    node simulator.js                 normal (durasi minimum 3 detik)
//    node simulator.js --demo          langsung mode demo (durasi 3 detik)
//    node simulator.js --backlog 20    kirim 20 data "offline" saat tersambung
//    node simulator.js --tanpa-gangguan   matikan gangguan sensor acak
//    node simulator.js --bocor         massa turun pelan tanpa transaksi (uji anomali stok)
//  Ctrl+C = ESP "mati" (status offline).
// =====================================================================
const mqtt = require('mqtt');
const { buatSimulator } = require('./public/sim-inti.js');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';
const SILO_ID = process.env.SILO_ID || 'silo01';   // jalankan beberapa simulator untuk menguji banyak silo

const argv = process.argv.slice(2);
let backlog = argv.includes('--backlog') ? Number(argv[argv.indexOf('--backlog') + 1]) || 20 : 0;

const STATUS = `grainsense/${SILO_ID}/status`;
const klien = mqtt.connect(MQTT_URL, {
  clientId: `grainsense-${SILO_ID}-simulator`,
  will: { topic: STATUS, payload: 'offline', retain: true, qos: 1 },
  reconnectPeriod: 5000,
});

const sim = buatSimulator({
  silo: SILO_ID,
  demo: argv.includes('--demo'),
  gangguan: !argv.includes('--tanpa-gangguan'),
  bocor: argv.includes('--bocor'),
  kirim: (topik, teks, opsi) => { if (klien.connected) klien.publish(topik, teks, opsi || {}); },
  log: (teks) => console.log(teks),
});

klien.on('connect', () => {
  console.log(`[sim] tersambung ke ${MQTT_URL} sebagai ESP32 ${SILO_ID}`);
  klien.subscribe([sim.TOPIK.cmd, sim.TOPIK.waktu]);
  sim.tersambung(backlog);
  backlog = 0;
});
klien.on('error', (e) => console.log(`[sim] ${e.message}`));
klien.on('message', (topik, buf) => {
  const isi = buf.toString().trim();
  if (topik === sim.TOPIK.waktu) sim.sinkronWaktu(parseInt(isi, 10));
  else sim.jalankanPerintah(isi);
});

let msLalu = Date.now();
setInterval(() => {                               // INTERVAL_BACA_MS = 2000
  const now = Date.now();
  sim.langkah((now - msLalu) / 1000);
  msLalu = now;
}, 2000);

setInterval(() => {                               // INTERVAL_KIRIM_MS = 5000
  if (!klien.connected) return;
  const t = sim.kirimTelemetri();
  console.log(`[${t.up}s] ${t.mode}${t.simulasi ? '+SIM' : ''}${t.demo ? '+DEMO' : ''} | Td ${t.t_dalam} Tm ${t.t_masuk} RHm ${t.rh_masuk} | CO2 ${t.co2} | massa ${t.massa_g} g | blower ${t.blower ? 'ON' : 'OFF'} | ${t.alasan}`);
}, 5000);

process.on('SIGINT', () => {
  console.log('\n[sim] dimatikan -> status offline');
  if (!klien.connected) process.exit(0);
  klien.publish(STATUS, 'offline', { retain: true, qos: 1 }, () => klien.end(false, () => process.exit(0)));
  setTimeout(() => process.exit(0), 1500);
});
