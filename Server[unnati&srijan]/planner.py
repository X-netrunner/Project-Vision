import json
import re
import ollama

def createPlan(user_prompt: str) -> list:
    plannerPrompt = f"""You are a browser automation planner.
Break down the following user goal into compact, actionable steps using tag prefixes.
Do NOT include steps like 'Open browser' or 'Launch Chrome' because the user is ALREADY inside an active tab.

Use ONLY these action tags:
- navigate: [URL or Domain]
- click: [Target element]
- type: [Query or text to input]
- press: [Key like Enter/Tab]

User Goal: "{user_prompt}"

Output ONLY a JSON object matching this exact schema:
{{
    "steps": [
        "navigate: amazon.com",
        "click: search bar",
        "type: mechanical keyboard",
        "press: Enter"
    ]
}}
"""

    try:
        response = ollama.chat(
            model="qwen2.5:7b-instruct-q4_K_M",
            messages=[{"role": "user", "content": plannerPrompt}],
            format="json"
        )

        content = response["message"]["content"].strip()

        if content.startswith("```"):
            content = re.sub(r"^```(?:json)?", "", content)
            content = re.sub(r"```$", "", content).strip()

        parsed = json.loads(content)
        if isinstance(parsed, dict):
            return parsed.get("steps", [])
        elif isinstance(parsed, list):
            return parsed
        return [f"navigate: {user_prompt}"]

    except Exception as e:
        print(f"[!] Planner JSON parsing error: {e}")
        return [f"search: {user_prompt}"]
