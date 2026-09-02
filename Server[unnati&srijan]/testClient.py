import asyncio
import json
import websockets

# Valid base64-encoded 1x1 transparent PNG pixel
DUMMY_BASE64_SS = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

async def test_pipeline():
    uri = "ws://10.67.21.46:8001/ws"

    print(f"[*] Connecting to {uri}...")
    try:
        async with websockets.connect(uri, open_timeout=60) as websocket:
            print("[+] Connected to Srijan's FastAPI server on Port 8001")

            # Step 1: Send raw user prompt string (Phase 1)
            test_prompt = "Search for mechanical keyboard on Amazon"
            print(f"\n[>] Sending Phase 1 Prompt: '{test_prompt}'")
            await websocket.send(test_prompt)

            # Step 2: Receive REQUEST_SS response from main.py
            response_raw = await websocket.recv()
            response = json.loads(response_raw)
            print(f"[<] Received Phase 1 Response:\n{json.dumps(response, indent=2)}")

            req_id = response.get("request_id", "req_001")
            total_steps = response["payload"]["total_steps"]

            # Step 3: Loop through all steps with REDACTED_SCREENSHOT messages
            for current_step in range(total_steps):
                print(f"\n--- Running Step {current_step + 1}/{total_steps} ---")

                redacted_ss_payload = {
                    "type": "REDACTED_SCREENSHOT",
                    "request_id": req_id,
                    "tab_id": 123,
                    "step_index": current_step,
                    "image": DUMMY_BASE64_SS,
                    "action_result": {
                        "success": True,
                        "action": "click",
                        "step_index": current_step,
                        "tab_id": 123
                    }
                }
                print(f"[>] Sending REDACTED_SCREENSHOT for Step {current_step + 1}...")
                await websocket.send(json.dumps(redacted_ss_payload))

                # Step 4: Receive AGENT_ACTION from Srijan
                agent_action_raw = await websocket.recv()
                agent_action = json.loads(agent_action_raw)
                print(f"[<] Received AGENT_ACTION from Srijan:\n{json.dumps(agent_action, indent=2)}")

                if agent_action.get("is_last_step"):
                    print("\n[+] Final step completed successfully!")
                    break

    except TimeoutError:
        print("[!] Connection timed out. Make sure 'python main.py' is running on port 8001.")
    except Exception as e:
        print(f"[!] Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_pipeline())
