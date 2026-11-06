# =====================================================================
#  GrainSense - pasang / lepas autostart (Task Scheduler, saat login)
#  Task Scheduler dipakai (bukan folder Startup) karena folder Startup
#  dijalankan Windows paling akhir & bergiliran: dengan banyak aplikasi
#  startup, GrainSense bisa telat beberapa menit.
#    autostart.bat          -> pasang
#    autostart.bat hapus    -> lepas
# =====================================================================
param([string]$Perintah = 'pasang')
$ErrorActionPreference = 'Stop'

$NAMA = 'GrainSense Dashboard'
$bat = Join-Path $PSScriptRoot 'jalankan.bat'
$lnkLama = Join-Path ([Environment]::GetFolderPath('Startup')) "$NAMA.lnk"
$pengguna = "$env:USERDOMAIN\$env:USERNAME"

if (Test-Path $lnkLama) { Remove-Item $lnkLama }    # cara lama (folder Startup)

if ($Perintah -eq 'hapus') {
  Unregister-ScheduledTask -TaskName $NAMA -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'GrainSense dilepas dari autostart.'
  exit
}

$tugas = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`"" -WorkingDirectory $PSScriptRoot
$picu = New-ScheduledTaskTrigger -AtLogOn -User $pengguna
$picu.Delay = 'PT15S'                                  # beri waktu Wi-Fi tersambung dulu
$atur = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$prin = New-ScheduledTaskPrincipal -UserId $pengguna -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $NAMA -Action $tugas -Trigger $picu -Settings $atur -Principal $prin `
  -Description 'GrainSense: hotspot + Mosquitto + dashboard saat login' -Force | Out-Null
Write-Host 'GrainSense dipasang: jalan otomatis ~15 detik setelah login (Task Scheduler).'
Write-Host 'Untuk melepas: autostart.bat hapus'
