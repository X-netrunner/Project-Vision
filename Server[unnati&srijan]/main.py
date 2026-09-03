import asyncio
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import json
import os
import uuid
from planner import createPlan
from vlm import predict_action, decode_base64_image

app = FastAPI()

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
SCREENSHOTS_DIR = os.path.join(SERVER_DIR, "screenshots")
LOGS_DIR = os.path.join(SERVER_DIR, "logs")

os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)


MAX_LOG_IMAGE_CHARS = 2000


def log_payload(direction: str, payload):
    """Append a sent/received payload to logs/payloads.log with a timestamp.

    The base64 image in screenshot payloads can be megabytes, so it is truncated
    in the log to keep the file readable while still showing the message shape.
    """
    try:
        loggable = payload
        if isinstance(payload, dict):
            loggable = dict(payload)
            img = loggable.get("image")
            if isinstance(img, str) and len(img) > MAX_LOG_IMAGE_CHARS:
                loggable["image"] = img[:MAX_LOG_IMAGE_CHARS] + f"...<{len(img)} chars>"
        entry = f"[{datetime.now().isoformat(timespec='seconds')}] {direction} {json.dumps(loggable)}\n"
        with open(os.path.join(LOGS_DIR, "payloads.log"), "a", encoding="utf-8") as f:
            f.write(entry)
    except Exception as err:
        print(f"[!] Failed to log payload: {err}")


def save_screenshot(base64_img: str, request_id: str, step_index: int) -> str | None:
    """Decode a base64 screenshot and store it in the screenshots folder."""
    try:
        img = decode_base64_image(base64_img)
        ts = datetime.now().strftime("%H%M%S")
        filename = f"{request_id}_step{step_index + 1}_{ts}.png"
        path = os.path.join(SCREENSHOTS_DIR, filename)
        img.save(path)
        print(f"[+] Screenshot saved: {path}")
        return path
    except Exception as err:
        print(f"[!] Could not save screenshot: {err}")
        return None

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("[*] Connection established with Extension")

    taskPlan = []
    current_step_index = 0
    active_request_id = "req_001"
    active_tab_id = None

    try:
        while True:
            rawData = await websocket.receive_text()
            try:
                message = json.loads(rawData)
                msgType = message.get("type")
            except json.JSONDecodeError:
                message = None
                msgType = "STRING_PROMPT"

            # Phase 1: Handle user prompt and generate step plan
            if msgType in ["USER_PROMPT", "STRING_PROMPT"]:
                if isinstance(message, dict):
                    userPrompt = message.get("prompt", "").strip()
                    active_request_id = message.get("request_id", f"req_{uuid.uuid4().hex[:6]}")
                else:
                    userPrompt = rawData.strip()
                    active_request_id = f"req_{uuid.uuid4().hex[:6]}"

                if not userPrompt:
                    continue

                print(f"[*] Received prompt ({active_request_id}):", userPrompt)
                log_payload("RECV <", userPrompt)

                # Generate task plan via Ollama planner in background thread
                taskPlan = await asyncio.to_thread(createPlan, userPrompt)
                current_step_index = 0

                print(f"[*] Task plan generated ({len(taskPlan)} steps):")
                for i, step in enumerate(taskPlan):
                    print(f"\t Step {i+1}: {step}")

                print("[*] Waiting for initial screenshot from extension...")

            # Phase 2: Handle incoming screenshots (RAW_SCREENSHOT or REDACTED_SCREENSHOT)
            elif message and msgType in ["RAW_SCREENSHOT", "REDACTED_SCREENSHOT"]:
                active_request_id = message.get("request_id", active_request_id)
                active_tab_id = message.get("tab_id", active_tab_id)
                base64_img = message.get("image", "")
                device_pixel_ratio = message.get("device_pixel_ratio", 1.0)

                log_payload("RECV <", message)

                if not taskPlan:
                    print("[!] Screenshot received but taskPlan is empty.")
                    continue

                if current_step_index >= len(taskPlan):
                    print("[*] All planned steps have already been executed.")
                    continue

                currentSubGoal = taskPlan[current_step_index]
                isDone = (current_step_index + 1) >= len(taskPlan)

                print(f"[*] Processing step {current_step_index + 1}/{len(taskPlan)}: '{currentSubGoal}'")

                save_screenshot(base64_img, active_request_id, current_step_index)

                try:
                    # Run VLM inference
                    inner_action = await asyncio.to_thread(
                        predict_action,
                        base64_image=base64_img,
                        current_step=currentSubGoal,
                        step_index=current_step_index,
                        is_last_step=isDone,
                        device_pixel_ratio=device_pixel_ratio
                    )

                    # Structure AGENT_ACTION packet
                    agent_action_payload = {
                        "type": "AGENT_ACTION",
                        "request_id": active_request_id,
                        "action_id": f"action_{uuid.uuid4().hex[:6]}",
                        "step_index": current_step_index,
                        "is_last_step": isDone,
                        "action": inner_action
                    }

                    if active_tab_id is not None:
                        agent_action_payload["tab_id"] = active_tab_id

                    print(f"[+] Sending AGENT_ACTION: {agent_action_payload}")
                    log_payload("SEND >", agent_action_payload)
                    await websocket.send_text(json.dumps(agent_action_payload))

                    current_step_index += 1

                except WebSocketDisconnect:
                    # Extension closed the socket mid-step; let the outer handler
                    # clean up instead of trying to send an error on a dead socket.
                    raise
                except Exception as err:
                    detail = str(err) or f"{type(err).__name__} (no detail)"
                    print(f"[!] Error processing step: {detail}")
                    errorPayload = {
                        "type": "ERROR",
                        "request_id": active_request_id,
                        "error": detail
                    }
                    log_payload("SEND >", errorPayload)
                    try:
                        await websocket.send_text(json.dumps(errorPayload))
                    except Exception:
                        print("[!] Connection closed; unable to send error payload to extension.")

            # Phase 3: Action Execution Feedback
            elif message and msgType == "ACTION_RESULT":
                log_payload("RECV <", message)
                result = message.get("result", {})
                success = result.get("success", False)
                step_idx = result.get("step_index", 0)

                if success:
                    print(f"[+] Action step {step_idx} executed successfully.")
                    if current_step_index < len(taskPlan):
                        print(f"[*] Awaiting screenshot for Step {current_step_index + 1}: '{taskPlan[current_step_index]}'")
                else:
                    print(f"[!] Action step {step_idx} failed: {result.get('error')}")

    except WebSocketDisconnect:
        print("[!] Extension disconnected.")
    except RuntimeError as err:
        # Some uvicorn/starlette versions raise RuntimeError("WebSocket is not
        # connected. Need to call 'accept' first.") when receive_text() is called
        # after the peer has already closed the socket. Treat it as a disconnect.
        print(f"[!] WebSocket connection lost: {err}")
    except Exception as err:
        print(f"[!] WebSocket handler error: {err}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False)
