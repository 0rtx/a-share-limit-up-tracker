@echo off
setlocal
cd /d "%~dp0"
set "PY=python"
where python >nul 2>nul
if errorlevel 1 set "PY=C:\Users\rtx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" (
  echo 未找到 Python，请安装 Python 3.8+ 后重试，或修改本脚本中的 PY 路径。
  pause
  exit /b 1
)
echo ============================================
echo  通达信数据桥接服务 (TDX Bridge)
echo  地址: http://127.0.0.1:8770/api/ping
echo  关闭本窗口即停止服务。
echo  然后在网页右上角把「数据源」切换为「本地通达信」。
echo  如需在手机等其它设备上使用本页面，请改用:
echo      run_lan.bat   （监听所有网卡，需放行防火墙）
echo ============================================
"%PY%" tdx_bridge.py %*
pause
