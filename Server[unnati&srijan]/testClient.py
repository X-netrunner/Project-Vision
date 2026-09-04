import asyncio
import json
import websockets

# Valid base64-encoded 1x1 transparent PNG pixel
DUMMY_BASE64_SS = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

async def test_pipeline():
    uri = "ws://127.0.0.1:8001/ws"
    print(f"[*] Connecting to {uri}...")

    try:
        async with websockets.connect(uri, open_timeout=30) as websocket:
            print("[+] Connected to Srijan's FastAPI server on Port 8001")

            # Test 1: Flipkart Prompt Execution
            test_prompt = "in flipkart add this to cart"
            print(f"\n[>] Test 1: Sending Flipkart Prompt: '{test_prompt}'")
            await websocket.send(json.dumps({
                "type": "USER_PROMPT",
                "request_id": "req_fk_001",
                "prompt": test_prompt
            }))

            await asyncio.sleep(1.0)

            # Step 1: Send redacted screenshot
            print("[>] Sending initial REDACTED_SCREENSHOT for Step 1...")
            await websocket.send(json.dumps({
                "type": "REDACTED_SCREENSHOT",
                "request_id": "req_fk_001",
                "tab_id": 101,
                "step_index": 0,
                "image": DUMMY_BASE64_SS,
                "action_result": None
            }))

            reply1 = await asyncio.wait_for(websocket.recv(), timeout=60)
            action1 = json.loads(reply1)
            print(f"[<] Received Action 1:\n{json.dumps(action1, indent=2)}")

            # Test 2: Simulate Failure & Verify Rethinking
            print("\n[>] Test 2: Simulating action failure to trigger Model Rethink...")
            failed_action_result = {
                "type": "ACTION_RESULT",
                "request_id": "req_fk_001",
                "action_id": action1.get("action_id", "act_001"),
                "result": {
                    "success": False,
                    "action": action1.get("action", {}).get("action", "click"),
                    "step_index": 0,
                    "tab_id": 101,
                    "error": "Element not found or blocked by overlay in current viewport"
                }
            }
            await websocket.send(json.dumps(failed_action_result))

            # The server should rethink and immediately dispatch a corrective AGENT_ACTION
            print("[*] Waiting for server rethink and corrective AGENT_ACTION...")
            reply2 = await asyncio.wait_for(websocket.recv(), timeout=60)
            action2 = json.loads(reply2)
            print(f"[<] Received Corrective Action after Rethink:\n{json.dumps(action2, indent=2)}")
            print("\n[SUCCESS] Pipeline and Rethink verified successfully!")

    except TimeoutError:
        print("[!] Connection timed out. Make sure 'python main.py' is running on port 8001.")
    except Exception as e:
        print(f"[!] Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_pipeline())
