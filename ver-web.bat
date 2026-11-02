@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Abriendo la web de ClaseClara en esta PC...
py -3 ver-web.py
echo.
echo La vista de la web se cerro. Puedes cerrar esta ventana.
pause
