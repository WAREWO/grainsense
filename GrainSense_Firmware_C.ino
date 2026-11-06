// =====================================================================
//  GrainSense - Firmware prototipe 1 silo (Telepati 8.0)
// ---------------------------------------------------------------------
//  Isi:
//   - Baca semua sensor + cek validitas (rentang wajar, usia data)
//   - Kalibrasi dibaca dari memori (hasil sketch GrainSense_Kalibrasi)
//   - Logika aerasi sesuai Tabel 3.5 proposal + alasan keputusan
//   - Mode AUTO / MANUAL (dengan batas waktu) / SIMULASI (berlabel)
//   - Penimbangan: transaksi >= 20 g, massa dibekukan saat blower nyala
//   - MQTT ke broker di laptop + buffer saat offline + sinkron waktu
//   - Perintah tes lewat Serial Monitor (ketik "help")
//
//  Library (Library Manager):
//   - "Adafruit SHT31 Library" (+ Adafruit BusIO)
//   - "HX711 Arduino Library" oleh Bogdan Necula
//   - "PubSubClient" oleh Nick O'Leary
//  Board: ESP32 Dev Module. Serial Monitor 115200, line ending "Newline".
// =====================================================================

#include <WiFi.h>
#include <Wire.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <Adafruit_SHT31.h>
#include <HX711.h>
#include <time.h>

// ============================ KONFIGURASI ============================
#include "rahasia.h"
const char* MQTT_HOST = "192.168.137.1";    // <-- IP laptop yang menjalankan Mosquitto
const uint16_t MQTT_PORT = 1883;
const char* SILO_ID   = "silo01";

// Pin (sesuai PDF wiring & Tabel 3.2)
#define PIN_SDA     21
#define PIN_SCL     22
#define PIN_HX_DT   16   // RX2
#define PIN_HX_SCK  17   // TX2
#define PIN_KAP     34
#define PIN_CO2_RX  4    // ke TX MH-Z19C
#define PIN_CO2_TX  15   // ke RX MH-Z19C
#define PIN_BLOWER  26   // TRIG/PWM modul MOSFET

// Ambang Tabel 3.5
struct Ambang {
  float tNyala      = 28.0;   // blower hidup jika suhu ruang simpan >= 28 C
  float tMati       = 25.0;   // ... mati jika <= 25 C (histeresis 3 C)
  int   co2Nyala    = 1500;   // blower hidup jika CO2 >= 1500 ppm selama >= 5 detik
  int   co2Lepas    = 1200;   // kebutuhan karena CO2 dianggap selesai di bawah ini
  int   co2Alarm    = 3000;   // alarm pemeriksaan manual
  float rhMasukMaks = 70.0;   // syarat udara masuk: RH <= 70 %
  float rhMasukMati = 75.0;   // blower mati jika RH udara masuk > 75 % (histeresis 5)
  float dtMin       = 3.0;    // udara masuk minimal 3 C lebih dingin
  float dtLepas     = 0.0;    // dianggap tidak layak lagi bila tidak lebih dingin sama sekali
  // PRIORITAS 1: gabah lembap -> blower nyala (dijaga supaya tidak busuk)
  float kaNyala       = 18.0;  // kadar air >= 18 % (bertahan) -> mode lembap
  float kaLepas       = 16.0;  // mode lembap selesai bila kadar air < 16 % (histeresis 2 poin)
  float kaMaksWajar   = 40.0;  // di atas ini dianggap bacaan sensor tidak wajar (diabaikan)
  float rhMasukBasah  = 85.0;  // pengaman: udara masuk lebih basah dari ini tidak ditiupkan (isi 100 untuk mematikan)
} amb;

// Durasi (detik). Mode demo memendekkan durasi; status demo dikirim di telemetri.
const uint32_t DUR_NORMAL_S = 3;          // dipersingkat dari 30 menit (Tabel 3.5); kembalikan: 30UL * 60
uint32_t DUR_MIN_NYALA_S   = DUR_NORMAL_S;
uint32_t DUR_MIN_MATI_S    = DUR_NORMAL_S;
uint32_t DUR_CO2_BERTAHAN_S = DUR_NORMAL_S;
uint32_t DUR_KA_BERTAHAN_S  = DUR_NORMAL_S; // jeda nyala saat gabah lembap & jeda mati saat sudah turun (hindari bacaan sesaat)
const uint32_t DEMO_DURASI_S = DUR_NORMAL_S;
const uint32_t DUR_PENYIMPANGAN_S = 60UL * 60;   // blower nyala terus selama ini = penyimpangan bertahan
const uint32_t MANUAL_DEFAULT_DETIK = 5;
const uint32_t MANUAL_MAKS_MENIT    = 30;

const uint32_t INTERVAL_BACA_MS   = 2000;
const uint32_t INTERVAL_KIRIM_MS  = 5000;
const uint32_t INTERVAL_BUFFER_MS = 30000;
const uint32_t PEMANASAN_CO2_MS   = 180000;   // 3 menit
const uint32_t BEKU_SETELAH_MS    = 15000;    // massa tetap beku 15 s setelah blower mati
const int      TRANSAKSI_G        = 20;       // Tabel 3.6

// ============================== OBJEK ===============================
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
Adafruit_SHT31 shtDalam = Adafruit_SHT31();
Adafruit_SHT31 shtMasuk = Adafruit_SHT31();
HX711 scale;
Preferences prefs;

String TOPIK_BASE, TOPIK_TELEM, TOPIK_EVENT, TOPIK_BACKLOG, TOPIK_STATUS, TOPIK_CMD;
const char* TOPIK_WAKTU = "grainsense/time";

// ============================ KALIBRASI =============================
struct Kalibrasi {
  float tOff = 0, hOff = 0;
  long  hxOff = 0; float hxScl = 1; bool hxOk = false;
  float kapA = 0, kapB = 0; bool kapOk = false;
} kal;

void muatKalibrasi() {
  prefs.begin("grainsense", true);
  kal.tOff  = prefs.getFloat("tOff", 0);
  kal.hOff  = prefs.getFloat("hOff", 0);
  kal.hxOff = prefs.getLong("hxOff", 0);
  kal.hxScl = prefs.getFloat("hxScl", 1);
  kal.hxOk  = prefs.getBool("hxOk", false);
  kal.kapA  = prefs.getFloat("kapA", 0);
  kal.kapB  = prefs.getFloat("kapB", 0);
  kal.kapOk = prefs.getBool("kapOk", false);
  prefs.end();
}

void simpanKalibrasi() {
  prefs.begin("grainsense", false);
  prefs.putFloat("tOff", kal.tOff);   prefs.putFloat("hOff", kal.hOff);
  prefs.putLong("hxOff", kal.hxOff);  prefs.putFloat("hxScl", kal.hxScl); prefs.putBool("hxOk", kal.hxOk);
  prefs.putFloat("kapA", kal.kapA);   prefs.putFloat("kapB", kal.kapB);   prefs.putBool("kapOk", kal.kapOk);
  prefs.end();
  Serial.println(">> Kalibrasi tersimpan di memori ESP32.");
}

void simpanOffsetTara() {
  prefs.begin("grainsense", false);
  prefs.putLong("hxOff", kal.hxOff);
  prefs.end();
}

// ========================== STATUS SENSOR ===========================
enum StatusSensor { S_OK, S_PEMANASAN, S_GANGGUAN, S_BELUM_KAL };
const char* namaStatus(int s) {
  switch (s) {
    case S_OK: return "ok";
    case S_PEMANASAN: return "pemanasan";
    case S_BELUM_KAL: return "belum_kalibrasi";
    default: return "gangguan";
  }
}

struct DataSensor {
  float tDalam = NAN, rhDalam = NAN, tMasuk = NAN, rhMasuk = NAN;
  int   co2 = -1;
  float massa = NAN;          // gram (nilai stabil terakhir)
  bool  massaBeku = false;
  bool  massaStabil = false; // 3 pembacaan terakhir (6 detik) selisihnya <= 10 g
  int   kapAdc = -1;
  float kadarAir = NAN;
  StatusSensor sDalam = S_GANGGUAN, sMasuk = S_GANGGUAN, sCo2 = S_PEMANASAN, sHx = S_GANGGUAN, sKap = S_GANGGUAN;
  uint32_t msDalam = 0, msMasuk = 0, msCo2 = 0;   // waktu data valid terakhir
} d;

// nilai simulasi (NAN / -1 = tidak disimulasikan)
struct Simulasi {
  bool aktif = false;
  float tDalam = NAN, rhDalam = NAN, tMasuk = NAN, rhMasuk = NAN;
  int co2 = -1;
  float ka = NAN;
} sim;

bool adaDalam = false, adaMasuk = false;
int gagalDalam = 0, gagalMasuk = 0, gagalCo2 = 0;
uint32_t tBoot = 0;

// ============================ MH-Z19C ===============================
uint8_t ckCo2(const uint8_t* b) { uint8_t s = 0; for (int i = 1; i < 8; i++) s += b[i]; return 0xFF - s + 1; }

void kirimCo2(uint8_t cmd, uint8_t b3) {
  uint8_t b[9] = {0xFF, 0x01, cmd, b3, 0, 0, 0, 0, 0};
  b[8] = ckCo2(b);
  while (Serial2.available()) Serial2.read();
  Serial2.write(b, 9);
}

int bacaCo2Mentah() {
  kirimCo2(0x86, 0x00);
  uint8_t r[9];
  if (Serial2.readBytes(r, 9) != 9) return -1;
  if (r[0] != 0xFF || r[1] != 0x86 || ckCo2(r) != r[8]) return -1;
  return r[2] * 256 + r[3];
}

// ============================ BACA SENSOR ===========================
const int GAGAL_SHT_MAKS = 10;   // 10 x 2 s = 20 s gagal berturut-turut baru dianggap gangguan

bool wajarSuhu(float t) { return !isnan(t) && t > -10 && t < 70; }
bool wajarRh(float h)   { return !isnan(h) && h >= 0 && h <= 100; }

// ---- uji sandingan SHT31 (perintah: kal sht <menit>) ----
bool sandingAktif = false; uint32_t sandingSampai = 0; double sumDT = 0, sumDH = 0; int nSanding = 0;

void prosesSanding(float tD, float hD, float tM, float hM) {
  if (!sandingAktif) return;
  sumDT += tD - tM; sumDH += hD - hM; nSanding++;
  if ((int32_t)(millis() - sandingSampai) < 0) return;
  sandingAktif = false;
  if (nSanding < 10) { Serial.println(">> Sandingan: sampel terlalu sedikit, ulangi."); return; }
  kal.tOff = sumDT / nSanding; kal.hOff = sumDH / nSanding;
  Serial.printf(">> Sandingan selesai (%d sampel): offset sensor MASUK %+.2f C, %+.2f %%RH%s\n",
                nSanding, kal.tOff, kal.hOff,
                (fabs(kal.tOff) <= 0.3 && fabs(kal.hOff) <= 2.0) ? " (masih dalam toleransi pabrik)" : "");
  simpanKalibrasi();
}

void bacaSht() {
  // coba sambung ulang tiap pembacaan kalau sebelumnya hilang (sensor dicabut-pasang)
  if (!adaDalam) adaDalam = shtDalam.begin(0x44);
  if (!adaMasuk) adaMasuk = shtMasuk.begin(0x45);

  float t = adaDalam ? shtDalam.readTemperature() : NAN;
  float h = adaDalam ? shtDalam.readHumidity() : NAN;
  if (wajarSuhu(t) && wajarRh(h)) {
    d.tDalam = t; d.rhDalam = h; d.msDalam = millis(); gagalDalam = 0; d.sDalam = S_OK;
  } else {
    gagalDalam++;
    if (adaDalam) shtDalam.reset();                       // coba pulihkan sensor yang macet
    if (gagalDalam >= GAGAL_SHT_MAKS) { d.sDalam = S_GANGGUAN; adaDalam = false; }
  }

  float tDraw = t, hDraw = h;
  bool dalamValid = wajarSuhu(t) && wajarRh(h);
  t = adaMasuk ? shtMasuk.readTemperature() : NAN;
  h = adaMasuk ? shtMasuk.readHumidity() : NAN;
  if (dalamValid && wajarSuhu(t) && wajarRh(h)) prosesSanding(tDraw, hDraw, t, h);
  if (wajarSuhu(t) && wajarRh(h)) {
    d.tMasuk = t + kal.tOff;
    d.rhMasuk = constrain(h + kal.hOff, 0.0f, 100.0f);
    d.msMasuk = millis(); gagalMasuk = 0; d.sMasuk = S_OK;
  } else {
    gagalMasuk++;
    if (adaMasuk) shtMasuk.reset();
    if (gagalMasuk >= GAGAL_SHT_MAKS) { d.sMasuk = S_GANGGUAN; adaMasuk = false; }
  }
}

void bacaCo2() {
  int c = bacaCo2Mentah();
  if (c > 0 && c <= 10000) {
    d.co2 = c; d.msCo2 = millis(); gagalCo2 = 0;
    d.sCo2 = (millis() - tBoot < PEMANASAN_CO2_MS) ? S_PEMANASAN : S_OK;
  } else if (++gagalCo2 >= 3) {
    d.sCo2 = S_GANGGUAN;
  }
}

int bacaAdcRata(int n) {
  long s = 0;
  for (int i = 0; i < n; i++) { s += analogRead(PIN_KAP); delayMicroseconds(300); }
  return s / n;
}

int kapRiwayat[2]; int kapN = 0, kapI = 0;   // rata-rata bergerak 2 pembacaan (~4 detik)

void bacaKapasitif() {
  int mentah = bacaAdcRata(32);
  kapRiwayat[kapI] = mentah; kapI = (kapI + 1) % 2; if (kapN < 2) kapN++;
  long tot = 0; for (int i = 0; i < kapN; i++) tot += kapRiwayat[i];
  int adc = tot / kapN;
  d.kapAdc = adc;
  if (adc < 50 || adc > 4050) {           // 0 atau penuh: kabel lepas / korsleting
    d.sKap = S_GANGGUAN; d.kadarAir = NAN;
  } else if (kal.kapOk) {
    d.sKap = S_OK; d.kadarAir = kal.kapA * adc + kal.kapB;
  } else {
    d.sKap = S_BELUM_KAL; d.kadarAir = NAN;  // dashboard menampilkan angka mentah
  }
}

// ---- Penimbangan + transaksi ----
const int JENDELA_N = 3;
float jendela[JENDELA_N]; int nJendela = 0, iJendela = 0;
float massaTercatat = NAN;
uint32_t msBlowerMati = 0;
bool blowerNyala = false;

void kirimEvent(const String& jenis, const String& isiJson);   // deklarasi

void bacaMassa() {
  if (!scale.wait_ready_timeout(200)) { d.sHx = S_GANGGUAN; return; }
  if (!kal.hxOk) { d.sHx = S_BELUM_KAL; return; }
  d.sHx = S_OK;

  bool beku = blowerNyala || (millis() - msBlowerMati < BEKU_SETELAH_MS);
  d.massaBeku = beku;
  if (beku) { nJendela = 0; return; }       // getaran blower menaikkan derau

  float g = scale.get_units(3);
  d.massa = g;                              // nilai terkini selalu ditampilkan
  jendela[iJendela] = g; iJendela = (iJendela + 1) % JENDELA_N; if (nJendela < JENDELA_N) nJendela++;
  d.massaStabil = false;
  if (nJendela < JENDELA_N) return;

  float mn = jendela[0], mx = jendela[0], tot = 0;
  for (int i = 0; i < JENDELA_N; i++) { mn = min(mn, jendela[i]); mx = max(mx, jendela[i]); tot += jendela[i]; }
  if (mx - mn > 10) return;                 // masih bergerak: transaksi belum dihitung
  float stabil = tot / JENDELA_N;
  d.massa = stabil;
  d.massaStabil = true;

  if (isnan(massaTercatat)) { massaTercatat = stabil; return; }
  float delta = stabil - massaTercatat;
  // Kompensasi drift: perubahan kecil & pelan (< ambang transaksi) diserap ke angka acuan
  // sedikit demi sedikit, sehingga drift load cell tidak menumpuk jadi transaksi palsu.
  // Penambahan/pengambilan gabah sungguhan terjadi dalam beberapa detik, jadi tetap terdeteksi.
  if (fabs(delta) < TRANSAKSI_G) {
    massaTercatat += delta * 0.15f;
    return;
  }
  if (fabs(delta) >= TRANSAKSI_G) {
    char buf[96];
    snprintf(buf, sizeof(buf), "{\"delta_g\":%.0f,\"massa_g\":%.0f,\"arah\":\"%s\"}",
             delta, stabil, delta > 0 ? "masuk" : "keluar");
    kirimEvent("transaksi", buf);
    massaTercatat = stabil;
  }
}

// ============================ WAKTU =================================
// Laptop (Node-RED/skrip) mengirim epoch detik ke topik grainsense/time.
// Kalau ada internet, NTP juga dicoba. Sebelum sinkron, timestamp = 0.
int64_t epochOffset = 0;   // epoch = millis()/1000 + epochOffset
bool waktuSinkron = false;

uint32_t epochSekarang() {
  time_t now = time(nullptr);
  if (now > 1700000000) return (uint32_t)now;                  // dari NTP
  if (waktuSinkron) return (uint32_t)(millis() / 1000 + epochOffset);
  return 0;
}

uint32_t epochDariMillis(uint32_t ms) {
  uint32_t e = epochSekarang();
  if (e == 0) return 0;
  return e - (millis() - ms) / 1000;
}

// ============================ AERASI ================================
enum Mode { M_AUTO, M_MANUAL };
Mode mode = M_AUTO;
bool manualNyala = false;
uint32_t manualSampaiMs = 0;
bool modeDemo = false;

uint32_t msBlowerNyala = 0;
uint32_t msCo2MulaiTinggi = 0;   // 0 = CO2 sedang tidak tinggi
uint32_t msKaMulaiTinggi = 0;    // 0 = kadar air sedang tidak tinggi
uint32_t msKaTurun = 0;          // 0 = kadar air belum turun di bawah kaLepas
bool modeLembap = false;         // blower dinyalakan karena gabah lembap
bool tahanUdaraBasah = false;    // baru dimatikan karena udara sangat basah (cegah nyala-mati beruntun)
bool butuhAerasi = false, udaraLayak = false;
bool perluSetelahAerasi = false; // penyimpangan bertahan setelah satu siklus
String alasan = "Menunggu data sensor";
String prioritas = "normal";

// nilai yang dipakai logika (data asli atau simulasi)
float nTDalam() { return (sim.aktif && !isnan(sim.tDalam)) ? sim.tDalam : d.tDalam; }
float nRhDalam(){ return (sim.aktif && !isnan(sim.rhDalam)) ? sim.rhDalam : d.rhDalam; }
float nTMasuk() { return (sim.aktif && !isnan(sim.tMasuk)) ? sim.tMasuk : d.tMasuk; }
float nRhMasuk(){ return (sim.aktif && !isnan(sim.rhMasuk)) ? sim.rhMasuk : d.rhMasuk; }
int   nCo2()    { return (sim.aktif && sim.co2 >= 0) ? sim.co2 : d.co2; }
bool  okDalam() { return (sim.aktif && !isnan(sim.tDalam)) || (d.sDalam == S_OK && millis() - d.msDalam < 30000); }
bool  okMasuk() { return (sim.aktif && !isnan(sim.tMasuk) && !isnan(sim.rhMasuk)) || (d.sMasuk == S_OK && millis() - d.msMasuk < 30000); }
bool  okCo2()   { return (sim.aktif && sim.co2 >= 0) || (d.sCo2 == S_OK && millis() - d.msCo2 < 30000); }

void setBlower(bool on, const String& sebab) {
  if (on == blowerNyala) return;
  blowerNyala = on;
  digitalWrite(PIN_BLOWER, on ? HIGH : LOW);
  if (on) msBlowerNyala = millis(); else msBlowerMati = millis();
  char buf[220];
  snprintf(buf, sizeof(buf), "{\"blower\":%s,\"mode\":\"%s\",\"alasan\":\"%s\"}",
           on ? "true" : "false", mode == M_AUTO ? "AUTO" : "MANUAL", sebab.c_str());
  kirimEvent("blower", buf);
  Serial.printf(">> Blower %s: %s\n", on ? "NYALA" : "MATI", sebab.c_str());
}

String f1(float v) { char b[12]; snprintf(b, sizeof(b), "%.1f", v); return String(b); }

void evaluasiAerasi() {
  uint32_t now = millis();

  // ---- mode manual ----
  if (mode == M_MANUAL) {
    if ((int32_t)(now - manualSampaiMs) >= 0) {
      mode = M_AUTO;
      kirimEvent("manual_timeout", "{\"pesan\":\"Batas waktu mode manual habis, kembali ke AUTO\"}");
      setBlower(false, "Batas waktu manual habis");
    } else {
      setBlower(manualNyala, manualNyala ? "Perintah manual operator" : "Perintah manual operator (mati)");
      uint32_t sisaDetik = (manualSampaiMs - now) / 1000 + 1;
      alasan = String("MANUAL: blower ") + (manualNyala ? "nyala" : "mati") + ", sisa " +
               (sisaDetik < 60 ? String(sisaDetik) + " detik" : String(sisaDetik / 60 + 1) + " menit");
      return;
    }
  }

  // ---- validitas data penting ----
  if (!okDalam() || !okMasuk()) {
    butuhAerasi = false; udaraLayak = false;
    setBlower(false, "Data suhu/kelembapan tidak valid");
    alasan = String("Keputusan otomatis dihentikan: ") +
             (!okDalam() ? "SHT31 ruang dalam " : "") + (!okMasuk() ? "SHT31 udara masuk " : "") +
             "gangguan. Prosedur cadangan: pemeriksaan manual.";
    prioritas = "tinggi";
    return;
  }

  float tD = nTDalam(), tM = nTMasuk(), rhM = nRhMasuk();
  int co2 = nCo2();
  bool co2Valid = okCo2();

  // ---- CO2 bertahan ----
  if (co2Valid && co2 >= amb.co2Nyala) {
    if (msCo2MulaiTinggi == 0) msCo2MulaiTinggi = now;
  } else if (!co2Valid || co2 < amb.co2Lepas) {
    msCo2MulaiTinggi = 0;
  }
  bool co2Bertahan = msCo2MulaiTinggi && (now - msCo2MulaiTinggi) / 1000 >= DUR_CO2_BERTAHAN_S;

  // ================= PRIORITAS 1: GABAH LEMBAP =================
  // Gabah lembap/basah -> blower dinyalakan lebih dulu, tanpa menunggu syarat suhu/CO2
  // maupun syarat "udara 3 C lebih dingin". Satu-satunya pengaman: udara masuk yang
  // sangat basah (RH > rhMasukBasah) tidak ditiupkan karena justru menambah air.
  bool kaSim = sim.aktif && !isnan(sim.ka);
  float ka = kaSim ? sim.ka : d.kadarAir;
  bool kaValid = (kaSim || d.sKap == S_OK) && !isnan(ka) && ka > 0 && ka < amb.kaMaksWajar;
  if (kaValid && ka >= amb.kaNyala) {
    if (msKaMulaiTinggi == 0) msKaMulaiTinggi = now;
  } else if (!kaValid || ka < amb.kaLepas) {
    msKaMulaiTinggi = 0;
  }
  bool kaBertahan = msKaMulaiTinggi && (now - msKaMulaiTinggi) / 1000 >= DUR_KA_BERTAHAN_S;
  bool butuhLembap = modeLembap ? (kaValid && ka >= amb.kaLepas) : kaBertahan;
  bool udaraTerlaluBasah = rhM > amb.rhMasukBasah;
  {
    uint32_t lamaM = (now - msBlowerMati) / 1000;
    bool alarmCo2 = co2Valid && co2 > amb.co2Alarm;
    String sKa = kaValid ? "kadar air " + f1(ka) + "%" : String("kadar air n/a");
    if (butuhLembap) {
      msKaTurun = 0;
      butuhAerasi = true; udaraLayak = !udaraTerlaluBasah;
      if (!blowerNyala) {
        if (udaraTerlaluBasah) {
          alasan = "PRIORITAS LEMBAP: " + sKa + " >= " + f1(amb.kaNyala) + "%, tetapi udara masuk sangat basah (RH " +
                   f1(rhM) + "% > " + f1(amb.rhMasukBasah) + "%), blower ditahan agar gabah tidak bertambah basah";
        } else if (tahanUdaraBasah && lamaM < DUR_MIN_MATI_S) {
          alasan = "PRIORITAS LEMBAP: " + sKa + ", menunggu durasi minimum mati (" + String(DUR_MIN_MATI_S - lamaM) + " detik lagi)";
        } else {
          modeLembap = true;
          tahanUdaraBasah = false;
          setBlower(true, "Gabah lembap (" + sKa + ")");
          alasan = "Blower nyala - PRIORITAS LEMBAP: " + sKa + " >= " + f1(amb.kaNyala) + "%, udara masuk RH " + f1(rhM) + "%";
        }
      } else {
        modeLembap = true;
        if (udaraTerlaluBasah) {
          modeLembap = false;
          tahanUdaraBasah = true;
          setBlower(false, "Udara masuk sangat basah (RH " + f1(rhM) + "%)");
          alasan = "Blower mati: udara masuk sangat basah (RH " + f1(rhM) + "% > " + f1(amb.rhMasukBasah) + "%), " + sKa;
        } else {
          alasan = "Blower nyala - PRIORITAS LEMBAP: " + sKa + " (berhenti bila < " + f1(amb.kaLepas) + "%)";
        }
      }
      prioritas = alarmCo2 ? "tinggi" : "waspada";
      return;
    }
    if (modeLembap && blowerNyala) {
      // kadar air sudah turun di bawah kaLepas
      if (msKaTurun == 0) msKaTurun = now;
      uint32_t lamaTurun = (now - msKaTurun) / 1000;
      if (lamaTurun < DUR_KA_BERTAHAN_S) {
        alasan = "Gabah tidak lembap lagi (" + sKa + "), blower mati dalam " + String(DUR_KA_BERTAHAN_S - lamaTurun) + " detik";
        prioritas = alarmCo2 ? "tinggi" : "normal";
        return;
      }
      modeLembap = false;
      msKaTurun = 0;
      setBlower(false, "Gabah tidak lembap lagi (" + sKa + ")");
      alasan = "Blower mati: gabah tidak lembap lagi (" + sKa + "), kembali ke aturan suhu/CO2";
      prioritas = alarmCo2 ? "tinggi" : "normal";
      return;
    }
    modeLembap = false;
  }
  // ============ PRIORITAS 2: MENJAGA (aturan Tabel 3.5) ============

  // ---- kebutuhan aerasi (dengan histeresis) ----
  bool butuhSuhu = blowerNyala ? (tD > amb.tMati) : (tD >= amb.tNyala);
  bool butuhCo2  = blowerNyala ? (co2Valid && co2 >= amb.co2Lepas && msCo2MulaiTinggi) : co2Bertahan;
  butuhAerasi = butuhSuhu || butuhCo2;

  // ---- kelayakan udara masuk (dengan histeresis) ----
  float selisih = tD - tM;   // positif = udara masuk lebih dingin
  udaraLayak = blowerNyala ? (rhM <= amb.rhMasukMati && selisih > amb.dtLepas)
                           : (rhM <= amb.rhMasukMaks && selisih >= amb.dtMin);

  String detailMasuk = "udara masuk RH " + f1(rhM) + "%, " +
                       (selisih >= 0 ? f1(selisih) + " C lebih dingin" : f1(-selisih) + " C lebih HANGAT");
  String detailButuh = butuhSuhu ? ("suhu ruang " + f1(tD) + " C") : "";
  if (butuhCo2) detailButuh += String(detailButuh.length() ? " dan " : "") + "CO2 " + String(co2) + " ppm bertahan";

  uint32_t lamaNyala = (now - msBlowerNyala) / 1000;
  uint32_t lamaMati  = (now - msBlowerMati) / 1000;

  if (!blowerNyala) {
    if (butuhAerasi && udaraLayak) {
      if (msBlowerMati != 0 && lamaMati < DUR_MIN_MATI_S) {
        alasan = "Aerasi perlu & udara layak, menunggu durasi minimum mati (" +
                 String(DUR_MIN_MATI_S - lamaMati) + " detik lagi)";
      } else {
        String sebab = "Aerasi perlu (" + detailButuh + ") dan " + detailMasuk;
        setBlower(true, sebab);
        alasan = "Blower nyala: " + sebab;
      }
    } else if (butuhAerasi) {
      alasan = "Blower DITUNDA: aerasi perlu (" + detailButuh + ") tetapi udara masuk tidak layak (" + detailMasuk +
               "; syarat RH <= " + f1(amb.rhMasukMaks) + "% dan >= " + f1(amb.dtMin) + " C lebih dingin)";
    } else if (msCo2MulaiTinggi) {
      alasan = "CO2 " + String(co2) + " ppm >= " + String(amb.co2Nyala) + ", dipantau (" +
               String((now - msCo2MulaiTinggi) / 1000) + "/" + String(DUR_CO2_BERTAHAN_S) + " detik)";
    } else {
      alasan = "Kondisi stabil: suhu ruang " + f1(tD) + " C, CO2 " + (co2Valid ? String(co2) + " ppm" : String("n/a")) +
               ", aerasi tidak diperlukan";
    }
  } else {
    if (!udaraLayak) {
      // keputusan desain: udara basah/hangat dihentikan segera agar gabah tidak basah
      String sebab = "Udara masuk tidak layak lagi (" + detailMasuk + ")";
      perluSetelahAerasi = butuhAerasi;
      setBlower(false, sebab);
      alasan = "Blower mati: " + sebab;
    } else if (!butuhAerasi) {
      if (lamaNyala < DUR_MIN_NYALA_S) {
        alasan = "Kebutuhan aerasi selesai, menunggu durasi minimum nyala (" +
                 String(DUR_MIN_NYALA_S - lamaNyala) + " detik lagi)";
      } else {
        perluSetelahAerasi = false;
        setBlower(false, "Kebutuhan aerasi selesai (suhu ruang " + f1(tD) + " C)");
        alasan = "Blower mati: kebutuhan aerasi selesai";
      }
    } else {
      alasan = "Blower nyala: aerasi masih diperlukan (" + detailButuh + "), " + detailMasuk;
      // penyimpangan bertahan setelah satu siklus penuh aerasi
      if (lamaNyala >= DUR_PENYIMPANGAN_S) perluSetelahAerasi = true;
    }
  }

  // ---- prioritas pemeriksaan ----
  if ((co2Valid && co2 > amb.co2Alarm) || perluSetelahAerasi) prioritas = "tinggi";
  else if ((butuhAerasi && !udaraLayak) || (co2Valid && co2 >= amb.co2Nyala) ||
           d.sCo2 == S_GANGGUAN || d.sHx == S_GANGGUAN || d.sKap == S_GANGGUAN) prioritas = "waspada";
  else prioritas = "normal";
}

// ======================== TELEMETRI (JSON) ==========================
String angka(float v, int des) {
  if (isnan(v)) return "null";
  char b[16]; snprintf(b, sizeof(b), "%.*f", des, v); return String(b);
}

String jsonEscape(const String& s) {
  String o; o.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (c >= 32) o += c;
  }
  return o;
}

String buatTelemetri() {
  int co2 = nCo2();
  String j = "{";
  j += "\"silo\":\"" + String(SILO_ID) + "\",";
  j += "\"t\":" + String(epochSekarang()) + ",";
  j += "\"up\":" + String(millis() / 1000) + ",";
  j += "\"mode\":\"" + String(mode == M_AUTO ? "AUTO" : "MANUAL") + "\",";
  j += "\"simulasi\":" + String(sim.aktif ? "true" : "false") + ",";
  j += "\"demo\":" + String(modeDemo ? "true" : "false") + ",";
  j += "\"massa_g\":" + angka(d.massa, 0) + ",";
  j += "\"massa_beku\":" + String(d.massaBeku ? "true" : "false") + ",";
  j += "\"massa_stabil\":" + String(d.massaStabil ? "true" : "false") + ",";
  j += "\"t_dalam\":" + angka(nTDalam(), 1) + ",";
  j += "\"rh_dalam\":" + angka(nRhDalam(), 1) + ",";
  j += "\"t_masuk\":" + angka(nTMasuk(), 1) + ",";
  j += "\"rh_masuk\":" + angka(nRhMasuk(), 1) + ",";
  j += "\"co2\":" + (co2 >= 0 ? String(co2) : String("null")) + ",";
  j += "\"kap_adc\":" + String(d.kapAdc) + ",";
  j += "\"kadar_air\":" + angka((sim.aktif && !isnan(sim.ka)) ? sim.ka : d.kadarAir, 1) + ",";
  j += "\"blower\":" + String(blowerNyala ? "true" : "false") + ",";
  j += "\"butuh_aerasi\":" + String(butuhAerasi ? "true" : "false") + ",";
  j += "\"udara_layak\":" + String(udaraLayak ? "true" : "false") + ",";
  j += "\"mode_lembap\":" + String(modeLembap ? "true" : "false") + ",";
  j += "\"alasan\":\"" + jsonEscape(alasan) + "\",";
  j += "\"prioritas\":\"" + prioritas + "\",";
  j += "\"alarm_co2\":" + String((co2 > amb.co2Alarm) ? "true" : "false") + ",";
  j += "\"sensor\":{";
  j += "\"sht_dalam\":\"" + String(namaStatus(d.sDalam)) + "\",";
  j += "\"sht_masuk\":\"" + String(namaStatus(d.sMasuk)) + "\",";
  j += "\"co2\":\"" + String(namaStatus(d.sCo2)) + "\",";
  j += "\"hx711\":\"" + String(namaStatus(d.sHx)) + "\",";
  j += "\"kapasitif\":\"" + String(namaStatus(d.sKap)) + "\"},";
  j += "\"rssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
  j += "}";
  return j;
}

// ====================== BUFFER OFFLINE (RAM) ========================
struct Snap {
  uint32_t ms;
  int16_t tD, rhD, tM, rhM;   // x10
  int16_t co2;
  int32_t massa;              // gram, INT32_MIN = null
  int16_t adc;
  uint8_t flags;              // bit0 blower, bit1 simulasi, bit2 manual
};
const int BUF_N = 360;        // 360 x 30 s = 3 jam
Snap buf[BUF_N];
int bufKepala = 0, bufIsi = 0;

int16_t x10(float v) { return isnan(v) ? INT16_MIN : (int16_t)lroundf(v * 10); }
String dariX10(int16_t v) { return v == INT16_MIN ? String("null") : angka(v / 10.0f, 1); }

void simpanKeBuffer() {
  Snap& s = buf[(bufKepala + bufIsi) % BUF_N];
  if (bufIsi == BUF_N) bufKepala = (bufKepala + 1) % BUF_N; else bufIsi++;
  s.ms = millis();
  s.tD = x10(nTDalam()); s.rhD = x10(nRhDalam()); s.tM = x10(nTMasuk()); s.rhM = x10(nRhMasuk());
  s.co2 = nCo2();
  s.massa = isnan(d.massa) ? INT32_MIN : (int32_t)lroundf(d.massa);
  s.adc = d.kapAdc;
  s.flags = (blowerNyala ? 1 : 0) | (sim.aktif ? 2 : 0) | (mode == M_MANUAL ? 4 : 0);
}

void kirimBuffer() {           // dipanggil saat online; kirim maksimal 10 per putaran
  int n = 0;
  while (bufIsi > 0 && n < 10) {
    Snap& s = buf[bufKepala];
    String j = "{\"silo\":\"" + String(SILO_ID) + "\",\"t\":" + String(epochDariMillis(s.ms)) +
               ",\"umur_s\":" + String((millis() - s.ms) / 1000) +
               ",\"t_dalam\":" + dariX10(s.tD) + ",\"rh_dalam\":" + dariX10(s.rhD) +
               ",\"t_masuk\":" + dariX10(s.tM) + ",\"rh_masuk\":" + dariX10(s.rhM) +
               ",\"co2\":" + (s.co2 >= 0 ? String(s.co2) : String("null")) +
               ",\"massa_g\":" + (s.massa == INT32_MIN ? String("null") : String(s.massa)) +
               ",\"kap_adc\":" + String(s.adc) +
               ",\"blower\":" + String((s.flags & 1) ? "true" : "false") +
               ",\"simulasi\":" + String((s.flags & 2) ? "true" : "false") + "}";
    if (!mqtt.publish(TOPIK_BACKLOG.c_str(), j.c_str())) break;
    bufKepala = (bufKepala + 1) % BUF_N; bufIsi--; n++;
  }
}

// ========================== MQTT & WIFI ============================
void kirimEvent(const String& jenis, const String& isiJson) {
  String j = "{\"silo\":\"" + String(SILO_ID) + "\",\"t\":" + String(epochSekarang()) +
             ",\"jenis\":\"" + jenis + "\",\"data\":" + isiJson + "}";
  Serial.println("[event] " + j);
  if (mqtt.connected()) mqtt.publish(TOPIK_EVENT.c_str(), j.c_str());
}

void jalankanPerintah(String cmd, const char* sumber);   // deklarasi

void onMqtt(char* topik, byte* payload, unsigned int len) {
  String isi; isi.reserve(len);
  for (unsigned int i = 0; i < len; i++) isi += (char)payload[i];
  isi.trim();
  if (strcmp(topik, TOPIK_WAKTU) == 0) {
    uint32_t e = (uint32_t)strtoul(isi.c_str(), nullptr, 10);
    if (e > 1700000000UL) {
      epochOffset = (int64_t)e - (int64_t)(millis() / 1000);
      if (!waktuSinkron) Serial.println(">> Waktu tersinkron dari laptop");
      waktuSinkron = true;
    }
    return;
  }
  jalankanPerintah(isi, "mqtt");
}

uint32_t msCobaMqtt = 0, msCobaWifi = 0;

void jagaKoneksi() {
  if (WiFi.status() != WL_CONNECTED) {
    // ESP32 sudah mencoba menyambung sendiri (auto-reconnect). Firmware hanya
    // "menyenggol" tiap 30 detik, dan hanya kalau percobaan sebelumnya sudah gagal,
    // supaya tidak muncul error "sta is connecting".
    int st = WiFi.status();
    bool gagal = (st == WL_DISCONNECTED || st == WL_CONNECT_FAILED ||
                  st == WL_NO_SSID_AVAIL || st == WL_CONNECTION_LOST);
    if (gagal && millis() - msCobaWifi > 30000) {
      msCobaWifi = millis();
      WiFi.reconnect();
    }
    return;
  }
  if (!mqtt.connected() && millis() - msCobaMqtt > 5000) {
    msCobaMqtt = millis();
    String id = String("grainsense-") + SILO_ID + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    if (mqtt.connect(id.c_str(), TOPIK_STATUS.c_str(), 1, true, "offline")) {
      mqtt.publish(TOPIK_STATUS.c_str(), "online", true);
      mqtt.subscribe(TOPIK_CMD.c_str());
      mqtt.subscribe(TOPIK_WAKTU);
      Serial.printf(">> MQTT tersambung ke %s:%u (buffer %d data)\n", MQTT_HOST, MQTT_PORT, bufIsi);
      kirimEvent("online", "{\"buffer\":" + String(bufIsi) + "}");
    }
  }
}

// ============================ PERINTAH ==============================
// Sama untuk Serial dan MQTT (topik grainsense/<silo>/cmd), teks biasa.
void bantuan() {
  Serial.println(F("\nPerintah:"));
  Serial.println(F("  status               cetak telemetri lengkap"));
  Serial.println(F("  log on|off           tampilkan ringkasan tiap 5 detik"));
  Serial.println(F("  auto                 kembali ke mode otomatis"));
  Serial.println(F("  manual on [menit]    blower nyala manual (default 5 detik, maks 30 menit; 5d = 5 detik)"));
  Serial.println(F("  manual off [menit]   blower dipaksa mati"));
  Serial.println(F("  sim tdalam|rhdalam|tmasuk|rhmasuk|co2|ka <nilai>   isi nilai simulasi (ka = kadar air %)"));
  Serial.println(F("  sim off              matikan semua simulasi"));
  Serial.println(F("  demo on|off          durasi minimum & CO2 bertahan 5 detik"));
  Serial.println(F("  tara                 tara ulang timbangan (simpan ke memori)"));
  Serial.println(F("  abc off              matikan ABC MH-Z19C"));
  Serial.println(F("  scan                 scan I2C"));
  Serial.println(F("  wifi                 info koneksi"));
  Serial.println(F("  tes kap              ukur noise sensor kapasitif (20 pembacaan mentah)"));
  Serial.println(F("Kalibrasi:"));
  Serial.println(F("  kal hx nol           platform kosong -> catat titik nol"));
  Serial.println(F("  kal hx <gram>        beban acuan di tengah -> hitung faktor skala"));
  Serial.println(F("  kal kap <persen>     catat 1 titik (sensor tertancap di sampel, angka dari AR991)"));
  Serial.println(F("  kal kap list|hitung|reset"));
  Serial.println(F("  kal sht <menit>      uji sandingan SHT31 (default 10), kal sht batal|reset"));
  Serial.println(F("  kal co2 abc          matikan ABC;  kal co2 nol ya = titik nol (luar ruangan!)"));
  Serial.println(F("  kal lihat            tampilkan semua kalibrasi\n"));
}

bool logAktif = true;

// ======================= KALIBRASI LEWAT PERINTAH ===================
bool hxNolSiap = false;
float kapX[10], kapY[10]; int kapTitik = 0;

void lihatKalibrasi() {
  Serial.printf("SHT31 MASUK offset : %+.2f C, %+.2f %%RH\n", kal.tOff, kal.hOff);
  Serial.printf("HX711              : %s | offset %ld | faktor %.4f\n", kal.hxOk ? "OK" : "belum", kal.hxOff, kal.hxScl);
  Serial.printf("Kapasitif          : %s | kadar = %.6f x ADC + %.3f\n", kal.kapOk ? "OK" : "belum", kal.kapA, kal.kapB);
  Serial.printf("Titik kapasitif tercatat (belum dihitung): %d\n", kapTitik);
}

void kalibrasiHx(const String& arg) {
  if (!scale.wait_ready_timeout(500)) { Serial.println("HX711 tidak merespons. Cek DT/SCK/3V3/GND."); return; }
  if (arg == "nol") {
    kal.hxOk = false;                       // pembacaan massa dihentikan selama kalibrasi
    scale.set_scale(1.0);
    scale.tare(20);
    kal.hxOff = scale.get_offset();
    hxNolSiap = true;
    Serial.printf(">> Titik nol dicatat (offset %ld).\n", kal.hxOff);
    Serial.println("   Letakkan beban acuan di TENGAH platform, tunggu 5 detik, lalu ketik: kal hx <gram>");
    return;
  }
  float g = arg.toFloat();
  if (g <= 0) { Serial.println("Format: kal hx nol  lalu  kal hx <berat beban dalam gram>"); return; }
  if (!hxNolSiap) { Serial.println("Jalankan dulu: kal hx nol (dengan platform kosong)"); return; }
  double raw = scale.get_value(20);
  if (fabs(raw) < 100) { Serial.println("Perubahan terlalu kecil. Cek kabel load cell (E+/E-/A+/A-) dan posisi beban."); return; }
  kal.hxScl = raw / g;
  scale.set_scale(kal.hxScl);
  kal.hxOk = true; hxNolSiap = false;
  nJendela = 0; massaTercatat = NAN; d.massa = NAN;
  Serial.printf(">> Faktor skala %.4f. Cek: terbaca %.1f g (acuan %.1f g)%s\n", kal.hxScl, scale.get_units(10), g,
                kal.hxScl < 0 ? " | faktor negatif = kabel A+/A- terbalik, tetap bisa dipakai" : "");
  simpanKalibrasi();
  Serial.println("   Setelah dudukan + galon kosong terpasang nanti, cukup ketik: tara");
}

void kalibrasiKap(const String& arg) {
  if (arg == "reset") {
    kapTitik = 0; kal.kapOk = false; simpanKalibrasi();
    Serial.println(">> Titik dan persamaan kapasitif dihapus.");
    return;
  }
  if (arg == "list" || arg.length() == 0) {
    for (int i = 0; i < kapTitik; i++) Serial.printf("  %d) ADC %.0f  <->  %.1f %%\n", i + 1, kapX[i], kapY[i]);
    if (kapTitik == 0) Serial.println("  Belum ada titik. Format: kal kap <kadar air acuan %>");
    return;
  }
  if (arg == "hitung") {
    if (kapTitik < 2) { Serial.println("Butuh minimal 2 titik (disarankan 4-6)."); return; }
    double sx = 0, sy = 0, sxy = 0, sxx = 0; int n = kapTitik;
    for (int i = 0; i < n; i++) { sx += kapX[i]; sy += kapY[i]; sxy += kapX[i] * kapY[i]; sxx += kapX[i] * kapX[i]; }
    double pb = n * sxx - sx * sx;
    if (fabs(pb) < 1e-6) { Serial.println("Nilai ADC terlalu mirip, tidak bisa dihitung."); return; }
    double a = (n * sxy - sx * sy) / pb, b = (sy - a * sx) / n;
    double rata = sy / n, ssTot = 0, ssRes = 0;
    Serial.println("  ADC   | acuan % | model % | galat");
    for (int i = 0; i < n; i++) {
      double m = a * kapX[i] + b;
      ssRes += (kapY[i] - m) * (kapY[i] - m); ssTot += (kapY[i] - rata) * (kapY[i] - rata);
      Serial.printf("  %5.0f | %7.1f | %7.1f | %+.2f\n", kapX[i], kapY[i], m, kapY[i] - m);
    }
    double r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    double rmse = sqrt(ssRes / n);
    kal.kapA = a; kal.kapB = b; kal.kapOk = true;
    Serial.printf(">> kadar air = %.6f x ADC + %.3f | R^2 = %.3f | RMSE = %.2f %%\n", a, b, r2, rmse);
    Serial.println("   Salin tabel di atas untuk laporan (Subbab 3.8).");
    simpanKalibrasi();
    return;
  }
  float ka = arg.toFloat();
  if (ka <= 0 || ka >= 100) { Serial.println("Format: kal kap <kadar air acuan %>, contoh: kal kap 14.2"); return; }
  if (kapTitik >= 10) { Serial.println("Maksimal 10 titik. Ketik: kal kap hitung"); return; }
  int adc = bacaAdcRata(64);
  delay(300);
  adc = (adc + bacaAdcRata(64)) / 2;
  kapX[kapTitik] = adc; kapY[kapTitik] = ka; kapTitik++;
  Serial.printf(">> Titik %d: ADC %d  <->  %.1f %%. Lanjut sampel berikutnya, atau ketik: kal kap hitung\n",
                kapTitik, adc, ka);
}

void kalibrasi(const String& b, const String& c) {
  if (b == "hx") kalibrasiHx(c);
  else if (b == "kap") kalibrasiKap(c);
  else if (b == "sht") {
    if (c == "batal") { sandingAktif = false; Serial.println(">> Sandingan dibatalkan."); return; }
    if (c == "reset") { kal.tOff = 0; kal.hOff = 0; simpanKalibrasi(); return; }
    int menit = c.length() ? c.toInt() : 10; if (menit <= 0) menit = 10;
    sumDT = 0; sumDH = 0; nSanding = 0; sandingAktif = true;
    sandingSampai = millis() + (uint32_t)menit * 60000UL;
    Serial.printf(">> Sandingan SHT31 %d menit dimulai. Letakkan kedua sensor berdampingan, jauh dari tangan/laptop.\n", menit);
  }
  else if (b == "co2") {
    if (c == "abc") { kirimCo2(0x79, 0x00); Serial.println(">> ABC OFF terkirim."); }
    else if (c == "nol ya") { kirimCo2(0x87, 0x00); Serial.println(">> Kalibrasi titik nol 400 ppm terkirim. Cek 1 menit lagi (harus ~400-450 ppm)."); }
    else Serial.println("kal co2 abc  |  kal co2 nol ya  (titik nol HANYA di luar ruangan, sensor menyala >= 20 menit)");
  }
  else if (b == "lihat" || b.length() == 0) lihatKalibrasi();
  else Serial.println("kal hx | kal kap | kal sht | kal co2 | kal lihat");
}

void jalankanPerintah(String cmd, const char* sumber) {
  cmd.trim(); cmd.toLowerCase();
  if (cmd.length() == 0) return;
  Serial.printf("[cmd %s] %s\n", sumber, cmd.c_str());

  int sp1 = cmd.indexOf(' ');
  String a = sp1 < 0 ? cmd : cmd.substring(0, sp1);
  String sisa = sp1 < 0 ? "" : cmd.substring(sp1 + 1);
  int sp2 = sisa.indexOf(' ');
  String b = sp2 < 0 ? sisa : sisa.substring(0, sp2);
  String c = sp2 < 0 ? "" : sisa.substring(sp2 + 1);

  if (a == "help") { bantuan(); }
  else if (a == "status") { Serial.println(buatTelemetri()); }
  else if (a == "log") { logAktif = (b != "off"); }
  else if (a == "auto") {
    mode = M_AUTO;
    kirimEvent("mode", "{\"mode\":\"AUTO\"}");
  }
  else if (a == "manual") {
    uint32_t detik = c.endsWith("d") ? (uint32_t)c.toInt() : (uint32_t)c.toInt() * 60;   // "5d" = 5 detik, "5" = 5 menit
    if (detik == 0) detik = MANUAL_DEFAULT_DETIK;
    if (detik > MANUAL_MAKS_MENIT * 60) detik = MANUAL_MAKS_MENIT * 60;
    mode = M_MANUAL;
    manualNyala = (b == "on");
    manualSampaiMs = millis() + detik * 1000UL;
    String lamaJson = (detik % 60) ? String("\"detik\":") + String(detik) : String("\"menit\":") + String(detik / 60);
    kirimEvent("mode", "{\"mode\":\"MANUAL\",\"blower\":" + String(manualNyala ? "true" : "false") + "," + lamaJson + "}");
  }
  else if (a == "sim") {
    if (b == "off") {
      sim = Simulasi();
      kirimEvent("simulasi", "{\"aktif\":false}");
    } else {
      float v = c.toFloat();
      sim.aktif = true;
      if (b == "tdalam") sim.tDalam = v;
      else if (b == "rhdalam") sim.rhDalam = v;
      else if (b == "tmasuk") sim.tMasuk = v;
      else if (b == "rhmasuk") sim.rhMasuk = v;
      else if (b == "co2") sim.co2 = (int)v;
      else if (b == "ka") sim.ka = v;
      else { Serial.println("Nama simulasi tidak dikenal"); return; }
      // agar logika jalan, nilai pasangan yang belum disimulasikan diambil dari sensor asli
      if (isnan(sim.tMasuk) && !isnan(sim.rhMasuk)) sim.tMasuk = d.tMasuk;
      if (!isnan(sim.tMasuk) && isnan(sim.rhMasuk)) sim.rhMasuk = d.rhMasuk;
      kirimEvent("simulasi", "{\"aktif\":true,\"" + b + "\":" + angka(v, 1) + "}");
    }
  }
  else if (a == "demo") {
    modeDemo = (b == "on");
    DUR_MIN_NYALA_S = modeDemo ? DEMO_DURASI_S : DUR_NORMAL_S;
    DUR_MIN_MATI_S  = modeDemo ? DEMO_DURASI_S : DUR_NORMAL_S;
    DUR_CO2_BERTAHAN_S = modeDemo ? DEMO_DURASI_S : DUR_NORMAL_S;
    kirimEvent("demo", "{\"aktif\":" + String(modeDemo ? "true" : "false") + "}");
  }
  else if (a == "tara") {
    if (!kal.hxOk) { Serial.println("HX711 belum dikalibrasi (jalankan sketch kalibrasi menu 2)"); return; }
    scale.tare(15);
    kal.hxOff = scale.get_offset();
    simpanOffsetTara();
    nJendela = 0; massaTercatat = NAN; d.massa = NAN;
    kirimEvent("tara", "{\"offset\":" + String(kal.hxOff) + "}");
  }
  else if (a == "kal") { kalibrasi(b, c); }
  else if (a == "tes" && b == "kap") {
    // 20 pembacaan mentah (tanpa rata-rata bergerak) untuk melihat noise ADC
    int mn = 4095, mx = 0; double sum = 0, sum2 = 0; const int N = 20;
    Serial.println(">> Tes noise sensor kapasitif (20 pembacaan mentah, jangan sentuh sensor):");
    for (int i = 0; i < N; i++) {
      int v = bacaAdcRata(32);
      mn = min(mn, v); mx = max(mx, v); sum += v; sum2 += (double)v * v;
      Serial.printf("  %2d) %d\n", i + 1, v);
      delay(200);
    }
    double rata = sum / N, sd = sqrt(max(0.0, sum2 / N - rata * rata));
    Serial.printf(">> rata-rata %.0f | min %d | maks %d | rentang %d | simpangan baku %.1f\n",
                  rata, mn, mx, mx - mn, sd);
    Serial.println(sd < 5 ? "   Noise rendah, bagus." : (sd < 12 ? "   Noise sedang, masih wajar." :
                   "   Noise tinggi: cek kapasitor D34-GND, kabel sensor, dan jarak dari kabel blower."));
  }
  else if (a == "abc") { kirimCo2(0x79, 0x00); Serial.println("ABC OFF terkirim"); }
  else if (a == "scan") {
    for (uint8_t ad = 1; ad < 127; ad++) {
      Wire.beginTransmission(ad);
      if (Wire.endTransmission() == 0) Serial.printf("  I2C 0x%02X\n", ad);
    }
  }
  else if (a == "wifi") {
    Serial.printf("WiFi %s, IP %s, RSSI %d | MQTT %s | waktu %s | buffer %d\n",
                  WiFi.status() == WL_CONNECTED ? "OK" : "putus",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI(),
                  mqtt.connected() ? "OK" : "putus", waktuSinkron ? "sinkron" : "belum", bufIsi);
  }
  else Serial.println("Perintah tidak dikenal, ketik help");
}

String barisSerial;
void bacaSerial() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n') { jalankanPerintah(barisSerial, "serial"); barisSerial = ""; }
    else if (ch != '\r' && barisSerial.length() < 80) barisSerial += ch;
  }
}

String teksMassa() {
  if (d.sHx == S_OK) {
    if (isnan(d.massa)) return "menunggu";
    return angka(d.massa, 0) + " g" + (d.massaBeku ? " (beku)" : (d.massaStabil ? "" : " (bergerak)"));
  }
  return String(namaStatus(d.sHx));
}
String teksKap() {
  if (d.sKap == S_OK) return "kadar " + angka(d.kadarAir, 1) + "% (adc " + String(d.kapAdc) + ")";
  if (d.sKap == S_BELUM_KAL) return "adc " + String(d.kapAdc) + " (mentah)";
  return "gangguan (adc " + String(d.kapAdc) + ")";
}

void cetakRingkas() {
  Serial.printf("[%5lus] %s%s%s | Td %s Tm %s RHm %s | CO2 %d (%s) | massa %s | %s | blower %s | %s\n",
                millis() / 1000, mode == M_AUTO ? "AUTO" : "MANUAL", sim.aktif ? "+SIM" : "",
                sandingAktif ? "+SANDING" : "",
                angka(nTDalam(), 1).c_str(), angka(nTMasuk(), 1).c_str(), angka(nRhMasuk(), 1).c_str(),
                nCo2(), namaStatus(d.sCo2), teksMassa().c_str(), teksKap().c_str(),
                blowerNyala ? "ON" : "OFF", alasan.c_str());
}

// ============================== SETUP ==============================
void setup() {
  pinMode(PIN_BLOWER, OUTPUT);
  digitalWrite(PIN_BLOWER, LOW);
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n=== GrainSense firmware ==="));
  tBoot = millis();

  TOPIK_BASE    = String("grainsense/") + SILO_ID;
  TOPIK_TELEM   = TOPIK_BASE + "/telemetry";
  TOPIK_EVENT   = TOPIK_BASE + "/event";
  TOPIK_BACKLOG = TOPIK_BASE + "/backlog";
  TOPIK_STATUS  = TOPIK_BASE + "/status";
  TOPIK_CMD     = TOPIK_BASE + "/cmd";

  muatKalibrasi();

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);
  adaDalam = shtDalam.begin(0x44);
  adaMasuk = shtMasuk.begin(0x45);

  Serial2.begin(9600, SERIAL_8N1, PIN_CO2_RX, PIN_CO2_TX);
  Serial2.setTimeout(300);
  delay(200);
  kirimCo2(0x79, 0x00);              // ABC off setiap boot (aman diulang)

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_KAP, ADC_11db);

  scale.begin(PIN_HX_DT, PIN_HX_SCK);
  if (kal.hxOk) { scale.set_offset(kal.hxOff); scale.set_scale(kal.hxScl); }

  Serial.printf("Kalibrasi: HX711 %s | kapasitif %s | offset SHT masuk %+.2f C %+.1f %%\n",
                kal.hxOk ? "OK" : "BELUM", kal.kapOk ? "OK" : "BELUM (tampil angka mentah)", kal.tOff, kal.hOff);
  Serial.printf("SHT31 dalam 0x44: %s | masuk 0x45: %s\n", adaDalam ? "OK" : "TIDAK ADA", adaMasuk ? "OK" : "TIDAK ADA");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  msCobaWifi = millis();
  configTime(7 * 3600, 0, "pool.ntp.org");   // dipakai hanya kalau ada internet

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);
  mqtt.setBufferSize(1536);
  mqtt.setSocketTimeout(3);

  bantuan();
}

// =============================== LOOP ==============================
uint32_t msBaca = 0, msKirim = 0, msBuffer = 0;

void loop() {
  bacaSerial();
  jagaKoneksi();
  if (mqtt.connected()) mqtt.loop();

  uint32_t now = millis();
  if (now - msBaca >= INTERVAL_BACA_MS) {
    msBaca = now;
    bacaSht();
    bacaCo2();
    bacaKapasitif();
    bacaMassa();
    evaluasiAerasi();
  }

  if (now - msKirim >= INTERVAL_KIRIM_MS) {
    msKirim = now;
    if (mqtt.connected()) {
      String tele = buatTelemetri();
      mqtt.publish(TOPIK_TELEM.c_str(), tele.c_str());
    }
    if (logAktif) cetakRingkas();
  }

  if (!mqtt.connected() && now - msBuffer >= INTERVAL_BUFFER_MS) {
    msBuffer = now;
    simpanKeBuffer();
  }
  if (mqtt.connected() && bufIsi > 0) kirimBuffer();
}
