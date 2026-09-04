import base64
import io
import json
import re
from PIL import Image
from transformers import AutoProcessor, Qwen2VLForConditionalGeneration
import torch

MODEL_ID = "Qwen/Qwen2-VL-2B-Instruct"

if torch.cuda.is_available():
    free_bytes = torch.cuda.mem_get_info()[0]
    free_gb = free_bytes / 1e9
    total_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
    print(f"[*] GPU detected: {torch.cuda.get_device_name(0)} (Total: {total_gb:.1f} GB, Free: {free_gb:.1f} GB)")
    if free_gb < 4.0:
        print(f"[*] Free VRAM ({free_gb:.1f} GB) is under 4GB (8B planner model is using GPU). Loading VLM on CPU...")
        device = "cpu"
        dtype = torch.float32
    else:
        device = "cuda:0"
        dtype = torch.float16
else:
    device = "cpu"
    dtype = torch.float32
    print("[!] No GPU detected, using CPU")

try:
    model = Qwen2VLForConditionalGeneration.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        device_map=device,
        low_cpu_mem_usage=True,
        offload_buffers=True,
    )
except (torch.OutOfMemoryError, RuntimeError) as e:
    print(f"[!] GPU memory error ({e}). Falling back to CPU for VLM...")
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    device = "cpu"
    dtype = torch.float32
    model = Qwen2VLForConditionalGeneration.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        device_map=device,
        low_cpu_mem_usage=True,
        offload_buffers=True,
    )

processor = AutoProcessor.from_pretrained(MODEL_ID)

print(f"[*] Model loaded on: {next(model.parameters()).device} ({next(model.parameters()).dtype})")

# Contextual prompt for privacy redaction handling
REDACTION_SYSTEM_INSTRUCTION = (
    "PRIVACY REDACTION NOTICE: The provided screenshot contains privacy redactions where all human faces, "
    "avatars, sensitive text, emails, phone numbers, delivery addresses, and PII are intentionally masked "
    "with blur or solid black/grey bounding boxes. These redactions are completely normal and expected. "
    "DO NOT PANIC, fail, or abort because of these redactions. Do NOT attempt to target or click inside "
    "redacted boxes. Focus exclusively on unredacted standard UI elements (e.g., 'Add to Cart' button, "
    "search bar, product listings, navigation buttons, and menus)."
)


def decode_base64_image(base64_string: str) -> Image.Image:
    if not base64_string or not isinstance(base64_string, str):
        raise ValueError("[!] Received empty or non-string Base64 image payload.")

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


def predict_action(
    base64_image: str,
    current_step: str,
    step_index: int = 0,
    is_last_step: bool = False,
) -> dict:
    clean_text = current_step.strip()
    action_type = "click"

    # Case-insensitive tag extraction
    prefixes = ["click", "type", "navigate", "press", "scroll", "search", "open_tab", "close_tab", "switch_tab"]
    for prefix in prefixes:
        if clean_text.lower().startswith(prefix + ":"):
            action_type = prefix
            clean_text = clean_text[len(prefix) + 1:].strip()
            break

    # Non-visual actions
    if action_type in ["navigate", "open_tab"]:
        target_url = clean_text if clean_text.startswith("http") else f"https://{clean_text}"
        return {
            "action": action_type,
            "url": target_url,
            "step_index": step_index,
            "is_last_step": is_last_step,
            "found": True
        }

    elif action_type == "search":
        return {
            "action": action_type,
            "query": clean_text,
            "step_index": step_index,
            "is_last_step": is_last_step,
            "found": True
        }

    elif action_type == "press":
        return {
            "action": action_type,
            "key": clean_text if clean_text else "Enter",
            "step_index": step_index,
            "is_last_step": is_last_step,
            "found": True
        }

    elif action_type == "scroll":
        direction = "up" if "up" in clean_text.lower() else "down"
        return {
            "action": action_type,
            "direction": direction,
            "amount": 500,
            "step_index": step_index,
            "is_last_step": is_last_step,
            "found": True
        }

    elif action_type in ["close_tab", "switch_tab"]:
        return {
            "action": action_type,
            "step_index": step_index,
            "is_last_step": is_last_step,
            "found": True
        }

    # Visual Actions (CLICK / TYPE)
    try:
        img = decode_base64_image(base64_image)
        width, height = img.size
    except Exception as err:
        print(f"[!] Screenshot decoding error: {err}. Using default fallback size.")
        img = Image.new("RGB", (1920, 1080))
        width, height = 1920, 1080

    # Build clear visual prompt with common ecommerce and Flipkart hints
    lower_target = clean_text.lower()
    if "add to cart" in lower_target or "cart" in lower_target:
        target_desc = "the 'Add to Cart' or 'ADD TO CART' button (or shopping cart action button)"
    elif "search" in lower_target and ("bar" in lower_target or "input" in lower_target or "box" in lower_target):
        target_desc = "the search bar or search input field"
    elif "product" in lower_target and ("first" in lower_target or "result" in lower_target or "item" in lower_target):
        target_desc = "the first product item or title card in the search results"
    elif "close" in lower_target or "cross" in lower_target or "cancel" in lower_target:
        target_desc = "the close (X) button or modal dismiss button"
    else:
        target_desc = f"'{clean_text}'"

    prompt = f"{REDACTION_SYSTEM_INSTRUCTION}\nLocate the bounding box coordinates [ymin, xmin, ymax, xmax] of {target_desc} on the screen."

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": img},
                {"type": "text", "text": prompt},
            ],
        }
    ]

    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )

    inputs = processor(
        text=[text], images=[img], padding=True, return_tensors="pt"
    ).to(device)

    with torch.no_grad():
        generated_ids = model.generate(**inputs, max_new_tokens=128)

    output_text = processor.batch_decode(
        generated_ids, skip_special_tokens=True
    )[0]

    target_x, target_y = width // 2, height // 2
    found = False

    box_match = re.search(r"\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]", output_text)
    if box_match:
        ymin, xmin, ymax, xmax = map(int, box_match.groups())
        target_x = int(((xmin + xmax) / 2 / 1000) * width)
        target_y = int(((ymin + ymax) / 2 / 1000) * height)
        found = True
    else:
        print(f"[!] Target '{clean_text}' bounding box not parsed from VLM output: {output_text[:100]}")

    action_payload = {
        "action": action_type,
        "x": target_x,
        "y": target_y,
        "step_index": step_index,
        "is_last_step": is_last_step,
        "found": found,
        "target": clean_text
    }

    if action_type == "type":
        action_payload["text"] = clean_text

    return action_payload
