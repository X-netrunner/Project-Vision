import json
import re
import ollama

PLANNER_MODEL = "qwen3:8b"

def createPlan(user_prompt: str) -> list:
    plannerPrompt = f"""You are an expert browser automation planner.
Break down the user goal into a concise, ordered list of actionable steps using tag prefixes.

Rules:
1. Do NOT include browser startup steps like 'Open browser' or 'Launch Chrome'.
2. If the user mentions being on a site or implies interacting with an already open page (e.g., "in flipkart add this to cart", "i am on flipkart add to cart", "add this to cart"), do NOT issue a navigate step. Directly interact with the current page.
3. If the user asks to add something to cart from Flipkart/Amazon from scratch and isn't on the site, begin with 'navigate: flipkart.com' (or the respective site).
4. For e-commerce and Flipkart 'add to cart' goals:
   - If the user wants to add the currently viewed/open item ('this item', 'this to cart', 'add to cart'):
     ['scroll: down', 'click: Add to Cart']
   - If searching for a specific product:
     ['click: search bar', 'type: [extracted product]', 'press: Enter', 'click: first product result', 'scroll: down', 'click: Add to Cart']
5. Privacy & Redaction: Webpage screenshots have faces (avatars/photos) and sensitive PII (names, delivery addresses, phone numbers, payment details) redacted with blur or solid blackout boxes. This is completely intentional privacy protection. DO NOT panic or treat redactions as errors. Focus on visible UI elements (buttons, inputs, product listings).
6. Keep tag targets simple, visual, and concise (e.g. "search bar", "first product result", "Add to Cart", "close popup").

Use ONLY these action tags:
- navigate: [URL or Domain]
- click: [Target element description]
- type: [Text to type]
- press: [Key like Enter/Tab/Escape]
- scroll: [down/up]
- switch_tab

Examples:
Goal: "in flipkart add this to cart"
Output: {{"steps": ["scroll: down", "click: Add to Cart"]}}

Goal: "in flipkart add boAt earphones to cart"
Output: {{"steps": ["click: search bar", "type: boAt earphones", "press: Enter", "click: first product result", "scroll: down", "click: Add to Cart"]}}

Goal: "add running shoes to cart from flipkart"
Output: {{"steps": ["navigate: flipkart.com", "click: search bar", "type: running shoes", "press: Enter", "click: first product result", "scroll: down", "click: Add to Cart"]}}

User Goal: "{user_prompt}"

Output ONLY a JSON object with this exact structure:
{{
    "steps": [
        "click: search bar",
        "type: wireless mouse",
        "press: Enter",
        "click: first product result",
        "scroll: down",
        "click: Add to Cart"
    ]
}}
"""

    try:
        response = ollama.chat(
            model=PLANNER_MODEL,
            messages=[{"role": "user", "content": plannerPrompt}],
            format="json",
            think=False
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
        print(f"[!] Planner JSON parsing error: {e}")
        return [f"search: {user_prompt}"]


def replanTask(
    user_prompt: str,
    failed_step: str,
    error_msg: str,
    completed_steps: list = None,
    remaining_steps: list = None
) -> dict:
    """
    Rethinks the plan when an action fails or element is missing.
    Considers completed steps, what went wrong, what NOT to do, and generates corrective steps.
    Returns a dict with 'thought' and 'steps'.
    """
    if completed_steps is None:
        completed_steps = []
    if remaining_steps is None:
        remaining_steps = []

    replanPrompt = f"""You are an expert browser automation planner recovering from an execution failure.
You must think carefully about what went wrong, what to do, and what NOT to do to achieve the user's goal.

Critical Context:
1. Privacy Redactions: Webpage screenshots have faces and sensitive PII (names, delivery addresses, phone numbers, payment details) masked with blur or black boxes. DO NOT PANIC about redacted faces or PII. Redactions are expected and normal. Never attempt to click or interact with redacted black or blurred boxes.
2. Strategy for Failures (What to do vs What NOT to do):
   - What NOT to do:
     * Do NOT repeat the exact same failed step blindly without an intermediate corrective action.
     * Do NOT restart the entire process from step 1 if prior steps succeeded.
     * Do NOT panic over redacted boxes or treat them as errors.
   - What to do:
     * If 'click: Add to Cart' failed or wasn't found in viewport, the button is likely below the fold: issue 'scroll: down' before 'click: Add to Cart'.
     * If a popup, login banner, or overlay (e.g. Flipkart login popup) is blocking the screen: issue 'press: Escape' or 'click: close popup'.
     * If a product needs size, color, or variant selection before adding to cart: issue 'click: select variant' then 'click: Add to Cart'.
     * If product opened in a new tab: issue 'switch_tab' then continue.
     * If search or typing failed: re-click 'click: search bar' then 'press: Enter'.

User Goal: "{user_prompt}"
Completed Steps: {completed_steps}
Failed Step: "{failed_step}"
Error Encountered: "{error_msg}"
Remaining Steps: {remaining_steps}

Provide a thoughtful rethink explaining the failure and 1-3 corrective replacement steps.

Output ONLY a JSON object matching this exact schema:
{{
    "thought": "Detailed reasoning explaining what went wrong, what not to do, and the corrective strategy",
    "steps": [
        "scroll: down",
        "click: Add to Cart"
    ]
}}
"""

    try:
        response = ollama.chat(
            model=PLANNER_MODEL,
            messages=[{"role": "user", "content": replanPrompt}],
            format="json",
            think=False
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
                parsed["thought"] = "Rethinking corrective steps following failure."
            return parsed
        elif isinstance(parsed, list):
            return {
                "thought": "Rethinking corrective steps following failure.",
                "steps": parsed
            }
        return {
            "thought": "Fallback to original failed step.",
            "steps": [failed_step]
        }
    except Exception as err:
        print(f"[!] Replanner error: {err}")
        return {
            "thought": f"Replanner error encountered: {err}",
            "steps": [failed_step]
        }
