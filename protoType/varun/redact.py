import base64
import concurrent.futures
import logging
from typing import List, Tuple
import cv2
import numpy as np
from blur_utils import apply_heavy_blur
from face_detect import detect_faces
from ocr_engine import extract_text_blocks
from pii_engine import find_pii_spans
from config import (
    JPEG_COMPRESSION_QUALITY,
    TEXT_PADDING_PX,
    LABEL_BLUR_LEAD_PX,
    FORM_VERTICAL_PROXIMITY_PX,
    FORM_HORIZONTAL_ALIGN_TOLERANCE_PX,
    FORM_LABEL_TRIGGERS,
    SENSITIVE_FIELD_LABELS,
)

logger = logging.getLogger("VarunRedactor")
EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=2)

def _process_text_and_pii(img: np.ndarray) -> List[Tuple[int, int, int, int]]:
    """Worker task: runs OCR and PII analysis, returning all text bounding boxes to blur."""
    h, w, _ = img.shape
    blocks = extract_text_blocks(img)
    if not blocks:
        return []

    blur_regions: List[Tuple[int, int, int, int]] = []

    # 1. Spatial Form Association (Vertical Form Fields)
    for i, label_block in enumerate(blocks):
        lbl_lower = label_block["text"].lower().strip()
        if any(trig == lbl_lower or lbl_lower.startswith(trig) for trig in FORM_LABEL_TRIGGERS):
            lx, ly, lw, lh = label_block["rect"]
            label_bottom = ly + lh

            for j, candidate in enumerate(blocks):
                if i == j or candidate["blurred"]:
                    continue

                cx, cy, cw, ch = candidate["rect"]
                vert_dist = cy - label_bottom
                horiz_overlap = abs(cx - lx)

                if 0 <= vert_dist <= FORM_VERTICAL_PROXIMITY_PX and horiz_overlap <= FORM_HORIZONTAL_ALIGN_TOLERANCE_PX:
                    cand_lower = candidate["text"].lower()
                    if any(cand_lower.startswith(t) for t in FORM_LABEL_TRIGGERS) or cand_lower == "your answer":
                        continue

                    logger.info(f"Form Association: Blurring '{candidate['text']}' under '{label_block['text']}'")
                    px1 = max(0, cx - TEXT_PADDING_PX)
                    py1 = max(0, cy - TEXT_PADDING_PX)
                    px2 = min(w, cx + cw + TEXT_PADDING_PX)
                    py2 = min(h, cy + ch + TEXT_PADDING_PX)

                    if px2 > px1 and py2 > py1:
                        blur_regions.append((px1, py1, px2, py2))
                        candidate["blurred"] = True

    # 2. Inline Field Labels & Standalone Values
    for blk in blocks:
        if blk["blurred"]:
            continue

        text = blk["text"]
        bx, by, bw, bh = blk["rect"]
        total_len = len(text)
        char_w = bw / max(1, total_len)

        # Inline Colon Separation (e.g., "Name: John Doe")
        if ":" in text:
            parts = text.split(":", 1)
            label_part = parts[0].strip().lower()
            val_part = parts[1].strip()

            if any(lbl in label_part for lbl in SENSITIVE_FIELD_LABELS):
                if len(val_part) > 0 and label_part not in ["public info", "public"]:
                    colon_index = text.index(":")
                    sub_x1 = int(bx + ((colon_index + 1) * char_w))

                    px1 = max(bx + int(colon_index * char_w) + 2, sub_x1 - LABEL_BLUR_LEAD_PX)
                    py1 = max(0, by - TEXT_PADDING_PX)
                    px2 = min(w, bx + bw + TEXT_PADDING_PX)
                    py2 = min(h, by + bh + TEXT_PADDING_PX)

                    if px2 > px1 and py2 > py1:
                        blur_regions.append((px1, py1, px2, py2))
                        blk["blurred"] = True
                        continue

        # Standalone PII / Regex Spans
        spans = find_pii_spans(text)
        if spans:
            for start_idx, end_idx in spans:
                sub_x1 = int(bx + (start_idx * char_w))
                sub_x2 = int(bx + (end_idx * char_w))

                px1 = max(0, sub_x1 - 4)
                py1 = max(0, by - TEXT_PADDING_PX)
                px2 = min(w, sub_x2 + TEXT_PADDING_PX)
                py2 = min(h, by + bh + TEXT_PADDING_PX)

                if px2 > px1 and py2 > py1:
                    blur_regions.append((px1, py1, px2, py2))
                    blk["blurred"] = True

    return blur_regions

def redact_image(b64_str: str) -> str:
    """Decodes, runs face and OCR/PII detection in parallel threads, blurs, and re-encodes."""
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]

    img_data = base64.b64decode(b64_str)
    nparr = np.frombuffer(img_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    del img_data, nparr

    if img is None:
        raise ValueError("Corrupt image data.")

    # Concurrently execute Face Detection and OCR + PII analysis
    future_faces = EXECUTOR.submit(detect_faces, img)
    future_text_regions = EXECUTOR.submit(_process_text_and_pii, img)

    face_regions = future_faces.result()
    text_regions = future_text_regions.result()

    # Apply all blurs sequentially to the original canvas
    for x1, y1, x2, y2 in face_regions + text_regions:
        roi = img[y1:y2, x1:x2]
        if roi.size > 0:
            img[y1:y2, x1:x2] = apply_heavy_blur(roi)

    # Output JPEG Compression
    _, buffer = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_COMPRESSION_QUALITY])
    del img

    out_b64 = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"
    del buffer
    return out_b64