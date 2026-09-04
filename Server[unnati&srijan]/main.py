import asyncio
import traceback
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import json
import uuid
from planner import createPlan, replanTask
from vlm import predict_action

app = FastAPI(title="Project Vision Browser Automation Server")

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "browser-automation-server", "model": "qwen3:8b"}

async def send_agent_action(websocket: WebSocket, request_id: str, tab_id: int | None, step_index: int, is_last_step: bool, inner_action: dict):
    payload = {
        "type": "AGENT_ACTION",
        "request_id": request_id,
        "action_id": f"action_{uuid.uuid4().hex[:6]}",
        "step_index": step_index,
        "is_last_step": is_last_step,
        "action": inner_action
    }
    if tab_id is not None:
        payload["tab_id"] = tab_id
    print(f"[+] Sending AGENT_ACTION for step {step_index + 1}: {inner_action.get('action')} -> {payload}")
    await websocket.send_text(json.dumps(payload))

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("[*] Connection established with Extension")

    taskPlan = []
    completed_steps = []
    current_step_index = 0
    active_prompt = ""
    active_request_id = "req_001"
    active_tab_id = None
    retry_count = 0
    last_screenshot = ""

    try:
        while True:
            rawData = await websocket.receive_text()
            try:
                message = json.loads(rawData)
                msgType = message.get("type") if isinstance(message, dict) else "STRING_PROMPT"
            except json.JSONDecodeError:
                message = None
                msgType = "STRING_PROMPT"

            # Phase 1: Handle User Prompt
            if msgType in ["USER_PROMPT", "STRING_PROMPT"]:
                if isinstance(message, dict):
                    active_prompt = message.get("prompt", "").strip()
                    active_request_id = message.get("request_id", f"req_{uuid.uuid4().hex[:6]}")
                else:
                    active_prompt = rawData.strip()
                    active_request_id = f"req_{uuid.uuid4().hex[:6]}"

                if not active_prompt:
                    continue

                print(f"[*] Received prompt ({active_request_id}): {active_prompt}")

                # Generate initial task plan with 8b model
                taskPlan = await asyncio.to_thread(createPlan, active_prompt)
                completed_steps = []
                current_step_index = 0
                retry_count = 0

                print(f"[*] Task plan generated ({len(taskPlan)} steps):")
                for i, step in enumerate(taskPlan):
                    print(f"\t Step {i+1}: {step}")

                print("[*] Waiting for screenshot from extension...")

            # Phase 2: Handle Incoming Screenshots & Action Prediction
            elif message and msgType in ["RAW_SCREENSHOT", "REDACTED_SCREENSHOT"]:
                active_request_id = message.get("request_id", active_request_id)
                active_tab_id = message.get("tab_id", active_tab_id)
                base64_img = message.get("image", "")
                if base64_img:
                    last_screenshot = base64_img

                # Check if action_result was bundled inside screenshot message
                bundled_result = message.get("action_result")
                if bundled_result and isinstance(bundled_result, dict):
                    if bundled_result.get("success") is True:
                        if current_step_index < len(taskPlan):
                            completed_steps.append(taskPlan[current_step_index])
                            current_step_index += 1
                            retry_count = 0
                    elif bundled_result.get("success") is False:
                        # Action execution failed on client
                        error_desc = bundled_result.get("error", "Client action execution failed")
                        print(f"[!] Bundled action result reported failure: {error_desc}")
                        if retry_count < 3 and current_step_index < len(taskPlan):
                            failed_step = taskPlan[current_step_index]
                            print(f"[*] Rethinking failed step: '{failed_step}'...")
                            replan_res = await asyncio.to_thread(
                                replanTask,
                                user_prompt=active_prompt,
                                failed_step=failed_step,
                                error_msg=error_desc,
                                completed_steps=completed_steps,
                                remaining_steps=taskPlan[current_step_index + 1:]
                            )
                            thought = replan_res.get("thought", "")
                            new_steps = replan_res.get("steps", [failed_step])
                            print(f"[*] Model rethink thought: {thought}")
                            print(f"[*] Corrective steps: {new_steps}")
                            taskPlan = taskPlan[:current_step_index] + new_steps
                            retry_count += 1

                if not taskPlan:
                    print("[!] Screenshot received but taskPlan is empty.")
                    continue

                if current_step_index >= len(taskPlan):
                    print("[*] All planned steps have been successfully executed.")
                    continue

                currentSubGoal = taskPlan[current_step_index]
                isDone = (current_step_index + 1) >= len(taskPlan)

                print(f"[*] Executing step {current_step_index + 1}/{len(taskPlan)}: '{currentSubGoal}'")

                try:
                    inner_action = await asyncio.to_thread(
                        predict_action,
                        base64_image=last_screenshot,
                        current_step=currentSubGoal,
                        step_index=current_step_index,
                        is_last_step=isDone
                    )

                    # Check if visual target was not located in screenshot (e.g. element below fold)
                    if inner_action.get("found") is False and retry_count < 3:
                        print(f"[!] Element '{currentSubGoal}' not located in current viewport. Rethinking...")
                        replan_res = await asyncio.to_thread(
                            replanTask,
                            user_prompt=active_prompt,
                            failed_step=currentSubGoal,
                            error_msg=f"Element '{currentSubGoal}' was not found in the current viewport/screenshot.",
                            completed_steps=completed_steps,
                            remaining_steps=taskPlan[current_step_index + 1:]
                        )
                        thought = replan_res.get("thought", "")
                        new_steps = replan_res.get("steps", [currentSubGoal])
                        print(f"[*] Model rethink thought: {thought}")
                        print(f"[*] Corrective steps: {new_steps}")
                        taskPlan = taskPlan[:current_step_index] + new_steps
                        retry_count += 1

                        # Predict action for the newly planned corrective step
                        currentSubGoal = taskPlan[current_step_index]
                        isDone = (current_step_index + 1) >= len(taskPlan)
                        inner_action = await asyncio.to_thread(
                            predict_action,
                            base64_image=last_screenshot,
                            current_step=currentSubGoal,
                            step_index=current_step_index,
                            is_last_step=isDone
                        )

                    await send_agent_action(
                        websocket=websocket,
                        request_id=active_request_id,
                        tab_id=active_tab_id,
                        step_index=current_step_index,
                        is_last_step=isDone,
                        inner_action=inner_action
                    )

                except Exception as err:
                    print(f"[!] Error generating action: {err}")
                    traceback.print_exc()
                    await websocket.send_text(json.dumps({
                        "type": "ERROR",
                        "request_id": active_request_id,
                        "error": str(err)
                    }))

            # Phase 3: Action Execution Result & Rethinking/Replanning
            elif message and msgType == "ACTION_RESULT":
                result = message.get("result", {})
                success = result.get("success", False)
                step_idx = result.get("step_index", current_step_index)

                if success:
                    print(f"[+] Step {step_idx + 1} executed successfully.")
                    if current_step_index < len(taskPlan):
                        completed_steps.append(taskPlan[current_step_index])
                    current_step_index += 1
                    retry_count = 0
                else:
                    error_desc = result.get("error", "Unknown execution failure")
                    print(f"[!] Step {step_idx + 1} failed: {error_desc}")

                    if retry_count < 3 and current_step_index < len(taskPlan):
                        failed_step = taskPlan[current_step_index]
                        print(f"[*] Rethinking failed step: '{failed_step}'...")

                        # Trigger replanner to adjust remaining steps with 8b model
                        replan_res = await asyncio.to_thread(
                            replanTask,
                            user_prompt=active_prompt,
                            failed_step=failed_step,
                            error_msg=error_desc,
                            completed_steps=completed_steps,
                            remaining_steps=taskPlan[current_step_index + 1:]
                        )
                        thought = replan_res.get("thought", "")
                        new_steps = replan_res.get("steps", [failed_step])

                        print(f"[*] Model rethink thought: {thought}")
                        print(f"[*] Plan updated following rethink:")
                        taskPlan = taskPlan[:current_step_index] + new_steps
                        retry_count += 1

                        for i, step in enumerate(taskPlan):
                            print(f"\t Step {i+1}: {step}")

                        # Immediately dispatch corrective action to client to continue pipeline
                        next_step = taskPlan[current_step_index]
                        isDone = (current_step_index + 1) >= len(taskPlan)
                        inner_action = await asyncio.to_thread(
                            predict_action,
                            base64_image=last_screenshot,
                            current_step=next_step,
                            step_index=current_step_index,
                            is_last_step=isDone
                        )
                        await send_agent_action(
                            websocket=websocket,
                            request_id=active_request_id,
                            tab_id=active_tab_id,
                            step_index=current_step_index,
                            is_last_step=isDone,
                            inner_action=inner_action
                        )
                    else:
                        print("[!] Max retries reached for this step. Moving to next planned step.")
                        current_step_index += 1
                        retry_count = 0

    except WebSocketDisconnect:
        print("[!] Extension disconnected.")
    except Exception as e:
        print(f"[!] Unexpected error: {e}")
        traceback.print_exc()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False, log_level="info")
