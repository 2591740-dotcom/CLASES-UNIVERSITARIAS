@echo off
chcp 65001 >nul
cd /d "%~dp0"
title LINKEODECLASESCLARA
echo Abriendo LINKEODECLASESCLARA...
py -3 linkeo.py
echo.
echo LINKEODECLASESCLARA se cerro. Puedes cerrar esta ventana.
pause
