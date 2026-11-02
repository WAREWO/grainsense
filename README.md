# GrainSense

Prototipe silo gabah IoT dengan **monitoring stok, kadar air, CO₂, suhu & kelembapan** serta **kendali aerasi adaptif**.
Final Telepati 8.0 AgroIoT Innovation Challenge — tim *berat bersih 500 ML* (FQU1U5), Universitas Pendidikan Indonesia.

**Demo online:** halaman GitHub Pages repo ini (lihat bagian *About* → tautan Pages).
Demo berjalan sepenuhnya di browser dengan **data simulasi berlabel DEMO**, bukan data sensor sungguhan.

```
ESP32 (firmware) --WiFi hotspot--> Mosquitto (laptop) --> server.js --> dashboard (browser)
                                        ^                      |
                                        +---- perintah --------+
```

## Isi repo

| Folder / file | Isi |
|---|---|
| `GrainSense_Firmware_C.ino` | Firmware ESP32: baca sensor, logika aerasi Tabel 3.5, MQTT, buffer offline |
| `rahasia.contoh.h` | Contoh kredensial Wi-Fi. Salin menjadi `rahasia.h` lalu isi (file itu tidak di-upload) |
| `dashboard/` | Dashboard lokal (Node.js): server, simulator ESP32, tampilan web — lihat [dashboard/README.md](dashboard/README.md) |
| `.github/workflows/pages.yml` | Memasang mode demo dashboard ke GitHub Pages |

## Firmware

1. Arduino IDE, board **ESP32 Dev Module**. Library: *Adafruit SHT31*, *HX711 (Bogdan Necula)*, *PubSubClient*.
2. Salin `rahasia.contoh.h` → `rahasia.h`, isi nama & password Mobile Hotspot laptop (2.4 GHz).
3. Upload. Serial Monitor 115200, ketik `help` untuk daftar perintah.

## Dashboard (di laptop, tanpa internet)

```powershell
cd dashboard
npm install
.\jalankan.bat          # hotspot + Mosquitto + dashboard -> http://localhost:8080
.\jalankan.bat -Simulator   # bila ESP32 belum siap
```

Detail instalasi Mosquitto, autostart, ekspor CSV, dan simulator ada di [dashboard/README.md](dashboard/README.md).
