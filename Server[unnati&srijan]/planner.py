import json
import re
import ollama

def createPlan(user_prompt: str) -> list:
    """
    Takes a raw user prompt and returns a list of sub-goals.
    """
    plannerPrompt = f"""You are a browser automation planner.
    break down the following user goal into compact , actionable steps using tag prefixes.
    Do NOT include steps like 'Open browser' or 'Launch Chrome' because the user is ALREADY inside an active tab.

    Use ONLY these action tags:
    - NAVIGATE: [URL or Domain]
    - CLICK: [Target element]
    - TYPE: [Query or text to input]
    - PRESS: [Key like Enter/Tab]
        
    User Goal: "{user_prompt}"
    
    Output ONLY  a JSON object matching this exact schema:
    {{
        "steps": [
            "NAVIGATE: amazon.com",
            "CLICK: search bar",
            "TYPE: mechanical keyboard",
            "PRESS: Enter"
        ]
    }}
    """

    response = ollama.chat(
        #model ="qwen2.5:3b-instruct",
        #model = "qwen3:8b",
        model = "qwen2.5:7b-instruct-q4_K_M",
        messages=[{"role": "user", "content": plannerPrompt}],
        format="json" #trying to force it to use a json hope it works
    )

    content = response["message"]["content"].strip()

    # Clean markdown block markers if present
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?", "", content)
        content = re.sub(r"```$", "", content).strip()

    try:
        parsed = json.loads(content)
        return parsed.get("steps", [])
    except json.JSONDecodeError as e:
        print(f"[!] Planner JSON parsing error: {e}")
        return []
