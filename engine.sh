#!/bin/bash
# Local engine control for the console (called from inside the OneShot server; never restarts that server).
#   engine-start   stop the DeepSeek web and any old ComfyUI, then start the H3 engine (engine/service.py, 127.0.0.1:8189)
#   engine-stop    stop the H3 engine
#   comfy-stop     stop the old ComfyUI engine
#   deepseek-start start the DeepSeek web (it takes the GPU; about 3 minutes)
set -u
H3=~/h3studio
stop_comfy() {
  for p in $(ps -eo pid,args | awk '$2 ~ /\.venv\/bin\/python/ && $3 == "main.py" {print $1}'); do
    [ "$(readlink /proc/$p/cwd)" = "$HOME/ComfyUI" ] && kill $p && echo "停止旧的 ComfyUI ($p)"
  done
  for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8188/ || break; sleep 1; done
}
engine_pid() {
  for p in $(pgrep -f "h3engine-venv/bin/python service.py$"); do
    [ "$(readlink /proc/$p/cwd)" = "$H3/engine" ] && echo $p
  done
}
for step in "$@"; do
  case "$step" in
  engine-start)
    if curl -s -o /dev/null http://127.0.0.1:8189/status; then echo "H3 引擎已经在运行"; continue; fi
    ~/InferSSD/.venv/bin/python - <<"PY"
import json, os, signal, time
from pathlib import Path
s = json.loads(Path.home() / "InferSSD/experiment/web/service.json".read_text())
pid = s.get("controller_pid")
alive = pid and Path("/proc", str(pid)).exists() and Path("/proc", str(pid), "stat").read_text().split()[21] == str(s.get("controller_start_identity"))
if alive:
    assert b"serve_deepseek.py" in Path("/proc", str(pid), "cmdline").read_bytes()
    os.kill(pid, signal.SIGTERM); print("停止 DeepSeek 网页", pid, flush=True)
    for _ in range(180):
        if not Path("/proc", str(pid)).exists(): break
        time.sleep(1)
PY
    stop_comfy
    LOCK=~/.local/share/inferssd/state/runtime.lock
    cd $H3/engine && setsid nohup flock -w 180 $LOCK ~/h3engine-venv/bin/python service.py > $H3/engine.log 2>&1 < /dev/null &
    for i in $(seq 1 150); do
      s=$(curl -s http://127.0.0.1:8189/status) && echo "$s" | grep -q '"ready": true' && { echo "H3 引擎已启动"; break; }
      sleep 2
    done
    ;;
  engine-stop)
    for p in $(engine_pid); do kill $p; done
    for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:8189/status || { echo "H3 引擎已停止"; break; }; sleep 1; done
    ;;
  comfy-stop) stop_comfy ;;
  deepseek-start)
    setsid nohup ~/InferSSD/.venv/bin/python ~/InferSSD/experiment/start_deepseek_web_after_test.py > ~/InferSSD/experiment/web/after-comfyui.log 2>&1 < /dev/null &
    echo "DeepSeek 网页启动中（约 3 分钟）"
    ;;
  esac
done
