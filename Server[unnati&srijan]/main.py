import asyncio
import re
import traceback
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import json
import os
import uuid
from planner import createPlan, replanTask
from vlm import predict_action, reason_about_failure, analyze_form, build_form_fill_plan
from logger_util import info, ok, warn, error, step as step_log, task as task_log, save_screenshot

SEP = "=" * 70

# Increment this whenever the server's behavior changes meaningfully, so the
# startup banner makes it obvious which build is running.
SERVER_VERSION = "2.1.0"

URL_RE = re.compile(r"https?://[^\s'\"]+", re.IGNORECASE)


def is_form_goal(prompt: str) -> bool:
    """Return True when the user's request clearly asks to fill a web form."""
    p = (prompt or "").lower()
    has_form = "form" in p or "google forms" in p or "feedback" in p
    fill_verb = any(v in p for v in ["fill", "fill out", "submit this", "complete the form"])
    has_url = bool(URL_RE.search(prompt or ""))
    return has_form and (fill_verb or has_url)


def extract_url(prompt: str) -> str | None:
    m = URL_RE.search(prompt or "")
    return m.group(0) if m else None

app = FastAPI(title="Project Vision Browser Automation Server")


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "browser-automation-server", "version": SERVER_VERSION}


def setup_file_logging():
    """Redirect stdout/stderr to both console and logs/server.log."""
    log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "server.log")


setup_file_logging()


async def send_agent_action(websocket, request_id, tab_id, step_index, is_last_step, inner_action):
    payload = {
        "type": "AGENT_ACTION",
        "request_id": request_id,
        "action_id": f"action_{uuid.uuid4().hex[:6]}",
        "step_index": step_index,
        "is_last_step": is_last_step,
        "action": inner_action,
    }
    if tab_id is not None:
        payload["tab_id"] = tab_id
    step_log(f"Sending AGENT_ACTION step {step_index + 1} -> {json.dumps(inner_action)}")
    await websocket.send_text(json.dumps(payload))


async def handle_rethink(
    websocket, active_prompt, failed_step, error_msg,
    completed_steps, remaining_steps, taskPlan, current_step_index,
    active_request_id, active_tab_id, last_screenshot, device_pixel_ratio, retry_count,
):
    """Use VLM to look at the screenshot + planner to generate corrective steps, then dispatch."""
    max_retries = 3
    if retry_count >= max_retries:
        warn(f"Max retries ({max_retries}) reached for step. Skipping it.")
        current_step_index += 1
        retry_count = 0
        return taskPlan, current_step_index, retry_count

    warn(f"Rethink triggered on failed step: '{failed_step}'")
    warn(f"Error: {error_msg}")

    vlm_reason = ""
    if last_screenshot:
        try:
            info("Running VLM visual analysis on failure screenshot...")
            vlm_reason = await asyncio.to_thread(
                reason_about_failure,
                base64_image=last_screenshot,
                user_goal=active_prompt,
                failed_step=failed_step,
                error_msg=error_msg,
                completed_steps=completed_steps,
            )
            info(f"VLM visual analysis: {vlm_reason}")
        except Exception as e:
            warn(f"VLM reasoning failed: {e}")

    combined_error = error_msg
    if vlm_reason:
        combined_error = f"{error_msg} | VLM sees: {vlm_reason}"

    info("Calling replanner with rethink context...")
    replan_res = await asyncio.to_thread(
        replanTask,
        user_prompt=active_prompt,
        failed_step=failed_step,
        error_msg=combined_error,
        completed_steps=completed_steps,
        remaining_steps=remaining_steps,
    )
    thought = replan_res.get("thought", "")
    new_steps = replan_res.get("steps", [failed_step])
    info(f"Rethink thought: {thought}")
    info(f"Corrective steps: {new_steps}")

    taskPlan = taskPlan[:current_step_index] + new_steps
    retry_count += 1

    if current_step_index < len(taskPlan):
        next_step = taskPlan[current_step_index]
        isDone = (current_step_index + 1) >= len(taskPlan)
        info(f"Predicting corrective action for '{next_step}'...")
        inner_action = await asyncio.to_thread(
            predict_action,
            base64_image=last_screenshot,
            current_step=next_step,
            step_index=current_step_index,
            is_last_step=isDone,
            device_pixel_ratio=device_pixel_ratio,
        )
        await send_agent_action(
            websocket=websocket,
            request_id=active_request_id,
            tab_id=active_tab_id,
            step_index=current_step_index,
            is_last_step=isDone,
            inner_action=inner_action,
        )

    return taskPlan, current_step_index, retry_count


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    info("Connection established with Extension")

    taskPlan = []
    completed_steps = []
    current_step_index = 0
    active_prompt = ""
    active_request_id = "req_001"
    active_tab_id = None
    retry_count = 0
    last_screenshot = ""
    device_pixel_ratio = 1.0
    # Highest step index whose success we have already counted. The extension
    # confirms each completed step TWICE (a standalone ACTION_RESULT AND a
    # screenshot with the same bundled action_result). We must count each step
    # exactly once, so we dedupe by this index rather than by message order.
    last_confirmed_step = -1

    # Form-fill state. 'form_mode' marks an active form-filling task.
    # 'form_stage' is "navigate" (still going to the form URL), "analyze"
    # (about to read fields from the loaded screenshot), or "fill" (filling).
    form_mode = False
    form_stage = "navigate"

    try:
        while True:
            rawData = await websocket.receive_text()
            try:
                message = json.loads(rawData)
                msgType = message.get("type") if isinstance(message, dict) else "STRING_PROMPT"
            except json.JSONDecodeError:
                message = None
                msgType = "STRING_PROMPT"

            # ══════════════ Phase 1: User Prompt ══════════════
            if msgType in ["USER_PROMPT", "STRING_PROMPT"]:
                if isinstance(message, dict):
                    active_prompt = message.get("prompt", "").strip()
                    active_request_id = message.get("request_id", f"req_{uuid.uuid4().hex[:6]}")
                else:
                    active_prompt = rawData.strip()
                    active_request_id = f"req_{uuid.uuid4().hex[:6]}"

                if not active_prompt:
                    warn("Received empty prompt; ignoring.")
                    continue

                task_log(SEP)
                task_log(f"Received USER PROMPT ({active_request_id}): '{active_prompt}'")

                completed_steps = []
                current_step_index = 0
                retry_count = 0
                last_confirmed_step = -1

                # Form-fill goals get a dedicated pipeline instead of the generic planner.
                form_mode = is_form_goal(active_prompt)
                if form_mode:
                    form_url = extract_url(active_prompt)
                    task_log("Detected a FORM-FILL goal. Using form pipeline.")
                    if form_url:
                        task_log(f"  form url: {form_url}")
                        taskPlan = [f"navigate: {form_url}"]
                        form_stage = "navigate"
                    else:
                        task_log("  no url given; filling the form currently on screen.")
                        taskPlan = []
                        form_stage = "analyze"
                    task_log(f"Form plan ({len(taskPlan)} steps):")
                    for i, step_ in enumerate(taskPlan):
                        task_log(f"    Step {i + 1}: {step_}")
                    task_log("Waiting for initial screenshot from extension...")
                    continue

                task_log(f"Generating task plan with Qwen3 8B planner (ollama)...")
                taskPlan = await asyncio.to_thread(createPlan, active_prompt)
                form_stage = "navigate"

                task_log(f"Task plan generated ({len(taskPlan)} steps):")
                for i, step_ in enumerate(taskPlan):
                    task_log(f"    Step {i + 1}: {step_}")
                task_log("Waiting for initial screenshot from extension...")

            # ══════════════ Phase 2: Screenshots & Action Prediction ══════════════
            elif message and msgType in ["RAW_SCREENSHOT", "REDACTED_SCREENSHOT"]:
                active_request_id = message.get("request_id", active_request_id)
                active_tab_id = message.get("tab_id", active_tab_id)
                device_pixel_ratio = message.get("device_pixel_ratio", device_pixel_ratio)
                base64_img = message.get("image", "")
                img_type = msgType

                # Store the screenshot for later analysis + debugging
                shot_label = f"step{current_step_index + 1}"
                if base64_img:
                    last_screenshot = base64_img
                    saved = save_screenshot(base64_img, shot_label)
                    info(f"Received {img_type} screenshot ({len(base64_img)} chars) saved={saved}")

                # Handle bundled action_result (client confirms previous action).
                # The extension may also send a standalone ACTION_RESULT for the
                # same step, so dedupe by the confirmed step index.
                bundled = message.get("action_result")
                if isinstance(bundled, dict):
                    b_success = bundled.get("success") is True
                    b_step = bundled.get("step_index", current_step_index)
                    if b_success:
                        if b_step == last_confirmed_step + 1 and b_step < len(taskPlan):
                            completed_steps.append(taskPlan[b_step])
                            current_step_index = b_step + 1
                            last_confirmed_step = b_step
                            retry_count = 0
                            ok(f"Step {b_step + 1} confirmed success (bundled).")
                        else:
                            info(f"Bundled success for step {b_step + 1} ignored (already counted/out of range).")
                    else:
                        error_desc = bundled.get("error", "Client execution failed")
                        taskPlan, current_step_index, retry_count = await handle_rethink(
                            websocket, active_prompt, taskPlan[last_confirmed_step + 1], error_desc,
                            completed_steps, taskPlan[last_confirmed_step + 2:],
                            taskPlan, last_confirmed_step + 1, active_request_id, active_tab_id,
                            last_screenshot, device_pixel_ratio, retry_count,
                        )
                        last_confirmed_step = current_step_index - 1

                # ── Form-fill: once navigation is done (or form already on screen),
                #    analyze the form and build the per-field fill plan. ──
                if form_mode and form_stage == "navigate" and current_step_index >= len(taskPlan):
                    form_stage = "analyze"
                if form_mode and form_stage == "analyze" and last_screenshot:
                    task_log("Running form analysis on loaded form screenshot...")
                    form_fields = await asyncio.to_thread(analyze_form, last_screenshot)
                    fill_plan = await asyncio.to_thread(build_form_fill_plan, form_fields)
                    if not fill_plan:
                        warn("Form analysis produced no auto-fillable (non-PII) fields.")
                        task_log("Skipping PII/redacted fields. Task complete - user fills those.")
                        form_mode = False
                        continue
                    task_log(f"Form fill plan ({len(fill_plan)} steps):")
                    for i, s in enumerate(fill_plan):
                        task_log(f"    Fill step {i + 1}: {s}")
                    taskPlan = fill_plan
                    completed_steps = []
                    current_step_index = 0
                    retry_count = 0
                    last_confirmed_step = -1
                    form_stage = "fill"

                if not taskPlan:
                    warn("Screenshot received but taskPlan is empty.")
                    continue

                if current_step_index >= len(taskPlan):
                    ok("All planned steps executed successfully. Task complete.")
                    continue

                currentSubGoal = taskPlan[current_step_index]
                isDone = (current_step_index + 1) >= len(taskPlan)

                step_log(f"Executing step {current_step_index + 1}/{len(taskPlan)}: '{currentSubGoal}'")
                step_log(f"    is_last_step={isDone} | dpr={device_pixel_ratio} | tab_id={active_tab_id}")

                try:
                    info("Calling Qwen2.5-VL (GPU) predict_action...")
                    inner_action = await asyncio.to_thread(
                        predict_action,
                        base64_image=last_screenshot,
                        current_step=currentSubGoal,
                        step_index=current_step_index,
                        is_last_step=isDone,
                        device_pixel_ratio=device_pixel_ratio,
                    )
                    step_log(f"VLM predicted action: {json.dumps(inner_action)}")

                    if inner_action.get("found") is False:
                        warn(f"Element '{currentSubGoal}' not located in viewport. Rethinking...")
                        taskPlan, current_step_index, retry_count = await handle_rethink(
                            websocket, active_prompt, currentSubGoal,
                            f"Element '{currentSubGoal}' not found in viewport.",
                            completed_steps, taskPlan[current_step_index + 1:],
                            taskPlan, current_step_index, active_request_id, active_tab_id,
                            last_screenshot, device_pixel_ratio, retry_count,
                        )
                        last_confirmed_step = current_step_index - 1
                        continue

                    await send_agent_action(
                        websocket=websocket,
                        request_id=active_request_id,
                        tab_id=active_tab_id,
                        step_index=current_step_index,
                        is_last_step=isDone,
                        inner_action=inner_action,
                    )

                except Exception as err:
                    error(f"Error generating action: {err}")
                    traceback.print_exc()
                    await websocket.send_text(json.dumps({
                        "type": "ERROR",
                        "request_id": active_request_id,
                        "error": str(err),
                    }))

            # ══════════════ Phase 3: Standalone ACTION_RESULT ══════════════
            elif message and msgType == "ACTION_RESULT":
                result = message.get("result", {})
                success = result.get("success", False)
                step_idx = result.get("step_index", current_step_index)

                if success:
                    if step_idx == last_confirmed_step + 1 and step_idx < len(taskPlan):
                        completed_steps.append(taskPlan[step_idx])
                        current_step_index = step_idx + 1
                        last_confirmed_step = step_idx
                        retry_count = 0
                        ok(f"Step {step_idx + 1} executed successfully.")
                    else:
                        info(f"Standalone ACTION_RESULT for step {step_idx + 1} ignored (already counted/out of range).")
                else:
                    error_desc = result.get("error", "Unknown execution failure")
                    failed_i = last_confirmed_step + 1
                    if failed_i < len(taskPlan):
                        taskPlan, current_step_index, retry_count = await handle_rethink(
                            websocket, active_prompt, taskPlan[failed_i], error_desc,
                            completed_steps, taskPlan[failed_i + 1:],
                            taskPlan, failed_i, active_request_id, active_tab_id,
                            last_screenshot, device_pixel_ratio, retry_count,
                        )
                        last_confirmed_step = current_step_index - 1

    except WebSocketDisconnect:
        warn("Extension disconnected.")
    except Exception as e:
        error(f"Unexpected error: {e}")
        traceback.print_exc()


def print_banner():
    print()
    print("=" * 66)
    print("  Project Vision  |  Browser Automation Server")
    print(f"  VERSION: {SERVER_VERSION}")
    print("=" * 66)
    print()


if __name__ == "__main__":
    import uvicorn
    print_banner()
    info(f"Starting server v{SERVER_VERSION} on 0.0.0.0:8001")
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False, log_level="info")
