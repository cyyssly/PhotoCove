@echo off
rem PhotoCove desktop launcher (unpackaged / dev setup)
rem One-time requirement in this folder: npm install
cd /d "%~dp0"

rem Some environments preset this; it would turn Electron into plain Node
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo [PhotoCove] Electron is not installed yet.
  echo Run once in this folder:  npm install
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
