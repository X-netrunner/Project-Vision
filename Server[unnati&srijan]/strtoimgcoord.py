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
    MODEL_ID, torch_dtype=torch.float16, device_map="auto"
)
processor = AutoProcessor.from_pretrained(MODEL_ID)


def decode_base64_image(base64_string: str) -> Image.Image:
    if "," in base64_string:
        base64_string = base64_string.split(",")[1]
    image_bytes = base64.b64decode(base64_string)
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def predict_action(
    base64_image: str,
    current_step: str,
    step_index: int = 0,
    is_last_step: bool = False,
) -> dict:
    img = decode_base64_image(base64_image)
    width, height = img.size

    prompt = f"Locate the coordinates of '{current_step}' on the screen."

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

    # Parse bounding box [ymin, xmin, ymax, xmax] normalized to 1000
    # Default center if detection fails
    target_x, target_y = width // 2, height // 2
    
    box_match = re.search(r"\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]", output_text)
    if box_match:
        ymin, xmin, ymax, xmax = map(int, box_match.groups())
        # Scale 0-1000 coordinates to real screen pixel dimensions
        target_x = int(((xmin + xmax) / 2 / 1000) * width)
        target_y = int(((ymin + ymax) / 2 / 1000) * height)

    return {
        "type": "ACTION_COORDINATES",
        "payload": {
            "action": "click",
            "x": target_x,
            "y": target_y,
            "text": current_step.replace("CLICK: ", ""),
            "step_index": step_index,
            "is_last_step": is_last_step,
        },
    }
