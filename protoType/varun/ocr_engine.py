import threading
import time
from typing import List, Dict, Any
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

print("[PRE-FLIGHT] Loading OCR engine (RapidOCR)...")
_ocr_load_start = time.perf_counter()
ocr = RapidOCR()
print(f"[PRE-FLIGHT] OCR engine loaded in {time.perf_counter() - _ocr_load_start:.2f}s")

_ocr_lock = threading.Lock()

def extract_text_blocks(img: np.ndarray) -> List[Dict[str, Any]]:
    """Runs RapidOCR and returns normalized blocks with text and bounding boxes."""
    with _ocr_lock:
        ocr_results, _ = ocr(img)

    if not ocr_results:
        return []

    blocks = []
    for bbox, raw_text, _ in ocr_results:
        txt = raw_text.strip()
        if not txt:
            continue
        pts = np.array(bbox, dtype=np.int32)
        bx, by, bw, bh = cv2.boundingRect(pts)
        blocks.append({
            "text": txt,
            "rect": (bx, by, bw, bh),
            "blurred": False
        })
    return blocks