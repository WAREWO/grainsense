@echo off
rem Pasang / lepas GrainSense dari autostart Windows (Task Scheduler, tanpa Admin).
rem   autostart.bat          -> pasang (jalan otomatis setiap login)
rem   autostart.bat hapus    -> lepas
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" %*
