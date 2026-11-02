@echo off
rem Pasang / lepas GrainSense dari startup Windows (tanpa perlu Admin).
rem   autostart.bat          -> pasang (jalan otomatis setiap login)
rem   autostart.bat hapus    -> lepas
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\GrainSense Dashboard.lnk"
if /i "%~1"=="hapus" (
  del "%LNK%" 2>nul
  echo GrainSense dilepas dari startup.
  goto :eof
)
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath='%~dp0jalankan.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='GrainSense: hotspot + Mosquitto + dashboard'; $s.Save()"
echo GrainSense dipasang di startup: akan jalan otomatis setiap Windows login.
echo Untuk melepas: autostart.bat hapus
