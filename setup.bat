@echo off
echo === Bagimliliklar kuruluyor ===
call npm install
if errorlevel 1 goto :error

echo.
echo === Supabase migration'lari calistiriliyor ===
call npm run migrate
if errorlevel 1 goto :error

echo.
echo Kurulum tamam. Sunucuyu baslatmak icin: start.bat
goto :eof

:error
echo.
echo HATA olustu, yukaridaki mesaja bak.
pause
