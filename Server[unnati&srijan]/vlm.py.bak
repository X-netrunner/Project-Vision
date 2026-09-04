import base64
import io
import json
import re
from PIL import Image
from transformers import AutoProcessor, Qwen2VLForConditionalGeneration
import torch

MODEL_ID = "Qwen/Qwen2-VL-2B-Instruct"
device = "cuda" if torch.cuda.is_available() else "cpu"

model = Qwen2VLForConditionalGeneration.from_pretrained(
    MODEL_ID, torch_dtype=torch.float16 if device == "cuda" else torch.float32, device_map="auto"
)
processor = AutoProcessor.from_pretrained(MODEL_ID)


def decode_base64_image(base64_string: str) -> Image.Image:
    if not base64_string or not isinstance(base64_string, str):
        raise ValueError("[!] Received empty or non-string Base64 image payload.")

    base64_string = base64_string.strip().strip('"').strip("'")

    if "," in base64_string:
        base64_string = base64_string.split(",", 1)[1]

    base64_string = "".join(base64_string.split())

    missing_padding = len(base64_string) % 4
    if missing_padding == 1:
        raise ValueError(f"[!] Invalid Base64 payload length ({len(base64_string)} chars).")
    elif missing_padding == 2:
        base64_string += "=="
    elif missing_padding == 3:
        base64_string += "="

    image_bytes = base64.b64decode(base64_string)
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


PAIR_RE = r"\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)"


def parse_box_center(output_text: str) -> tuple | None:
    """Extract the center of a bounding box from the raw model output.

    Qwen2-VL is trained to normalize bounding boxes within [0, 1000) and render
    them as "<|box_start|>(X1,Y1),(X2,Y2)<|box_end|>", where X indexes the
    horizontal (width) axis and Y the vertical (height) axis. In practice the
    small 2B model frequently ignores the special tokens and just writes the
    two corner pairs as free text, e.g.
        "approximately (380, 380) to (620, 520)"
    so we also accept the first two "(x,y)" pairs found anywhere in the reply,
    as well as a bare [x1,y1,x2,y2] list. Returns (center_x_norm, center_y_norm)
    in [0,1000) space, or None if no box could be parsed.
    """
    if not output_text:
        return None

    # Preferred: Qwen2-VL "<|box_start|>(X1,Y1),(X2,Y2)<|box_end|>" format.
    m = re.search(
        r"<\|box_start\|>\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)\s*,\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)\s*<\|box_end\|>",
        output_text,
        re.IGNORECASE,
    )
    if m:
        x1, y1, x2, y2 = map(float, m.groups())
        return (x1 + x2) / 2.0, (y1 + y2) / 2.0

    # Fallback: the first two "(X,Y)" pairs anywhere in the reply, regardless
    # of the words separating them ("and", "to", "->", ",", etc.).
    pairs = re.findall(PAIR_RE, output_text)
    if len(pairs) == 1:
        # Only a single "(X,Y)" point was returned; treat it as the center.
        x1, y1 = pairs[0]
        return float(x1), float(y1)
    if len(pairs) >= 2:
        (x1, y1), (x2, y2) = pairs[:2]
        return (float(x1) + float(x2)) / 2.0, (float(y1) + float(y2)) / 2.0

    # Fallback: bare [x1,y1,x2,y2] list (already ordered X1,Y1,X2,Y2).
    m = re.search(r"\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]", output_text)
    if m:
        x1, y1, x2, y2 = map(float, m.groups())
        return (x1 + x2) / 2.0, (y1 + y2) / 2.0

    return None


def predict_action(
    base64_image: str,
    current_step: str,
    step_index: int = 0,
    is_last_step: bool = False,
    device_pixel_ratio: float = 1.0,
) -> dict:
    clean_text = current_step.strip()
    action_type = "click"

    # Case-insensitive prefix detection
    prefixes = ["click", "type", "navigate", "press", "scroll", "search", "open_tab", "close_tab", "switch_tab"]
    for prefix in prefixes:
        if clean_text.lower().startswith(prefix + ":"):
            action_type = prefix
            clean_text = clean_text[len(prefix) + 1:].strip()
            break

    # Handle non-visual actions directly matching ActionPayload interface
    if action_type in ["navigate", "open_tab"]:
        target_url = clean_text if clean_text.startswith("http") else f"https://{clean_text}"
        return {
            "action": action_type,
            "url": target_url,
            "step_index": step_index,
            "is_last_step": is_last_step
        }

    elif action_type == "search":
        return {
            "action": action_type,
            "query": clean_text,
            "step_index": step_index,
            "is_last_step": is_last_step
        }

    elif action_type == "press":
        return {
            "action": action_type,
            "key": clean_text if clean_text else "Enter",
            "step_index": step_index,
            "is_last_step": is_last_step
        }

    elif action_type == "scroll":
        direction = "up" if "up" in clean_text.lower() else "down"
        return {
            "action": action_type,
            "direction": direction,
            "amount": 500,
            "step_index": step_index,
            "is_last_step": is_last_step
        }

    elif action_type in ["close_tab", "switch_tab"]:
        return {
            "action": action_type,
            "step_index": step_index,
            "is_last_step": is_last_step
        }

    # Visual actions requiring screen coordinate predictions (CLICK / TYPE)
    try:
        img = decode_base64_image(base64_image)
        width, height = img.size
    except Exception as err:
        print(f"[!] Warning decoding screenshot: {err}. Defaulting to 1920x1080 canvas.")
        img = Image.new("RGB", (1920, 1080))
        width, height = 1920, 1080

    prompt = (
        f"Find '{clean_text}' in the screenshot. "
        "Return ONLY the bounding box of its center on the screen "
        "as (x1,y1),(x2,y2) where coordinates are normalized from 0 to 1000 "
        "across the full image width and height. "
        "The first number of each pair is the horizontal (x) coordinate, the "
        "second is the vertical (y) coordinate."
    )

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

    print(f"[VLM] raw output for '{clean_text}': {output_text!r}")

    target_x, target_y = width // 2, height // 2

    box_center = parse_box_center(output_text)
    if box_center:
        center_x_norm, center_y_norm = box_center
        # Qwen2-VL normalizes to [0,1000) over the image it actually saw; the
        # image is resized per-axis preserving aspect ratio, so mapping straight
        # to the original screenshot dimensions is exact on each axis.
        target_x = int((center_x_norm / 1000.0) * width)
        target_y = int((center_y_norm / 1000.0) * height)
    else:
        print(f"[VLM] no parseable box in output for '{clean_text}'; falling back to center")

    # The screenshot the model sees is captured in device pixels, but the
    # content script clicks using document.elementFromPoint(x, y), which expects
    # CSS/viewport pixels. Divide by the device pixel ratio to translate.
    dpr = float(device_pixel_ratio) if device_pixel_ratio else 1.0
    if dpr > 0:
        target_x = int(target_x / dpr)
        target_y = int(target_y / dpr)

    # Never send coordinates outside the visible area.
    target_x = max(0, min(target_x, width - 1))
    target_y = max(0, min(target_y, height - 1))
    print(f"[VLM] '{clean_text}' -> click ({target_x}, {target_y})  [img {width}x{height}, dpr {dpr}]")

    action_payload = {
        "action": action_type,
        "x": target_x,
        "y": target_y,
        "step_index": step_index,
        "is_last_step": is_last_step,
    }

    if action_type == "type":
        action_payload["text"] = clean_text

    return action_payload
