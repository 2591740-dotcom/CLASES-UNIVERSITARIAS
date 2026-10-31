@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Abriendo ClaseClara...
py -3 app.py
echo.
echo ClaseClara se cerro. Puedes cerrar esta ventana.
pause
