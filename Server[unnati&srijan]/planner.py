import json
import re
import ollama

PLANNER_MODEL = "qwen3:8b"


def createPlan(user_prompt: str) -> list:
    plannerPrompt = f"""You are an expert browser automation planner. You receive a user's goal and break it into minimal, correct steps.

CRITICAL RULES:
1. NEVER include browser startup steps (no "Open browser", "Launch Chrome").
2. Analyze the user's ACTUAL intent. If they say "search for the history of ipads", they want a SEARCH RESULTS page, NOT an e-commerce flow. Do NOT add "Add to Cart" steps unless the user explicitly mentions purchasing or adding to cart.
3. If the user says "in flipkart add this to cart" or "add to cart", they are already on the product page and want to add the CURRENTLY VIEWED item. Steps: just scroll down and click Add to Cart. Do NOT search again.
4. If the user says "add [specific product] to cart from flipkart/amazon" and doesn't mention being on the site, start with navigate to the site, then click the search bar, type the product name, press Enter, then add to cart. On e-commerce homepages the search box is NOT auto-focused, so you MUST have an explicit "click: search bar" step before any "type:" step.
5. For search queries on Google/Bing ("search for X", "look up X", "find X"), the steps are: navigate to google.com, click search bar, type query, press Enter. Then stop - do NOT click specific results unless the user asked to.
6. Screenshots have faces and PII redacted with blur/black boxes. This is NORMAL privacy protection. Do NOT treat redactions as errors. Plan steps that interact with standard UI elements only.
7. URL PRESERVATION: If the user provides a full URL in their request (e.g. a https://docs.google.com/forms/d/... link), the FIRST action MUST be "navigate: <the EXACT full URL>" with the ENTIRE URL kept intact - do NOT trim it to just the domain. Only shorten to a bare domain when the user gave a domain name like "amazon.com" or "google.com".
8. FORM FILLING: If the user asks to fill a form or provides a form URL, DO NOT produce placeholder steps like "type: [user input]" or "click: Form title". Instead just output a SINGLE step "navigate: <full form url>" (or none if already there). The server handles the actual per-field filling automatically, so your job is ONLY to get to the form page. Do not invent field/type steps for forms.

SUPPORTED ACTION TAGS:
- navigate: [URL or Domain] - only if user needs to go to a new site
- click: [Target element description] - visual element on the page
- type: [Text to type] - into the currently focused input
- press: [Key like Enter/Tab/Escape]
- scroll: [down/up]
- switch_tab

USER GOAL: "{user_prompt}"

Output ONLY a JSON object:
{{"steps": ["step1", "step2", ...]}}"""

    try:
        response = ollama.chat(
            model=PLANNER_MODEL,
            messages=[{"role": "user", "content": plannerPrompt}],
            format="json",
            think=False,
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
        return [user_prompt]

    except Exception as e:
        print(f"[!] Planner error: {e}")
        return [f"search: {user_prompt}"]


def replanTask(
    user_prompt: str,
    failed_step: str,
    error_msg: str,
    completed_steps: list = None,
    remaining_steps: list = None,
) -> dict:
    if completed_steps is None:
        completed_steps = []
    if remaining_steps is None:
        remaining_steps = []

    replanPrompt = f"""You are an expert browser automation planner recovering from a failure. You have visual context about what went wrong.

USER GOAL: "{user_prompt}"
COMPLETED STEPS: {json.dumps(completed_steps)}
FAILED STEP: "{failed_step}"
ERROR / VISUAL CONTEXT: "{error_msg}"
REMAINING STEPS: {json.dumps(remaining_steps)}

RETHINKING RULES:
1. DO NOT repeat the exact same failed step without a corrective action first.
2. DO NOT restart the entire flow if previous steps already succeeded.
3. Common failure patterns and fixes:
   - Element not found in viewport -> scroll down first, then retry click
   - Popup/modal/overlay blocking -> press Escape or click close, then continue
   - Search bar not found -> click on the search area first
   - Page not loaded yet -> press Enter or wait, then retry
   - Wrong page/tab -> switch_tab, then continue
   - Product variant needed (size/color) -> click variant option first, then Add to Cart
   - Login redirect -> press Escape to dismiss login popup, continue on main page
4. The VLM visual analysis above may tell you exactly what's on screen. Use that info.
5. Keep corrective steps minimal (1-3 steps). Don't overcomplicate.

Output ONLY a JSON object:
{{"thought": "Brief explanation of what went wrong and the corrective strategy", "steps": ["corrective_step1", "corrective_step2"]}}"""

    try:
        response = ollama.chat(
            model=PLANNER_MODEL,
            messages=[{"role": "user", "content": replanPrompt}],
            format="json",
            think=False,
        )

        content = response["message"]["content"].strip()
        if content.startswith("```"):
            content = re.sub(r"^```(?:json)?", "", content)
            content = re.sub(r"```$", "", content).strip()

        parsed = json.loads(content)
        if isinstance(parsed, dict):
            if "steps" not in parsed:
                parsed["steps"] = [failed_step]
            if "thought" not in parsed:
                parsed["thought"] = "Rethinking corrective steps."
            return parsed
        elif isinstance(parsed, list):
            return {"thought": "Generated corrective steps.", "steps": parsed}
        return {"thought": "Fallback.", "steps": [failed_step]}

    except Exception as err:
        print(f"[!] Replanner error: {err}")
        return {"thought": f"Replanner error: {err}", "steps": [failed_step]}
