import base64
import io
import json
import math
import re
from PIL import Image
from transformers import (
    AutoProcessor,
    Qwen2_5_VLForConditionalGeneration,
    BitsAndBytesConfig,
)
import torch

MODEL_ID = "Qwen/Qwen2.5-VL-3B-Instruct"

if not torch.cuda.is_available():
    raise RuntimeError("CUDA GPU is required but not available. Cannot start VLM.")

torch.cuda.empty_cache()

gpu_name = torch.cuda.get_device_name(0)
free_gb = torch.cuda.mem_get_info()[0] / 1e9
total_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
print(f"[*] GPU: {gpu_name} | Total: {total_gb:.1f} GB | Free: {free_gb:.1f} GB")

quantization_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_compute_dtype=torch.float16,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_use_double_quant=True,
)

print(f"[*] Loading {MODEL_ID} with 4-bit quantization...")


def _load_model():
    return Qwen2_5_VLForConditionalGeneration.from_pretrained(
        MODEL_ID,
        quantization_config=quantization_config,
        device_map="cuda:0",
        low_cpu_mem_usage=True,
    )


try:
    model = _load_model()
except (torch.OutOfMemoryError, RuntimeError) as e:
    print(f"[!] VLM load hit memory error ({e}). Freeing GPU cache and retrying...")
    torch.cuda.empty_cache()
    model = _load_model()

processor = AutoProcessor.from_pretrained(MODEL_ID)

used_gb = (total_gb - torch.cuda.mem_get_info()[0] / 1e9)
print(f"[*] Model loaded on GPU | VRAM used: {used_gb:.1f} GB")

REDACTION_SYSTEM_INSTRUCTION = (
    "PRIVACY REDACTION NOTICE: This screenshot has all human faces, avatars, and PII "
    "(names, emails, phone numbers, addresses, payment info) intentionally masked with "
    "blur or solid black/grey bounding boxes. These redactions are NORMAL and EXPECTED. "
    "DO NOT PANIC, fail, or abort because of redactions. "
    "NEVER attempt to click, read, or interact with redacted/blacked-out areas. "
    "Focus ONLY on visible unredacted UI elements like buttons, text fields, menus, "
    "product listings, and navigation controls."
)

REDACTION_SYSTEM_INSTRUCTION_SHORT = (
    "Note: blacked-out/masked rectangles are redacted PII/faces; ignore them and "
    "focus on the visible unredacted UI only."
)

PAIR_RE = r"\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)"


def sanitize_dpr(device_pixel_ratio) -> float:
    """Coerce the extension-reported devicePixelRatio into a sane value.

    The VLM->CSS conversion (target_css = normalized * image_px / dpr) is only
    correct when image_px == innerWidth*dpr. Reporting a bad/odd dpr silently
    shifts every click. Return a defensible value: 1.0 if missing, invalid, or
    non-finite; otherwise clamp to the realistic browser range [0.5, 4.0].
    """
    try:
        d = float(device_pixel_ratio)
    except (TypeError, ValueError):
        return 1.0
    if d <= 0 or not math.isfinite(d):
        return 1.0
    return min(max(d, 0.5), 4.0)


def _xyxy_from_4tuple(vals, width: int = 1920, height: int = 1080) -> tuple | None:
    """Convert raw [x1,y1,x2,y2] into image pixel center (cx, cy).

    Qwen2.5-VL natively predicts absolute pixel coordinates directly matching
    the input image dimensions. If values are 0-1 normalized, scales to pixels.
    """
    if not vals or len(vals) != 4:
        return None
    try:
        x1, y1, x2, y2 = map(float, vals)
    except (TypeError, ValueError):
        return None
    if min(x1, y1, x2, y2) < 0:
        return None

    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0

    # If coordinates are 0.0 - 1.0 normalized
    if max(x1, x2) <= 1.0 and max(y1, y2) <= 1.0:
        return cx * width, cy * height

    # Qwen2.5-VL native outputs are absolute image pixels
    return cx, cy


def parse_box_center(output_text: str, width: int = 1920, height: int = 1080) -> tuple | None:
    """Parse a grounding box center in image pixels from the model output.

    Qwen2.5-VL emits bounding boxes in several wrappers but always in
    [x1,y1,x2,y2] order (X horizontal, Y vertical):
      - <|box_start|>(x1,y1),(x2,y2)<|box_end|>
      - (x1,y1),(x2,y2) plain pairs
      - [x1,y1,x2,y2] bracketed array
      - JSON {"bbox_2d": [x1,y1,x2,y2], ...}
    Returns the box center in image pixel coordinates (pixel_x, pixel_y).
    """
    if not output_text:
        return None

    # 1) box_start / pair format: <|box_start|>(x1,y1),(x2,y2)<|box_end|>
    m = re.search(
        r"<\|box_start\|>\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)\s*,\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)\s*<\|box_end\|>",
        output_text, re.IGNORECASE,
    )
    if m:
        return _xyxy_from_4tuple(m.groups(), width, height)

    # 1b) Flat tuple box_start WITHOUT pair syntax: (x1,y1,x2,y2)
    m = re.search(
        r"<\|box_start\|>\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)\s*<\|box_end\|>",
        output_text, re.IGNORECASE,
    )
    if m:
        return _xyxy_from_4tuple(m.groups(), width, height)

    # 2) JSON bbox_2d array
    m = re.search(r'"bbox_2d"\s*:\s*\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]', output_text)
    if m:
        return _xyxy_from_4tuple(m.groups(), width, height)

    # 3) Bracketed array [x1,y1,x2,y2]
    m = re.search(r"\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]", output_text)
    if m:
        return _xyxy_from_4tuple(m.groups(), width, height)

    # 4) Flat 4-tuple in parentheses: (x1,y1,x2,y2)
    m = re.search(
        r"\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)",
        output_text,
    )
    if m:
        return _xyxy_from_4tuple(m.groups(), width, height)

    # 5) Plain two-pair fallback
    pairs = re.findall(PAIR_RE, output_text)
    if len(pairs) == 1:
        px, py = float(pairs[0][0]), float(pairs[0][1])
        if px <= 1.0 and py <= 1.0:
            return px * width, py * height
        return px, py
    if len(pairs) >= 2:
        (x1, y1), (x2, y2) = pairs[:2]
        return _xyxy_from_4tuple((x1, y1, x2, y2), width, height)

    return None


def decode_base64_image(base64_string: str) -> Image.Image:
    if not base64_string or not isinstance(base64_string, str):
        raise ValueError("Received empty or non-string Base64 image payload.")

    base64_string = base64_string.strip().strip('"').strip("'")
    if "," in base64_string:
        base64_string = base64_string.split(",", 1)[1]
    base64_string = "".join(base64_string.split())

    missing_padding = len(base64_string) % 4
    if missing_padding == 2:
        base64_string += "=="
    elif missing_padding == 3:
        base64_string += "="

    image_bytes = base64.b64decode(base64_string)
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def _run_vlm_inference(image: Image.Image, prompt: str, max_new_tokens: int = 128) -> str:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[text], images=[image], padding=True, return_tensors="pt").to("cuda:0")

    with torch.no_grad():
        try:
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                num_beams=1,
            )
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                num_beams=1,
            )

    # Only decode the newly generated tokens (slice off the prompt), and KEEP
    # special tokens so grounding markers like <|box_start|>/<|box_end|> survive.
    prompt_len = inputs["input_ids"].shape[1]
    generated_ids = generated_ids[:, prompt_len:]
    output_text = processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
    return output_text.strip()


def _smart_resize_dims(height: int, width: int) -> tuple[int, int]:
    """Calculate Qwen2.5-VL internal patch preprocessing dimensions.

    NOTE: Qwen2.5-VL natively predicts bounding boxes in the user's original
    input image coordinate space, so the model output must NOT be scaled by
    (width / resized_w). This function is kept for diagnostic/logging purposes.
    """
    try:
        ip = processor.image_processor
        patch_size = int(getattr(ip, "patch_size", 14))
        merge_size = int(getattr(ip, "merge_size", 2))
        min_pixels = int(getattr(ip, "min_pixels", 56 * 56))
        max_pixels = int(getattr(ip, "max_pixels", 14 * 14 * 4 * 1280))
        factor = patch_size * merge_size

        h_bar = round(height / factor) * factor
        w_bar = round(width / factor) * factor
        if h_bar * w_bar > max_pixels:
            beta = ((height * width) / max_pixels) ** 0.5
            h_bar = max(factor, int(height / beta // factor) * factor)
            w_bar = max(factor, int(width / beta // factor) * factor)
        elif h_bar * w_bar < min_pixels:
            beta = (min_pixels / (height * width)) ** 0.5
            h_bar = -(-int(height * beta) // factor) * factor
            w_bar = -(-int(width * beta) // factor) * factor
        return int(w_bar), int(h_bar)
    except Exception as err:
        print(f"[!] smart_resize replication failed ({err}); assuming no resize.")
        return width, height




def reason_about_failure(
    base64_image: str,
    user_goal: str,
    failed_step: str,
    error_msg: str,
    completed_steps: list[str],
) -> str:
    completed_str = ", ".join(completed_steps) if completed_steps else "None"
    prompt = (
        f"{REDACTION_SYSTEM_INSTRUCTION}\n\n"
        f"You are a browser automation agent. Look at this screenshot carefully.\n"
        f"User Goal: \"{user_goal}\"\n"
        f"Completed steps so far: [{completed_str}]\n"
        f"Step that failed: \"{failed_step}\"\n"
        f"Error: \"{error_msg}\"\n\n"
        f"Look at the screenshot. What is currently visible on screen? "
        f"What went wrong? What should we do next to recover?\n"
        f"Reply with a SHORT explanation (1-2 sentences) of what you see and what to do next."
    )

    try:
        img = decode_base64_image(base64_image)
    except Exception:
        return f"Could not analyze screenshot. Retry: {failed_step}"

    try:
        output = _run_vlm_inference(img, prompt, max_new_tokens=150)
    except (torch.AcceleratorError, RuntimeError):
        return f"Visual analysis unavailable. Retry: {failed_step}"
    # Remove any leftover chat/grounding special-token markers for a clean summary.
    cleaned = re.sub(r"<\|[^|]+\|>", "", output).strip()
    return cleaned or output.strip()


def predict_action(
    base64_image: str,
    current_step: str,
    step_index: int = 0,
    is_last_step: bool = False,
    device_pixel_ratio: float = 1.0,
) -> dict:
    clean_text = current_step.strip()
    action_type = "click"

    # Normalize the action prefix. The planner may emit either "scroll: down" or
    # the more natural "scroll down" / "scroll:down" / "scroll : down" form.
    prefixes = ["click", "type", "navigate", "press", "search", "open_tab", "close_tab", "switch_tab"]
    prefix_matched = False
    for prefix in prefixes:
        # match "prefix: value" with optional spaces around the colon
        m = re.match(rf"^{re.escape(prefix)}\s*:\s*(.*)$", clean_text, re.IGNORECASE)
        if m:
            action_type = prefix
            clean_text = m.group(1).strip()
            prefix_matched = True
            break

    # "scroll" may be written as "scroll: down", "scroll down", or "scroll:down".
    if not prefix_matched or action_type == "scroll":
        m = re.match(r"^scroll\s*:?\s*(up|down)?\s*(.*)$", clean_text, re.IGNORECASE)
        if m:
            action_type = "scroll"
            clean_text = (m.group(1) or "down").strip()

    # Plain forms without a colon (e.g. "press Enter", "click on X", "search X"),
    # only when no colon-prefix matched above (so we don't re-interpret targets).
    if not prefix_matched:
        m = re.match(r"^press\s+(.+)$", clean_text, re.IGNORECASE)
        if m:
            action_type = "press"
            clean_text = m.group(1).strip()
        else:
            m = re.match(r"^search\s+(.+)$", clean_text, re.IGNORECASE)
            if m:
                action_type = "search"
                clean_text = m.group(1).strip()

    if action_type in ["navigate", "open_tab"]:
        target_url = clean_text if clean_text.startswith("http") else f"https://{clean_text}"
        return {"action": action_type, "url": target_url, "step_index": step_index, "is_last_step": is_last_step, "found": True}

    elif action_type == "search":
        return {"action": action_type, "query": clean_text, "step_index": step_index, "is_last_step": is_last_step, "found": True}

    elif action_type == "press":
        return {"action": action_type, "key": clean_text if clean_text else "Enter", "step_index": step_index, "is_last_step": is_last_step, "found": True}

    elif action_type == "scroll":
        direction = "up" if "up" in clean_text.lower() else "down"
        return {"action": action_type, "direction": direction, "amount": 500, "step_index": step_index, "is_last_step": is_last_step, "found": True}

    elif action_type in ["close_tab", "switch_tab"]:
        return {"action": action_type, "step_index": step_index, "is_last_step": is_last_step, "found": True}

    try:
        img = decode_base64_image(base64_image)
        width, height = img.size
    except Exception as err:
        print(f"[!] Screenshot decoding error: {err}. Using fallback.")
        img = Image.new("RGB", (1920, 1080))
        width, height = 1920, 1080

    if action_type == "type":
        target_desc = "the currently focused/active text input field or search bar"
    else:
        lower_target = clean_text.lower()
        if " - " in clean_text:
            field_name, opt_name = clean_text.split(" - ", 1)
            field_name = field_name.strip().rstrip("*").strip()
            opt_name = opt_name.strip()
            target_desc = f"the '{opt_name}' option button (radio button or checkbox) next to '{opt_name}' under '{field_name}'"
        elif lower_target.startswith("input field for "):
            field_name = clean_text[len("input field for "):].strip().rstrip("*").strip()
            target_desc = f"the text input box or entry field below '{field_name}'"
        elif "submit" in lower_target:
            target_desc = "the 'Submit' button"
        elif "add to cart" in lower_target or "cart" in lower_target:
            target_desc = "the 'Add to Cart' or 'ADD TO CART' button"
        elif "search" in lower_target and ("bar" in lower_target or "input" in lower_target):
            target_desc = "the search bar or search input field"
        elif "product" in lower_target and ("first" in lower_target or "result" in lower_target or "item" in lower_target):
            target_desc = "the first product listing or product card in the results"
        elif "close" in lower_target or "cross" in lower_target or "cancel" in lower_target:
            target_desc = "the close (X) button or dismiss button"
        else:
            target_desc = f"'{clean_text}'"

    # Grounding instruction for Qwen2.5-VL.
    # Qwen2.5-VL natively predicts bounding box coordinates in the original
    # input image pixel space (width x height, top-left 0,0). Prompting with
    # the true image dimensions ensures pixel-accurate grounding without any
    # post-inference coordinate distortion.
    prompt = (
        f"{REDACTION_SYSTEM_INSTRUCTION_SHORT}\n"
        f"Locate {target_desc} in this screenshot.\n"
        f"Reply with exactly the bounding box of that element in image pixel coordinates (image size {width}x{height}, top-left is 0,0):\n"
        f"<|box_start|>(X1,Y1),(X2,Y2)<|box_end|>\n"
        f"Output the box only."
    )

    print(f"[*] VLM querying for target: {target_desc} on image ({width}x{height})")
    try:
        output_text = _run_vlm_inference(img, prompt)
    except (torch.AcceleratorError, RuntimeError) as vlm_err:
        print(f"[!] VLM inference failed ({vlm_err}). Falling back to permissive action.")
        output_text = ""
    print(f"[*] VLM raw output: {output_text.strip()[:300]}")

    found = False
    box_center = parse_box_center(output_text, width, height)
    if box_center:
        center_x_px, center_y_px = box_center
        # Constrain coordinates within screenshot bounds
        center_x_px = max(0.0, min(float(center_x_px), float(width - 1)))
        center_y_px = max(0.0, min(float(center_y_px), float(height - 1)))
        found = True
        print(f"[*] VLM box center -> screenshot pixel ({center_x_px:.1f},{center_y_px:.1f})")
    else:
        center_x_px, center_y_px = width / 2.0, height / 2.0
        print(f"[!] VLM output not parsed as box: {output_text[:200]}")

    dpr = sanitize_dpr(device_pixel_ratio)
    if dpr > 0:
        target_x = int(center_x_px / dpr)
        target_y = int(center_y_px / dpr)
    else:
        target_x = int(center_x_px)
        target_y = int(center_y_px)

    css_w = max(1, int(width / dpr)) if dpr > 0 else width
    css_h = max(1, int(height / dpr)) if dpr > 0 else height
    target_x = max(0, min(target_x, css_w - 1))
    target_y = max(0, min(target_y, css_h - 1))
    print(f"[*] CSS viewport mapping: image_px({center_x_px:.1f},{center_y_px:.1f}) / dpr({dpr}) -> click({target_x},{target_y}) in viewport({css_w}x{css_h})")

    # For 'type', the extension's typeIntoElement() first tries findTextInput() on
    # the already-focused element and only needs x/y as a fallback. So we keep the
    # box when parsed, but never treat a missing box as a hard failure (which would
    # push the step into rethink and can silently drop later steps like "press: Enter").
    type_action = action_type == "type"
    effective_found = found or type_action

    action_payload = {
        "action": action_type,
        "x": target_x,
        "y": target_y,
        "step_index": step_index,
        "is_last_step": is_last_step,
        "found": effective_found,
        "target": clean_text,
    }

    if action_type == "type":
        action_payload["text"] = clean_text

    return action_payload


IGNORABLE_LABELS = {
    "indicates required question",
    "your answer",
    "clear form",
    "sign in to google to save your progress",
    "never submit passwords through google forms",
    "switch accounts",
    "report abuse",
    "terms of service",
    "privacy policy",
}


def normalize_label(label: str) -> str:
    """Normalize label by removing asterisks, quotes, excess whitespace, and lowercasing."""
    cleaned = re.sub(r'[\*\"\'\:\-]+', ' ', label or '')
    return ' '.join(cleaned.lower().split())


def is_ignorable_form_element(label: str, ftype: str = "") -> bool:
    """Check if an element is boilerplate, placeholder, or reset button that shouldn't be filled."""
    norm = normalize_label(label)
    if not norm:
        return True
    if norm in IGNORABLE_LABELS:
        return True
    if any(phrase in norm for phrase in [
        "indicates required",
        "required question",
        "save your progress",
        "never submit password",
        "clear form",
        "switch account",
    ]):
        return True
    if norm.startswith("your answer") or norm == "answer":
        return True
    return False


FORM_ANALYSIS_PROMPT = (
    "Analyze this web form screenshot and identify every fillable question/field and action button.\n"
    "For each element provide:\n"
    "- label: the visible question title or button text (e.g. 'pick true', 'name', 'Submit'). DO NOT include placeholders like 'Your answer' or instructions like '* Indicates required question'.\n"
    "- type: 'radio' (for round option buttons), 'checkbox' (for square check boxes), 'text' (for single-line or multi-line text input fields), or 'button' (for 'Submit' / 'Next' buttons).\n"
    "- options: list of text choices for radio/checkbox questions (e.g. ['true', 'false'] or ['Option 1']). Use [] for text inputs and buttons.\n"
    "Rules:\n"
    "- Ignore headers, page titles, disclaimers, and metadata like '* Indicates required question' or 'Sign in to Google'.\n"
    "- Ignore placeholder text inside input boxes like 'Your answer'. Use the question title above the box as the label.\n"
    "- Ignore 'Clear form' or cancel buttons.\n"
    "- Identify 'Submit' as type 'button'.\n"
    "Output ONLY a JSON object with a 'fields' list, no commentary:\n"
    '{"fields":[{"label":"question title","type":"text|radio|checkbox|button","options":["opt1"]}]}\n'
    'If there are no fields, output {"fields":[]}.'
)


def _extract_fields_from_json(output_text: str) -> list[dict]:
    """Defensively pull field records out of the VLM's JSON answer.

    Handles valid JSON, markdown code fences, and truncated JSON by recovering
    individual field objects. Guarantees coherent field dictionaries.
    """
    text = (output_text or "").strip()
    text = re.sub(r"^```(?:json)?", "", text)
    text = re.sub(r"```$", "", text).strip()

    raw_list = []
    # 1. Try direct JSON parsing
    try:
        data = json.loads(text)
        if isinstance(data, dict) and "fields" in data:
            raw_list = data["fields"]
        elif isinstance(data, list):
            raw_list = data
    except Exception:
        pass

    # 2. If direct parse failed (e.g. truncated), extract individual completed {...} objects
    if not raw_list:
        obj_matches = re.findall(r"\{[^{}]*\}", text)
        for m in obj_matches:
            try:
                obj = json.loads(m)
                if isinstance(obj, dict) and ("label" in obj or "box" in obj):
                    raw_list.append(obj)
            except Exception:
                continue

    fields: list[dict] = []
    for f in raw_list:
        if not isinstance(f, dict):
            continue
        label = str(f.get("label", "")).strip()
        ftype = str(f.get("type", "text")).lower()
        if is_ignorable_form_element(label, ftype):
            continue

        opts = f.get("options") or []
        if isinstance(opts, str):
            opts = [o.strip().strip("\"'") for o in opts.split(",") if o.strip()]

        # Correct field type if options exist
        if opts and ftype == "text":
            norm = normalize_label(label)
            ftype = "checkbox" if any(w in norm for w in ["tick", "check", "multi"]) else "radio"

        field = {"type": ftype, "label": label, "options": opts}
        if "box" in f and len(f["box"]) == 4:
            try:
                x1, y1, x2, y2 = map(float, f["box"])
                field["box"] = [x1, y1, x2, y2]
                field["center"] = ((x1 + x2) / 2.0, (y1 + y2) / 2.0)
            except Exception:
                pass
        fields.append(field)

    return fields


def analyze_form(base64_image: str) -> list[dict]:
    """Ask the VLM to enumerate the form's fields.

    Returns a list of dicts: {type, label, options, box?, center?}.
    """
    try:
        img = decode_base64_image(base64_image)
    except Exception as err:
        print(f"[!] analyze_form image decode error: {err}")
        return []

    try:
        output = _run_vlm_inference(img, FORM_ANALYSIS_PROMPT, max_new_tokens=1024)
    except (torch.AcceleratorError, RuntimeError) as vlm_err:
        print(f"[!] analyze_form inference failed ({vlm_err}).")
        return []

    print(f"[*] FORM analysis raw: {output.strip()[:600]}")
    fields = _extract_fields_from_json(output)
    print(f"[*] FORM inferred {len(fields)} field(s): "
          f"{json.dumps([{ 'label': f['label'], 'type': f['type'] } for f in fields])}")
    return fields


def generate_form_value(label: str) -> str:
    """Return a realistic test value for a form field given its label."""
    L = (label or "").lower()

    # 1. Check if the label explicitly tells the user what to type (e.g. just type "yes")
    m = re.search(r'(?:type|enter|input|write)\s+["\']([^"\']+)["\']', label, re.IGNORECASE)
    if m:
        return m.group(1)

    m_quoted = re.search(r'["\']([^"\']+)["\']', label)
    if m_quoted and any(w in L for w in ["type", "enter", "write", "say", "just"]):
        return m_quoted.group(1)

    # 2. Check unquoted instruction like "just type yes"
    m_unquoted = re.search(r'(?:just\s+)?(?:type|enter|write|input)\s+([a-zA-Z0-9_-]+)', label, re.IGNORECASE)
    if m_unquoted:
        word = m_unquoted.group(1).strip()
        if word.lower() not in ["the", "a", "an", "your", "here", "this"]:
            return word

    if any(k in L for k in ["email", "e-mail", "mail"]):
        return "john.doe@example.com"
    if any(k in L for k in ["full name", "first name", "last name", "name"]):
        return "John Doe"
    if any(k in L for k in ["phone", "mobile", "contact number", "cell"]):
        return "9876501234"
    if any(k in L for k in ["city", "town"]):
        return "Mumbai"
    if any(k in L for k in ["state", "province"]):
        return "Maharashtra"
    if any(k in L for k in ["country", "nation"]):
        return "India"
    if any(k in L for k in ["zip", "postal", "pincode", "pin code"]):
        return "400001"
    if any(k in L for k in ["age"]):
        return "25"
    if any(k in L for k in ["subject", "query", "search", "keyword", "topic", "title"]):
        return "Project Vision automation test"
    if any(k in L for k in ["comment", "message", "feedback", "note", "description", "details", "reason", "suggestion"]):
        return "This is an automated test submission from Project Vision."
    if any(k in L for k in ["url", "website", "link"]):
        return "https://example.com"
    if any(k in L for k in ["company", "organization", "org"]):
        return "Project Vision Team"
    if any(k in L for k in ["job", "designation", "role", "title"]):
        return "Engineer"
    return "Test Value"


def build_form_fill_plan(form_fields: list[dict]) -> list[str]:
    """Turn detected fields into click+type/click step strings.

    Radio/checkbox fields get a click on the requested or first available option.
    Text fields get a click on the input box followed by typing a realistic test value.
    Submit button is appended as the final step.
    """
    steps: list[str] = []
    submit_step = None

    for i, f in enumerate(form_fields, start=1):
        raw_label = (f.get("label") or f"field {i}").strip()
        clean_lbl = raw_label.rstrip("*").strip()
        norm = normalize_label(clean_lbl)

        # Ignore boilerplate disclaimers and orphaned placeholders
        if is_ignorable_form_element(clean_lbl, f.get("type", "")):
            print(f"[*] Skipping non-field element ({i}): {raw_label}")
            continue

        ftype = (f.get("type") or "text").lower()
        opts = f.get("options") or []

        # Auto-correct type if options exist
        if opts and ftype == "text":
            ftype = "checkbox" if any(w in norm for w in ["tick", "check", "multi"]) else "radio"

        # Handle Submit / action buttons
        if ftype == "button" or norm in ["submit", "send", "next"]:
            if any(w in norm for w in ["clear", "reset", "cancel"]):
                print(f"[*] Skipping clear/reset button: {raw_label}")
                continue
            submit_step = f"click: {clean_lbl}"
            continue

        # Choice fields: radio / checkbox
        if ftype in ("radio", "checkbox"):
            if opts:
                # Prefer option mentioned in question label (e.g. "pick true" -> "true")
                matched_opt = None
                for opt in opts:
                    if opt.lower() in norm:
                        matched_opt = opt
                        break
                selected_opt = matched_opt or opts[0]
                steps.append(f"click: {clean_lbl} - {selected_opt}")
            else:
                steps.append(f"click: {clean_lbl}")
        else:
            # Text / textarea field: click input box then type
            val = generate_form_value(clean_lbl)
            steps.append(f"click: input field for {clean_lbl}")
            steps.append(f"type: {val}")

    if submit_step:
        steps.append(submit_step)

    if not steps:
        print(f"[*] Form scan produced no fillable fields.")
    return steps
