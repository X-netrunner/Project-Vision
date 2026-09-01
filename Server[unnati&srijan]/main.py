from fastapi import FastAPI,WebSocket, WebSocketDisconnect
import json
import ollama

def createPlan(user_prompt: str) -> list:
    """
    Takes a raw user prompt and returns a list of sub-goals.
    """
    plannerPrompt = f"""You are a web navigation planner.
    break down the following user goal into a sequential array of simple, executable browser steps.
    User Goal: "{user_prompt}"

    Output ONLY  a JSON object matching this exact schema:

    {{
        "steps": ["step 1 description", "step 2 description"]
    }}
    """

    response = ollama.chat(
        #model ="qwen2.5:3b-instruct",
        #model = "qwen3:8b",
        model = "qwen2.5:7b-instruct-q4_K_M",
        messages=[{"role": "user", "content": plannerPrompt}],
        format="json" #trying to force it to use a json hope it works
    )

    parsed = json.loads(response["message"]["content"])
    return parsed.get("steps",[])

app = FastAPI() #initialize the server

#we also have to define the websocket route
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    #accept the incomming connection from sushanth
    await websocket.accpet()
    print("[*] Connection established with Sushanth")
    try:
        while True: #we want the connecion to be open forever so we will make a inf loop
            #we wait for the msg to come if it does
            raw_data = await websocket.receive_text()
            message = json.loads(raw_data) 
            print("[*] Recived msg :", message)

            #lets check if we can send a message back for now
            test_resp = {"status" : "Message received"}
            await websocket.send_text(json.dumps(test_resp))
    except WebSocketDisconnect:
        print("[!] Extension disconnected")

if __name__ == "__main__":
    test_prompt = input("Give a prompt :")
    print("[*] Testing Planner LLM...")
    plan = createPlan(test_prompt)
    print("[*] Generate Plan",plan)
            
