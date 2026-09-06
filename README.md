# Project Vision

> **Smart India Hackathon 2026 — Problem Statement 26171 (ISRO)**
> On-device Visual Perception for Lightweight Browser Agents

## Overview

Project Vision is a browser automation agent that understands plain-English
instructions ("search for PS4 controllers", "add this to cart") and carries
them out by *looking at the page* rather than relying on hard-coded CSS
selectors — so it keeps working even when a website's layout changes.

A browser extension captures screenshots (redacting faces and PII locally
before anything leaves the device) and streams them to a server over a
WebSocket. The server plans the task, asks a vision-language model where to
click, sends the action back, and repeats — recovering on its own if a step
fails.

## How it works

```
Browser extension  <──WebSocket──>  FastAPI server (main.py)
   (screenshots,                        │
    redaction,                          ├──> Planner   — Ollama, qwen3:8b
    executes clicks)                    │      breaks the goal into steps
                                         │
                                         └──> VLM       — Qwen2.5-VL-3B (GPU)
                                                looks at the screenshot and
                                                returns where to click
```

1. **Plan** — the user's prompt goes to a local Ollama model, which returns
   an ordered list of steps (e.g. `click: search bar`, `type: ps4
   controllers`, `press: Enter`).
2. **Look** — for each step, the current screenshot and the step description
   go to a vision-language model (Qwen2.5-VL), which returns the exact pixel
   location of the target element.
3. **Act** — the server sends that as a click/type/scroll instruction back
   to the extension over the WebSocket.
4. **Verify** — the extension reports whether the action succeeded via a
   fresh screenshot.
5. **Recover** — if a step fails, the server shows the failure screenshot to
   the model, asks what went wrong, and gets 1-3 corrective steps instead of
   blindly repeating the same failed action (capped retries so it can't get
   stuck forever).

Since everything runs on a single local GPU, only one automation runs at a
time — additional requests are queued and served in order, and a built-in
admin dashboard shows every connected client and lets you disconnect or
cancel one manually.

## Repo layout

| Path | What it is |
|---|---|
| `Server[unnati&srijan]/` | The Python backend — FastAPI server, planner, VLM, connection/queue management |
| `protoType/` | The browser extension (TypeScript, Manifest V3) — capture, redaction, and DOM execution |

## Running the server

```bash
cd "Server[unnati&srijan]"
pip install fastapi uvicorn websockets ollama torch transformers accelerate bitsandbytes pillow
./run.sh
```

`run.sh` starts Ollama (capped GPU layers so it leaves VRAM free for the
vision model), frees port `8001` if a previous instance is still running,
and launches the server. First run downloads `Qwen/Qwen2.5-VL-3B-Instruct`
from Hugging Face, loaded in 4-bit to fit a laptop GPU.

Once it's up:
- WebSocket endpoint: `ws://<host>:8001/ws`
- Admin dashboard: `http://<host>:8001/admin`

**Tested on:** RTX 4050 Laptop GPU (6GB VRAM).

## Loading the extension

```bash
cd protoType
npm install
npm run build
```
Then load `protoType/dist` as an unpacked extension in `chrome://extensions`.

## Team

| Name | Focus |
|---|---|
| Srijan | Server / backend |
| Unnati | Server / backend |
| Varun | Redaction (PII/face blurring) |
| Sushanth | Extension / DOM execution |
| Ayshika | Design |
| Shraddha | Design |

## Status

Actively being built for SIH 2026 evaluation — not production-hardened
(notably, the WebSocket currently has no authentication).
