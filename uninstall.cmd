@echo off
rem ============================================================
rem  dsh-brain-kit 卸载（可回滚安装）
rem  默认：只摘注册与 junction，保留插件目录
rem  彻底删：uninstall.cmd -Purge
rem ============================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall %*
echo.
pause
