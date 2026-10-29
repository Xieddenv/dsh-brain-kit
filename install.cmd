@echo off
rem ============================================================
rem  dsh-brain-kit 安装
rem  双击即可；也可带参数： -Profile desktop -Restart
rem  卸载：双击 uninstall.cmd
rem ============================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
