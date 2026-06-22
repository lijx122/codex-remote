@echo off
FOR /f "tokens=*" %%z IN ('fnm env') DO CALL %%z
cd /d "F:\cx\cx\codex"
echo Node version: > reports\wrapper.log
node -v >> reports\wrapper.log 2>&1
echo Attempting to start... >> reports\wrapper.log
start /b "" node tools\codex-control-plane.js >> reports\control-plane.log 2>&1
start /b "" node adapters\wxbot\bin\ilink.js >> reports\wxbot.log 2>&1
