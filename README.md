# Project Vision

> **SIH 2026 — Problem Statement 26171 (ISRO)**
> On-device Visual Perception & Privacy-Preserving Redaction for Browser Agents.

## [*] Overview
Project Vision is a hybrid browser extension and server pipeline that performs local PII redaction on user screen captures using WebGPU before transmitting sanitized context to a central VLM backend.

## [*] Architecture
* **Client Extension (`/sih-extension`):** TypeScript, Chrome Extension API (Manifest V3), WebGPU / ONNX Runtime Web.
* **Server Backend (`/sih-backend`):** Python, FastAPI, WebSockets, Open-Weights VLM (Qwen2-VL / PaliGemma).

## [*] Quickstart
### Client Extension
1. `cd sih-extension`
2. `npm install`
3. `npx tsc`
4. Load `./dist` in `chrome://extensions`

### Backend Server
1. `cd sih-backend`
2. `source venv/bin/activate`
3. `uvicorn server:app --reload`
