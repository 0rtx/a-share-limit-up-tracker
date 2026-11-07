@echo off
setlocal
cd /d "%~dp0"
set "PY=python"
where python >nul 2>nul
if errorlevel 1 set "PY=C:\Users\rtx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
echo 局域网模式：监听 0.0.0.0:8770（手机/平板访问页面时也能用通达信数据）
echo 首次运行 Windows 会弹防火墙提示，请选择「允许访问」。
"%PY%" tdx_bridge.py --host 0.0.0.0
pause
