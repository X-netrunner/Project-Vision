import base64
import io
import json
import re
from PIL import Image
from transformers import AutoProcessor, Qwen2VLForConditionalGeneration
import torch

# Define the vision-language model identifier from Hugging Face
MODEL_ID = "Qwen/Qwen2-VL-2B-Instruct"

# Automatically utilize NVIDIA CUDA GPU (e.g., RTX 3050/4050) if available for faster inference, otherwise fall back to CPU
device = "cuda" if torch.cuda.is_available() else "cpu"

# Load the pretrained Qwen2-VL model into GPU memory using float16 precision to fit within VRAM constraints (4GB–6GB)
model = Qwen2VLForConditionalGeneration.from_pretrained(
    MODEL_ID, torch_dtype=torch.float16 if device == "cuda" else torch.float32, device_map="auto"
)

# Load the matching processor, which handles text tokenization and visual image transformations
processor = AutoProcessor.from_pretrained(MODEL_ID)


def decode_base64_image(base64_string: str) -> Image.Image:
    """
    Decodes an incoming Base64 image payload sent from the browser extension
    and converts it into an in-memory Pillow (PIL) Image object.
    """
    if not base64_string or not isinstance(base64_string, str):
        raise ValueError("[!] Received empty or non-string Base64 image payload.")

    # Clean whitespace, line breaks, or surrounding quotes
    base64_string = base64_string.strip().strip('"').strip("'")

    # Remove the Data URL header prefix (e.g., "data:image/png;base64,") if present
    if "," in base64_string:
        base64_string = base64_string.split(",", 1)[1]

    # Clean internal whitespace or line breaks added during JSON transmission
    base64_string = "".join(base64_string.split())

    # Fix Base64 padding if necessary
    missing_padding = len(base64_string) % 4
    if missing_padding == 1:
        raise ValueError(f"[!] Invalid Base64 payload length ({len(base64_string)} chars). The string appears to be truncated.")
    elif missing_padding == 2:
        base64_string += "=="
    elif missing_padding == 3:
        base64_string += "="

    # Decode the raw Base64 string into binary bytes
    image_bytes = base64.b64decode(base64_string)

    # Use BytesIO to create an in-memory file stream so Pillow can load the image
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def predict_action(
    base64_image: str,
    current_step: str,
    step_index: int = 0,
    is_last_step: bool = False,
) -> dict:
    """
    Processes the Base64 screenshot and current task instruction step using Qwen2-VL,
    predicts the visual element coordinates, and returns the formatted JSON payload.
    """
    # Extract action type and clean target text
    clean_text = current_step
    action_type = "click"
    for prefix in ["CLICK:", "TYPE:", "NAVIGATE:", "PRESS:", "SCROLL:", "SEARCH:", "OPEN_TAB:", "CLOSE_TAB:", "SWITCH_TAB:"]:
        if current_step.startswith(prefix):
            action_type = prefix.replace(":", "").lower()
            clean_text = current_step.replace(prefix, "").strip()
            break

    # Non-visual actions do not require visual groundings via Qwen2-VL
    if action_type in ["navigate", "open_tab", "search"]:
        return {
            "action": action_type,
            "url": clean_text if clean_text.startswith("http") else f"https://{clean_text}",
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

    # Step 1: Decode the input Base64 string into a PIL Image and extract pixel dimensions
    try:
        img = decode_base64_image(base64_image)
        width, height = img.size
    except Exception as err:
        print(f"[!] Warning decoding screenshot: {err}. Using default dimensions.")
        img = Image.new("RGB", (1920, 1080))
        width, height = 1920, 1080

    # Step 2: Formulate the vision prompt instructing the model to find the target UI element
    prompt = f"Locate the coordinates of '{clean_text}' on the screen."

    # Structure the chat message containing both the raw image object and the text prompt
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": img},
                {"type": "text", "text": prompt},
            ],
        }
    ]

    # Step 3: Format the prompt into the model's required template structure
    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )

    # Convert the raw image and formatted text into PyTorch GPU tensors
    inputs = processor(
        text=[text], images=[img], padding=True, return_tensors="pt"
    ).to(device)

    # Step 4: Run inference through the VLM without computing gradients to minimize memory usage
    with torch.no_grad():
        generated_ids = model.generate(**inputs, max_new_tokens=128)

    # Decode the output token IDs into readable text response
    output_text = processor.batch_decode(
        generated_ids, skip_special_tokens=True
    )[0]

    # Step 5: Default coordinates to screen center as a fallback mechanism
    target_x, target_y = width // 2, height // 2

    # Parse normalized bounding box coordinates [ymin, xmin, ymax, xmax] (range 0 to 1000) from output text
    box_match = re.search(r"\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]", output_text)
    if box_match:
        ymin, xmin, ymax, xmax = map(int, box_match.groups())

        # Scale normalized 0-1000 coordinates to actual pixel dimensions of the browser window
        target_x = int(((xmin + xmax) / 2 / 1000) * width)
        target_y = int(((ymin + ymax) / 2 / 1000) * height)

    # Step 6: Construct and return the action payload dictionary
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
