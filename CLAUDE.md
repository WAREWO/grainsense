# GrainSense — Konteks Proyek Dashboard

> Taruh file ini di root folder proyek dashboard (nama file `CLAUDE.md`) agar Claude Code langsung paham konteksnya.
> Bahasa UI dashboard: **Bahasa Indonesia**. Penjelasan ke pengguna: bahasa Indonesia santai, langkah demi langkah.

## 1. Tentang proyek

- **GrainSense**: prototipe silo gabah IoT (wadah galon PET 19 L) untuk **Final Telepati 8.0 AgroIoT Innovation Challenge**.
- Final: **Sabtu, 7 November 2026**, luring di POLBAN Bandung. Tim "berat bersih 500 ML" (kode FQU1U5). Dikerjakan sendirian oleh Riyu.
- Laptop: **Windows**. Dashboard berjalan di laptop ini, di jaringan lokal (jangan bergantung pada internet saat demo).

## 2. Arsitektur

```
ESP32 (firmware GrainSense) --WiFi--> Hotspot laptop Windows (192.168.137.1)
        |                                   |
        +---- MQTT 1883 ----> Mosquitto (di laptop) ----> Dashboard (dibuat di proyek ini)
                                            ^                     |
                                            +---- perintah -------+  (topik .../cmd)
```

- Broker: **Mosquitto di Windows**. Firmware memakai `MQTT_HOST = "192.168.137.1"` (IP default Mobile Hotspot Windows), port 1883, tanpa auth.
- Rencana awal dashboard: Node-RED. Boleh diganti web app sendiri (mis. Node.js + mqtt.js + Chart.js/WebSocket) bila lebih cocok. Yang penting: riwayat data tersimpan walau browser ditutup (untuk uji stabilitas 3 hari dan laporan).

### Setup Mosquitto (Windows)
`mosquitto.conf`:
```
listener 1883 0.0.0.0
allow_anonymous true
# opsional, kalau browser mau langsung konek MQTT:
listener 9001
protocol websockets
```
Jalankan: `mosquitto -c mosquitto.conf -v`
Firewall (PowerShell admin):
```
New-NetFirewallRule -DisplayName "Mosquitto 1883" -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow
```

## 3. Kontrak MQTT (sesuai firmware — JANGAN diubah tanpa mengubah firmware)

`SILO_ID = "silo01"`. Basis topik: `grainsense/silo01/`

| Topik | Arah | Isi |
|---|---|---|
| `grainsense/silo01/telemetry` | ESP → | JSON tiap **5 detik** |
| `grainsense/silo01/event` | ESP → | JSON kejadian |
| `grainsense/silo01/backlog` | ESP → | JSON data tersimpan saat offline (snapshot tiap 30 s, maks 360 = 3 jam), dikirim saat tersambung lagi |
| `grainsense/silo01/status` | ESP → | `online` / `offline` (retained; `offline` via Last Will) |
| `grainsense/silo01/cmd` | → ESP | teks perintah biasa (lihat §5) |
| `grainsense/time` | → ESP | epoch detik (teks angka), untuk sinkron waktu. **Dashboard/backend wajib publish ini berkala (mis. tiap 60 s)** karena ESP tidak punya internet/NTP. |

### Telemetry (contoh)
```json
{
  "silo":"silo01","t":1793500000,"up":3600,
  "mode":"AUTO","simulasi":false,"demo":false,
  "massa_g":512,"massa_beku":false,"massa_stabil":true,
  "t_dalam":33.3,"rh_dalam":70.1,"t_masuk":32.0,"rh_masuk":73.0,
  "co2":850,"kap_adc":3108,"kadar_air":14.2,
  "blower":false,"butuh_aerasi":true,"udara_layak":false,
  "alasan":"Blower DITUNDA: aerasi perlu (suhu ruang 33.3 C) tetapi udara masuk tidak layak (...)",
  "prioritas":"normal",
  "alarm_co2":false,
  "sensor":{"sht_dalam":"ok","sht_masuk":"ok","co2":"pemanasan","hx711":"ok","kapasitif":"belum_kalibrasi"},
  "rssi":-55
}
```
Catatan:
- Nilai bisa `null` bila sensor gangguan/belum ada.
- `t` = **0** bila waktu belum tersinkron → pakai waktu terima di server.
- Status sensor: `ok` | `pemanasan` | `belum_kalibrasi` | `gangguan`.
- `prioritas`: `normal` | `waspada` (ada sensor gangguan) | `tinggi` (CO2 > 3000 atau penyimpangan bertahan).
- `simulasi:true` → sebagian nilai berasal dari perintah `sim`. **Dashboard wajib menandai data ini jelas sebagai SIMULASI** (kejujuran ke juri).
- `kadar_air` hanya valid setelah kalibrasi kapasitif; `kap_adc` = ADC mentah.

### Backlog (contoh)
```json
{"silo":"silo01","t":1793499000,"umur_s":1800,"t_dalam":33.1,"rh_dalam":70.0,"t_masuk":31.9,"rh_masuk":72.5,
 "co2":840,"massa_g":510,"kap_adc":3100,"blower":false,"simulasi":false}
```
Gabungkan ke riwayat sesuai `t` (jika `t`=0, perkirakan = waktu terima − `umur_s`).

### Event
Format umum: `{"silo":"silo01","t":<epoch>,"jenis":"<jenis>","data":{...}}`

| jenis | data |
|---|---|
| `blower` | `{"blower":true,"mode":"AUTO","alasan":"..."}` |
| `transaksi` | `{"delta_g":-24,"massa_g":488,"arah":"keluar"}` (perubahan massa ≥ 20 g) |
| `mode` | `{"mode":"AUTO"}` atau `{"mode":"MANUAL","blower":true,"menit":10}` |
| `manual_timeout` | `{"pesan":"..."}` |
| `simulasi` | `{"aktif":true,"co2":1800}` / `{"aktif":false}` |
| `demo` | `{"aktif":true}` |
| `tara` | `{"offset":12345}` |
| `online` | `{"buffer":12}` |

## 4. Logika aerasi (Tabel 3.5 proposal) — untuk ditampilkan/dijelaskan di dashboard
- Blower ON bila **T_dalam ≥ 28 °C**, atau **CO₂ ≥ 1500 ppm bertahan 30 menit**,
  **dan** udara masuk layak: **RH_masuk ≤ 70 %** dan **≥ 3 °C lebih dingin** dari T_dalam.
- Blower OFF bila **T_dalam ≤ 25 °C** atau **RH_masuk > 75 %**.
- Minimal ON 30 menit, minimal OFF 30 menit. **Mode demo** memendekkan semua durasi jadi 60 detik.
- Alarm pemeriksaan manual: **CO₂ > 3000 ppm**.
- Massa dibekukan saat blower ON dan 15 s setelahnya (getaran).
- Mode manual punya batas waktu (default 10, maks 30 menit) lalu kembali AUTO.

## 5. Perintah ke ESP (publish teks ke `grainsense/silo01/cmd`)
- `auto` · `manual on [menit]` · `manual off`
- `demo on` · `demo off`
- `sim tdalam|rhdalam|tmasuk|rhmasuk|co2 <nilai>` · `sim off`
- `tara` · `status` · `scan`
- Kalibrasi (sebaiknya lewat Serial, tapi juga bisa MQTT): `kal hx nol`, `kal hx <gram>`, `kal kap <persen>|list|hitung|reset`, `kal sht <menit>|batal|reset`, `kal co2 abc|nol ya`, `kal lihat`

## 6. Kebutuhan dashboard
1. **Kartu real-time**: T & RH dalam, T & RH udara masuk, CO₂, massa (+ tanda "bergerak"/"beku"), kadar air, status blower + **alasan** keputusan, mode (AUTO/MANUAL/DEMO).
2. **Panel kesehatan sensor** (ok/pemanasan/belum kalibrasi/gangguan) + status ESP online/offline + RSSI.
3. **Grafik riwayat** (suhu, RH, CO₂, massa) dengan rentang waktu (1 jam / 24 jam / 3 hari); arsir periode blower ON.
4. **Log kejadian** (blower, transaksi massa, mode, alarm) dengan waktu.
5. **Kontrol**: tombol AUTO, MANUAL ON (pilih menit), MANUAL OFF, DEMO on/off, TARA, panel simulasi. Konfirmasi sebelum kirim.
6. **Penanda SIMULASI** yang mencolok bila `simulasi:true`.
7. **Banner alarm** bila `alarm_co2` atau `prioritas:"tinggi"`.
8. **Simpan riwayat** ke file (SQLite/CSV) + tombol **ekspor CSV** untuk laporan & uji Tabel 3.6 / uji stabilitas 3 hari.
9. **Publisher waktu** ke `grainsense/time` tiap 60 s.
10. Opsional (nilai tambah): proyeksi tren sederhana (mis. regresi linear suhu/CO₂ ke depan) dengan label "proyeksi", bukan klaim AI.

## 7. Status perangkat keras saat ini (30 Okt 2026) — PENTING
- Terjadi korsleting: **MH-Z19C rusak** (Vin–GND korsleting, bacaan mentok 5000 ppm). Pengganti CO₂ **belum diputuskan**: MH-Z19C baru / **SCD41** (I2C 0x62) / **ENS160** (eCO₂/VOC, I2C 0x52/0x53) / simulasi. Dashboard sebaiknya tidak mengunci nama sensor; label "CO₂" bisa perlu jadi "eCO₂" bila ENS160.
- ESP32 sedang diperiksa (mungkin selamat, mungkin diganti). MOSFET & XL4015 dicurigai rusak. Rencana daya baru: ESP disuplai **charger HP via USB**, PSU 12 V khusus blower.
- **Karena hardware belum siap, buat juga skrip SIMULATOR** yang mem-publish telemetry/event/status palsu dengan format persis di atas (nilai realistis: T 25–35 °C, RH 60–80 %, CO₂ 600–3500, massa ~500 g, sesekali transaksi & blower ON/OFF mengikuti logika §4), dan merespons perintah di `.../cmd`. Dengan begitu dashboard bisa dikembangkan & diuji tanpa ESP.

## 8. Cara kerja yang diharapkan
- Jelaskan langkah demi langkah, dengan perintah yang bisa langsung dijalankan di Windows (PowerShell/CMD).
- Utamakan solusi sederhana yang stabil untuk demo; hindari dependensi cloud.
- Sertakan README singkat: cara install, menjalankan broker, simulator, dan dashboard.
