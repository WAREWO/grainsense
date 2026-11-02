@echo off
rem Klik dua kali file ini untuk menyalakan hotspot + Mosquitto + dashboard GrainSense.
rem Tambahkan "-Simulator" untuk ikut menjalankan simulator, mis:  jalankan.bat -Simulator
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0jalankan.ps1" %*
