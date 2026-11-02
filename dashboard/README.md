# GrainSense Dashboard

Dashboard lokal (tanpa internet) untuk silo gabah GrainSense.

```
ESP32 / simulator ──MQTT 1883──> Mosquitto ──> server.js ──SSE──> browser (http://localhost:8080)
                                     ^              │
                                     └── cmd/time ──┘     riwayat: dashboard/data/*.jsonl
```

## Mode demo (GitHub Pages)

Folder `public/` juga bisa dibuka **tanpa server**: di `*.github.io` (atau dengan `?demo` di alamat) file `demo.js`
menjalankan simulator ESP32 dan logika server langsung di browser, lengkap dengan riwayat contoh 6 jam.
Semua data diberi banner **DEMO ONLINE**. Logikanya memakai file yang sama dengan server asli
(`public/inti.js` dan `public/sim-inti.js`), jadi perilakunya identik. Uji lokal: `http://localhost:8080/?demo`.

## Isi folder

| File | Fungsi |
|---|---|
| `server.js` | Backend: langganan MQTT, simpan riwayat ke `data/`, kirim waktu ke `grainsense/time` tiap 60 s, ekspor CSV, teruskan perintah |
| `simulator.js` | Pengganti ESP32 selama hardware diperbaiki (format JSON & logika aerasi sama dengan firmware) |
| `public/` | Tampilan dashboard (HTML, CSS, JS) |
| `public/inti.js` | Logika riwayat, ringkasan, peringatan, CSV (dipakai server & demo) |
| `public/sim-inti.js` | Logika simulator ESP32 (dipakai `simulator.js` & demo) |
| `public/demo.js` | Mode demo tanpa server untuk GitHub Pages |
| `jalankan.bat` / `autostart.bat` | Menyalakan semua sekaligus / memasang ke startup Windows |
| `mosquitto.conf` | Konfigurasi broker |

## 1. Install (sekali saja)

1. Install **Node.js LTS**: https://nodejs.org (cek: `node -v`)
2. Install **Mosquitto**: https://mosquitto.org/download (pilih Windows 64-bit, centang "Service" boleh).
3. Di PowerShell, masuk ke folder ini lalu install dependensi:
   ```powershell
   cd C:\Users\Muham\Downloads\GrainSense_Firmware_C\dashboard
   npm install
   ```
4. Buka firewall port 1883 (PowerShell **Run as Administrator**), supaya ESP32 bisa masuk:
   ```powershell
   New-NetFirewallRule -DisplayName "Mosquitto 1883" -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow
   ```

> Jika Mosquitto terpasang sebagai *service* Windows, matikan dulu (`net stop mosquitto`, admin) agar tidak bentrok port 1883 dengan langkah 2 di bawah.

## 2. Menjalankan (3 jendela PowerShell)

**Jendela 1 — broker**
```powershell
cd C:\Users\Muham\Downloads\GrainSense_Firmware_C\dashboard
& "C:\Program Files\mosquitto\mosquitto.exe" -c mosquitto.conf -v
```

**Jendela 2 — dashboard**
```powershell
cd C:\Users\Muham\Downloads\GrainSense_Firmware_C\dashboard
npm start
```
Buka **http://localhost:8080**. Dari HP yang tersambung ke hotspot laptop: `http://192.168.137.1:8080`.

**Jendela 3 — simulator** (hanya bila ESP32 belum siap)
```powershell
cd C:\Users\Muham\Downloads\GrainSense_Firmware_C\dashboard
npm run sim          # normal (durasi minimum 30 menit, seperti aslinya)
npm run sim:demo     # mode demo 60 detik + kirim 20 data backlog
```
Opsi tambahan: `node simulator.js --tanpa-gangguan` (tanpa gangguan sensor acak),
`node simulator.js --bocor` (massa turun pelan tanpa transaksi → menguji deteksi anomali stok setelah 30 menit).
Tekan **Ctrl+C** untuk "mematikan ESP" → dashboard menampilkan ESP32 offline.

> Jangan jalankan simulator bersamaan dengan ESP32 asli — keduanya memakai topik `grainsense/silo01/...`.

## 3. Pengaturan (opsional)

Variabel lingkungan sebelum `npm start`:
```powershell
$env:PORT = "8080"                          # port web
$env:MQTT_URL = "mqtt://127.0.0.1:1883"     # alamat broker
$env:LABEL_CO2 = "eCO₂"                     # bila sensor pengganti ENS160
$env:DAYA_BLOWER_W = "32"                   # daya blower untuk perkiraan energi (Wh)
$env:ANOMALI_G = "15"                       # selisih massa tanpa transaksi yang dianggap anomali
$env:DATA_DIR = "D:\grainsense-data"        # lokasi penyimpanan riwayat (default: folder data/)
npm start
```

## 4. Data & ekspor

- Riwayat tersimpan otomatis di `data/telemetri.jsonl` dan `data/kejadian.jsonl` selama `server.js` berjalan, walau browser ditutup (untuk uji stabilitas 3 hari).
- Tombol **Ekspor CSV** → pilih telemetri / log kejadian dan rentang (1 jam, 24 jam, 3 hari, semua).
  Kolom `simulasi` = 1 menandai data simulasi; `sumber` = `backlog` menandai data yang dikirim ESP setelah sempat offline.
- Membuka CSV di Excel berbahasa Indonesia: **Data → From Text/CSV**, pemisah *Comma*, agar angka desimal terbaca benar.
- Untuk mulai bersih (mis. sebelum uji 3 hari): matikan server, hapus isi folder `data/`, nyalakan lagi.

## 5. Fitur dashboard

- Kartu real-time: suhu & RH dalam, CO₂, massa (stabil / bergerak / beku), udara masuk, kadar air (gauge), status blower + alasan keputusan, mode AUTO / MANUAL / DEMO.
- Kesehatan sensor + status ESP32 online/offline + RSSI + waktu aktif.
- Grafik riwayat 1 jam / 24 jam / 3 hari (suhu, RH, CO₂, massa), arsir periode blower ON, arsir oranye periode simulasi, garis ambang Tabel 3.5, dan **proyeksi** regresi linear (bukan klaim AI).
- **Peringatan & Prioritas** (Gambar 3.5): peringatan aktif/selesai diurutkan menurut prioritas, lengkap dengan pemicu dan tindakan sistem (Tabel 3.4).
- **Aerasi Hari Ini** (Gambar 3.4, Tabel 2.4): jumlah siklus, menit ON, daftar siklus + alasan, perkiraan energi, dan pembanding kemarin.
- **Stok Hari Ini** (Gambar 3.3): perubahan bersih, total masuk/keluar, dan **deteksi anomali stok** (perubahan massa tanpa transaksi).
- **Kelompok gabah** (batch): kode, tanggal masuk, dan asal tampil di kepala halaman; kodenya ikut tercatat di CSV (kolom `kelompok`).
- Penanda usia data ("pembaruan X dtk lalu").
- Log kejadian (blower, transaksi, mode, peringatan, perintah) dengan filter.
- Kontrol AUTO / MANUAL ON (pilih menit) / MANUAL OFF / DEMO / TARA / sinkron waktu / perintah lanjutan — semua dengan konfirmasi.
- Panel simulasi + skenario siap pakai; banner **MODE SIMULASI** mencolok bila `simulasi:true`.
- Banner alarm bila `alarm_co2` atau `prioritas: "tinggi"`.

## 6. Masalah umum

| Gejala | Solusi |
|---|---|
| Chip "Broker MQTT putus" | Mosquitto belum jalan / port 1883 dipakai service lain |
| ESP32 tidak pernah online | Cek firewall 1883, hotspot laptop aktif, `MQTT_HOST` di firmware = `192.168.137.1` |
| "Waktu ESP BELUM sinkron" | Tunggu ≤ 60 s atau klik **Sinkron Waktu** |
| Grafik kosong | Data belum ada pada rentang itu; pilih 1 jam & tunggu beberapa detik |
