import asyncio
import json
import websockets

DUMMY_BASE64_SS = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

async def test_full_flow():
    uri = "ws://127.0.0.1:8001/ws"
    print(f"[*] Connecting to {uri}...")
    async with websockets.connect(uri, open_timeout=30) as ws:
        print("[+] Connected")
        await ws.send(json.dumps({
            "type": "USER_PROMPT",
            "request_id": "req_full_1",
            "prompt": "on flipkart add this product to cart"
        }))
        print("[>] Sent USER_PROMPT")

        # Simulate the extension loop: for each screenshot, expect an AGENT_ACTION.
        # We send a NEW screenshot with action_result=success for the PREVIOUS step.
        step_count = 0
        for i in range(12):
            await asyncio.sleep(0.5)
            await ws.send(json.dumps({
                "type": "REDACTED_SCREENSHOT",
                "request_id": "req_full_1",
                "tab_id": 777,
                "step_index": i,
                "image": DUMMY_BASE64_SS,
                "action_result": {"success": True, "step_index": i - 1} if i > 0 else None
            }))
            print(f"[>] Sent screenshot {i}")
            try:
                reply = await asyncio.wait_for(ws.recv(), timeout=90)
                action = json.loads(reply)
                step = action.get("step_index")
                act = action.get("action", {})
                print(f"    [<] step_index={step} action={act.get('action')} target={act.get('target')} found={act.get('found')}")
                if action.get("is_last_step"):
                    print("[*] Reached last step. Flow completed.")
                    break
                step_count += 1
            except asyncio.TimeoutError:
                print("[!] Timed out waiting for action")
                break

        print(f"[*] Total actions dispatched: {step_count}")

asyncio.run(test_full_flow())
