#!/usr/bin/env bash
# Launcher for the Project Vision browser automation server.
#
# On this 6GB GPU the 8B Qwen2.5-VL VLM coexists with the ollama planner by
# reserving GPU memory for the VLM and offloading the rest of the ollama model
# to CPU. Tune OLLAMA_GPU_LAYERS to balance ollama speed vs. VLM room.
set -e

cd "$(dirname "$0")"

# Reserve ~2.5GB of VRAM for the Qwen2.5-VL VLM by capping how many ollama
# layers sit on the GPU (qwen3:8b, Q4_K_M). Higher = faster planner, lower =
# more room for the VLM. Keeps ollama on GPU as requested.
export OLLAMA_GPU_LAYERS="${OLLAMA_GPU_LAYERS:-28}"

echo "[*] Starting ollama (GPU layers capped to leave VRAM for the VLM)..."
if pgrep -x ollama >/dev/null 2>&1; then
    echo "[*] ollama already running."
else
    ollama serve > logs/ollama.log 2>&1 &
    sleep 3
fi

echo "[*] Starting server on port 8001..."
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
exec python3 main.py
