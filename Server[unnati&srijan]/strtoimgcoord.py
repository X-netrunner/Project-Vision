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
    MODEL_ID, torch_dtype=torch.float16, device_map="auto"
)

# Load the matching processor, which handles text tokenization and visual image transformations
processor = AutoProcessor.from_pretrained(MODEL_ID)


def decode_base64_image(base64_string: str) -> Image.Image:
    """
    Decodes an incoming Base64 image payload sent from the browser extension
    and converts it into an in-memory Pillow (PIL) Image object.
    """
    # Remove the Data URL header prefix (e.g., "data:image/png;base64,") if it exists in the payload
    if "," in base64_string:
        base64_string = base64_string.split(",")[1]

    # Decode the raw Base64 string into binary bytes
    image_bytes = base64.b64decode(base64_string)

    # Use BytesIO to create an in-memory file stream so Pillow can load the image without saving to disk
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
    # Step 1: Decode the input Base64 string into a PIL Image and extract pixel dimensions
    img = decode_base64_image(base64_image)
    width, height = img.size

    # Step 2: Formulate the vision prompt instructing the model to find the target UI element
    prompt = f"Locate the coordinates of '{current_step}' on the screen."

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

    # Step 6: Construct and return the structured JSON payload matching the extension API protocol
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
