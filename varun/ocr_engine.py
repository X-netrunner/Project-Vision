from typing import List, Dict, Any
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

ocr = RapidOCR()

def extract_text_blocks(img: np.ndarray) -> List[Dict[str, Any]]:
    """Runs RapidOCR and returns normalized blocks with text and bounding boxes."""
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