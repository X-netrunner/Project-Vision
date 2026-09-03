import asyncio
import json
import websockets

# Valid base64-encoded 1x1 transparent PNG pixel
DUMMY_BASE64_SS = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


async def test_pipeline():
    uri = "ws://127.0.0.1:8001/ws"

    print(f"[*] Connecting to {uri}...")
    try:
        async with websockets.connect(uri, open_timeout=60) as websocket:
            print("[+] Connected to Srijan's FastAPI server on Port 8001")

            # Step 1: Send raw user prompt string (Phase 1)
            test_prompt = "Search for mechanical keyboard on Amazon"
            print(f"\n[>] Sending Phase 1 Prompt: '{test_prompt}'")
            await websocket.send(test_prompt)

            # The server builds a plan but does NOT reply with REQUEST_SS; it
            # waits for us to send a screenshot for each step. We simulate the
            # extension by sending a screenshot, then reading the AGENT_ACTION.
            await asyncio.sleep(2.0)

            # Step 2: Send a screenshot for step 0 and read AGENT_ACTION.
            # The first action is usually 'navigate' (non-visual), so index 0.
            await send_and_receive(websocket, request_id="req_001", step_index=0)

    except TimeoutError:
        print("[!] Connection timed out. Make sure 'python main.py' is running on port 8001.")
    except Exception as e:
        print(f"[!] Error: {e}")


async def send_and_receive(websocket, request_id: str, step_index: int):
    redacted_ss_payload = {
        "type": "REDACTED_SCREENSHOT",
        "request_id": request_id,
        "tab_id": 123,
        "step_index": step_index,
        "image": DUMMY_BASE64_SS,
        # HiDPI screens are captured in device pixels; the server divides the
        # predicted coordinates by this value so clicks land at viewport pixels.
        "device_pixel_ratio": 1.5,
        "action_result": {
            "success": True,
            "action": "click",
            "step_index": step_index,
            "tab_id": 123
        }
    }
    print(f"\n[>] Sending REDACTED_SCREENSHOT for Step {step_index + 1}...")
    await websocket.send(json.dumps(redacted_ss_payload))

    try:
        agent_action_raw = await asyncio.wait_for(websocket.recv(), timeout=120)
        agent_action = json.loads(agent_action_raw)
        print(f"[<] Received from Srijan:\n{json.dumps(agent_action, indent=2)}")
    except asyncio.TimeoutError:
        print("[!] Timed out waiting for AGENT_ACTION from Srijan.")


if __name__ == "__main__":
    asyncio.run(test_pipeline())
