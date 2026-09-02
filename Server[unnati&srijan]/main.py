import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import json
import uuid
from planner import createPlan
from vlm import predict_action

app = FastAPI() #initialize the server

#we also have to define the websocket route
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    #accept the incomming connection from sushanth
    await websocket.accept()
    print("[*] Connection established with Sushanth")

    #var to track the active task plan across websocket frams
    taskPlan = []
    current_step_index = 0
    active_request_id = "req_001"
    active_tab_id = 123

    try:
        while True: #we want the connecion to be open forever so we will make a inf loop
            #we wait for the msg to come if it does
            rawData = await websocket.receive_text()
            try:
                message = json.loads(rawData)
                msgType = message.get("type")
            except json.JSONDecodeError:
                message = None
                msgType = "STRING_PROMPT"

            #phase 1: Initial Prompt Generation
            if msgType == "STRING_PROMPT":            
                userPrompt = rawData.strip()
                if not userPrompt:
                    continue   
                      
                active_request_id = f"req_{uuid.uuid4().hex[:6]}"
                print(f"[*] Received prompt ({active_request_id}) :", userPrompt)
                
                # Run synchronous Ollama planner in a background thread to keep WebSocket connection alive
                taskPlan = await asyncio.to_thread(createPlan, userPrompt)
                current_step_index = 0
                
                print(f"[*] Task plan generated ({len(taskPlan)} steps):")

                for i, step in enumerate(taskPlan):
                    print(f"\t Step {i+1}: {step}")

                # Send initial instruction step or wait for screenshot
                responsePayload = {
                    "type": "REQUEST_SS",
                    "request_id": active_request_id,
                    "payload": {
                        "current_step": taskPlan[current_step_index] if taskPlan else "DONE",
                        "step_index": current_step_index,
                        "total_steps": len(taskPlan)
                    }
                }
                await websocket.send_text(json.dumps(responsePayload))
                print("[*] Requested screenshot for Step 1: ", taskPlan[0] if taskPlan else "None")

            #phase 2: Process Redacted Screenshots from Varun via Sushanth
            elif message and msgType == "REDACTED_SCREENSHOT":
                active_request_id = message.get("request_id", active_request_id)
                active_tab_id = message.get("tab_id", active_tab_id)
                base64_img = message.get("image", "")

                currentSubGoal = taskPlan[current_step_index] if current_step_index < len(taskPlan) else "CLICK: submit"
                print(f"[*] Received REDACTED_SCREENSHOT for step {current_step_index + 1}/{len(taskPlan)}: '{currentSubGoal}'")

                isDone = (current_step_index + 1) >= len(taskPlan)
                
                try:
                    # Run heavy GPU Vision inference in a background thread
                    inner_action = await asyncio.to_thread(
                        predict_action,
                        base64_image=base64_img,
                        current_step=currentSubGoal,
                        step_index=current_step_index,
                        is_last_step=isDone
                    )

                    # Wrap payload into official AGENT_ACTION team format
                    agent_action_payload = {
                        "type": "AGENT_ACTION",
                        "request_id": active_request_id,
                        "action_id": f"action_{uuid.uuid4().hex[:6]}",
                        "tab_id": active_tab_id,
                        "step_index": current_step_index,
                        "is_last_step": isDone,
                        "action": inner_action
                    }

                    print(f"[+] Sending AGENT_ACTION: {agent_action_payload}")
                    await websocket.send_text(json.dumps(agent_action_payload))
                    
                    current_step_index += 1
                except ValueError as err:
                    print(f"[!] Error processing image: {err}")
                    errorPayload = {
                        "type": "ERROR",
                        "request_id": active_request_id,
                        "error": str(err)
                    }
                    await websocket.send_text(json.dumps(errorPayload))

            #phase 3: Receive Action Execution Feedback
            elif message and msgType == "ACTION_RESULT":
                result = message.get("result", {})
                success = result.get("success", False)
                if success:
                    print(f"[+] Action step {result.get('step_index')} executed successfully.")
                else:
                    print(f"[!] Action step {result.get('step_index')} failed: {result.get('error')}")

    except WebSocketDisconnect:
        print("[!] Extension disconnected")

if __name__ == "__main__":
    import uvicorn
    # Set reload=False to avoid multi-GB model duplicate loads and port lockups on Port 8001
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False)
