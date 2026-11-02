# =====================================================================
#  GrainSense - nyalakan semua: hotspot, Mosquitto, dashboard
#  Dipanggil dari jalankan.bat (klik dua kali, atau otomatis saat login).
#  Opsi:  -Simulator      ikut jalankan simulator ESP32 (bila hardware belum siap)
#         -TanpaHotspot   jangan menyalakan Mobile Hotspot
#         -TanpaBrowser   jangan membuka browser
# =====================================================================
param([switch]$Simulator, [switch]$TanpaHotspot, [switch]$TanpaBrowser)

Set-Location $PSScriptRoot
$Host.UI.RawUI.WindowTitle = 'GrainSense Dashboard'
$PORT = 8080
$MOSQUITTO = 'C:\Program Files\mosquitto\mosquitto.exe'

function Tulis($teks, $warna = 'Gray') { Write-Host $teks -ForegroundColor $warna }
function PortDipakai($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

Tulis "`n=== GrainSense ===" Green

# ---- 1. Mobile Hotspot (untuk ESP32) ----
if (-not $TanpaHotspot) {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
    $null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]

    # tunggu jaringan siap (saat baru login Wi-Fi kadang belum tersambung)
    $prof = $null
    for ($i = 0; $i -lt 30 -and -not $prof; $i++) {
      $prof = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
      if (-not $prof) {
        $prof = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles() | Select-Object -First 1
      }
      if (-not $prof) { Start-Sleep 2 }
    }
    if (-not $prof) { throw 'tidak ada jaringan untuk dibagikan' }

    $tm = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($prof)
    $ssid = $tm.GetCurrentAccessPointConfiguration().Ssid
    if ($tm.TetheringOperationalState -eq 'On') {
      Tulis "[hotspot] sudah menyala ($ssid)" Green
    } else {
      $tugas = $asTask.MakeGenericMethod([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]).Invoke($null, @($tm.StartTetheringAsync()))
      $tugas.Wait(20000) | Out-Null
      if ($tugas.Result.Status -eq 'Success') { Tulis "[hotspot] dinyalakan ($ssid)" Green }
      else { throw "status $($tugas.Result.Status)" }
    }
  } catch {
    Tulis "[hotspot] GAGAL dinyalakan otomatis ($($_.Exception.Message))." Yellow
    Tulis "          Nyalakan manual: Settings > Network & internet > Mobile hotspot" Yellow
  }
}

# ---- 2. Mosquitto ----
if (PortDipakai 1883) {
  Tulis '[mosquitto] sudah berjalan di port 1883' Green
} elseif (Test-Path $MOSQUITTO) {
  Start-Process $MOSQUITTO -ArgumentList "-c `"$PSScriptRoot\mosquitto.conf`" -v" -WindowStyle Minimized
  Start-Sleep 1
  if (PortDipakai 1883) { Tulis '[mosquitto] dinyalakan (jendela terpisah, diperkecil)' Green }
  else { Tulis '[mosquitto] GAGAL menyala. Cek jendela Mosquitto untuk pesan errornya.' Red }
} else {
  Tulis "[mosquitto] tidak ditemukan di $MOSQUITTO. Install dulu dari mosquitto.org" Red
}

# ---- 3. Dependensi Node (sekali saja) ----
if (-not (Test-Path "$PSScriptRoot\node_modules\mqtt")) {
  Tulis '[npm] memasang dependensi (sekali saja)...'
  & npm.cmd install
}

# ---- 4. Simulator (opsional) ----
if ($Simulator) {
  Start-Process powershell -ArgumentList "-NoExit -NoProfile -Command `"Set-Location '$PSScriptRoot'; `$Host.UI.RawUI.WindowTitle='GrainSense Simulator'; node simulator.js`""
  Tulis '[simulator] dinyalakan di jendela terpisah' Green
}

# ---- 5. Dashboard ----
if (PortDipakai $PORT) {
  Tulis "[dashboard] sudah berjalan di http://localhost:$PORT" Green
  if (-not $TanpaBrowser) { Start-Process "http://localhost:$PORT" }
  Start-Sleep 4
  exit
}
if (-not $TanpaBrowser) {
  Start-Job { Start-Sleep 3; Start-Process "http://localhost:$using:PORT" } | Out-Null
}
Tulis "[dashboard] http://localhost:$PORT  (jangan tutup jendela ini; Ctrl+C untuk berhenti)`n" Green
& node server.js
Tulis "`n[dashboard] berhenti. Tekan Enter untuk menutup." Yellow
Read-Host | Out-Null
