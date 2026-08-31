@echo off
setlocal
if "%~1"=="" (
  echo 请把一个或多个 DWG 文件拖到本文件上，或在命令行传入 DWG 路径。
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\convert-dwg.ps1" %*
set "exit_code=%ERRORLEVEL%"
echo.
if not "%exit_code%"=="0" echo 转换失败，请查看上方错误信息。
pause
exit /b %exit_code%
