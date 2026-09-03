import base64
import gc
import json
import logging
import os
import re
import time
import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from rapidocr_onnxruntime import RapidOCR

# ==============================================================================
# CONFIGURATION & HYPERPARAMETERS
# ==============================================================================
# Server & Network Settings
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8000
WS_ENDPOINT = "/ws"
MAX_PAYLOAD_BYTES = 32 * 1024 * 1024  # 32 MB frame ceiling

# Model & Asset Paths
YUNET_MODEL_PATH = "face_detection_yunet_2023mar.onnx"

# YuNet Face Detection Parameters
FACE_SCORE_THRESHOLD = 0.6
FACE_NMS_THRESHOLD = 0.3
FACE_TOP_K = 5000
FACE_INPUT_DIM = (320, 320)
FACE_PADDING_RATIO = 0.1

# PII & OCR Settings
NLP_SPACY_MODEL = "en_core_web_sm"
NLP_LANGUAGE = "en"
TEXT_PADDING_PX = 2
PII_CONFIDENCE_THRESHOLD = 0.35
LABEL_BLUR_LEAD_PX = 6  # Compensates for character width variance & boundary fade

# Form-Aware Spatial Thresholds (Handles vertically stacked questions & inputs)
FORM_VERTICAL_PROXIMITY_PX = 95
FORM_HORIZONTAL_ALIGN_TOLERANCE_PX = 120

# Trigger keywords for web forms (Google Forms, SurveyMonkey, etc.)
FORM_LABEL_TRIGGERS = [
    "name", "full name", "first name", "last name",
    "email", "email address", "your email",
    "phone", "mobile", "contact number", "phone number",
    "address", "card", "card number", "ssn", "aadhaar", "pan"
]

# Sensitive Inline Field Labels (e.g., "Name: John Doe")
SENSITIVE_FIELD_LABELS = ["name", "email", "card", "phone", "ssn", "user", "holder", "account"]

# Target Entities for Presidio NLP Engine
TARGET_PII_ENTITIES = [
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "CRYPTO",
    "IBAN_CODE",
    "US_SSN",
    "US_BANK_NUMBER",
]

# Standalone Regex Matchers (Fallback for un-labeled strings)
EMAIL_REGEX = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
PHONE_REGEX = re.compile(r"(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")
CARD_REGEX = re.compile(r"\b(?:\d[ -]*?){13,16}\b")

# Blur & Compression Parameters
BLUR_KERNEL_DIVISOR = 3
BLUR_MIN_KERNEL_SIZE = 15
BLUR_SIGMA = 30
JPEG_COMPRESSION_QUALITY = 85

# ==============================================================================
# LOGGING SETUP
# ==============================================================================
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("VarunRedactor")
logging.getLogger("presidio-analyzer").setLevel(logging.ERROR)

# ==============================================================================
# ENGINE INITIALIZATION (LOW-RAM NLP)
# ==============================================================================
if not os.path.exists(YUNET_MODEL_PATH):
    raise FileNotFoundError(f"Missing face model at: {YUNET_MODEL_PATH}")

logger.info("Initializing low-memory NLP provider...")
nlp_configuration = {
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": NLP_SPACY_MODEL}],
}
provider = NlpEngineProvider(nlp_configuration=nlp_configuration)
nlp_engine = provider.create_engine()

pii_analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=[NLP_LANGUAGE])
ocr = RapidOCR()

face_detector = cv2.FaceDetectorYN.create(
    model=YUNET_MODEL_PATH,
    config="",
    input_size=FACE_INPUT_DIM,
    score_threshold=FACE_SCORE_THRESHOLD,
    nms_threshold=FACE_NMS_THRESHOLD,
    top_k=FACE_TOP_K,
)
logger.info("Engines loaded successfully.")

app = FastAPI(title="Varun Face & PII Redactor")

# ==============================================================================
# IMAGE PROCESSING PIPELINE
# ==============================================================================
def apply_heavy_blur(roi: np.ndarray) -> np.ndarray:
    """Applies a double-pass Gaussian blur scaled to region dimensions."""
    rh, rw = roi.shape[:2]
    if rh <= 0 or rw <= 0:
        return roi

    k_w = max(BLUR_MIN_KERNEL_SIZE, (rw // BLUR_KERNEL_DIVISOR) | 1)
    k_h = max(BLUR_MIN_KERNEL_SIZE, (rh // BLUR_KERNEL_DIVISOR) | 1)

    blurred = cv2.GaussianBlur(roi, (k_w, k_h), sigmaX=BLUR_SIGMA, sigmaY=BLUR_SIGMA)
    blurred = cv2.GaussianBlur(blurred, (k_w, k_h), sigmaX=BLUR_SIGMA, sigmaY=BLUR_SIGMA)
    return blurred


def redact_image(b64_str: str) -> str:
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]

    img_data = base64.b64decode(b64_str)
    nparr = np.frombuffer(img_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    del img_data, nparr

    if img is None:
        raise ValueError("Corrupt image data.")

    h, w, _ = img.shape

    # ---------------------------------------------------------
    # 1. Face Detection & Blurring (YuNet)
    # ---------------------------------------------------------
    face_detector.setInputSize((w, h))
    _, faces = face_detector.detect(img)
    if faces is not None:
        for face in faces:
            fx, fy, fw, fh = map(int, face[:4])
            pad_x = int(fw * FACE_PADDING_RATIO)
            pad_y = int(fh * FACE_PADDING_RATIO)
            x1 = max(0, fx - pad_x)
            y1 = max(0, fy - pad_y)
            x2 = min(w, fx + fw + pad_x)
            y2 = min(h, fy + fh + pad_y)

            face_roi = img[y1:y2, x1:x2]
            img[y1:y2, x1:x2] = apply_heavy_blur(face_roi)

    # ---------------------------------------------------------
    # 2. Extract All Text Blocks via RapidOCR
    # ---------------------------------------------------------
    ocr_results, _ = ocr(img)
    if not ocr_results:
        _, buffer = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_COMPRESSION_QUALITY])
        del img
        out_b64 = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"
        del buffer
        return out_b64

    # Structure OCR outputs for relational lookups
    blocks = []
    for bbox, raw_text, score in ocr_results:
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

    # ---------------------------------------------------------
    # 3. Spatial Form Association (Vertical Stacking in Forms)
    # ---------------------------------------------------------
    for i, label_block in enumerate(blocks):
        lbl_lower = label_block["text"].lower().strip()

        # Check if block matches a form question label
        if any(trig == lbl_lower or lbl_lower.startswith(trig) for trig in FORM_LABEL_TRIGGERS):
            lx, ly, lw, lh = label_block["rect"]
            label_bottom = ly + lh

            # Search for subsequent blocks situated directly below this question label
            for j, candidate in enumerate(blocks):
                if i == j or candidate["blurred"]:
                    continue

                cx, cy, cw, ch = candidate["rect"]
                vert_dist = cy - label_bottom
                horiz_overlap = abs(cx - lx)

                if 0 <= vert_dist <= FORM_VERTICAL_PROXIMITY_PX and horiz_overlap <= FORM_HORIZONTAL_ALIGN_TOLERANCE_PX:
                    cand_lower = candidate["text"].lower()
                    if any(cand_lower.startswith(t) for t in FORM_LABEL_TRIGGERS):
                        continue

                    # Don't blur placeholder indicators
                    if cand_lower == "your answer":
                        continue

                    logger.info(f"Form Association: Blurring '{candidate['text']}' under '{label_block['text']}'")

                    px1 = max(0, cx - TEXT_PADDING_PX)
                    py1 = max(0, cy - TEXT_PADDING_PX)
                    px2 = min(w, cx + cw + TEXT_PADDING_PX)
                    py2 = min(h, cy + ch + TEXT_PADDING_PX)

                    if px2 > px1 and py2 > py1:
                        val_roi = img[py1:py2, px1:px2]
                        img[py1:py2, px1:px2] = apply_heavy_blur(val_roi)
                        candidate["blurred"] = True

    # ---------------------------------------------------------
    # 4. Inline Labels & Standalone Values (Colons, Regex, Presidio)
    # ---------------------------------------------------------
    for blk in blocks:
        if blk["blurred"]:
            continue

        text = blk["text"]
        bx, by, bw, bh = blk["rect"]
        total_len = len(text)
        char_w = bw / max(1, total_len)

        # Case A: Horizontal inline colon pair (e.g., "Name: John Doe")
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
                        val_roi = img[py1:py2, px1:px2]
                        img[py1:py2, px1:px2] = apply_heavy_blur(val_roi)
                        blk["blurred"] = True
                        continue

        # Case B: Regex fallback (unlabeled emails, cards, phone numbers)
        regex_matches = []
        for r in [EMAIL_REGEX, PHONE_REGEX, CARD_REGEX]:
            m = r.search(text)
            if m:
                regex_matches.append((m.start(), m.end()))

        # Case C: Presidio entities
        findings = pii_analyzer.analyze(
            text=text,
            language=NLP_LANGUAGE,
            entities=TARGET_PII_ENTITIES,
            score_threshold=PII_CONFIDENCE_THRESHOLD,
        )
        if findings:
            regex_matches.extend([(f.start, f.end) for f in findings])

        if regex_matches:
            for start_idx, end_idx in regex_matches:
                sub_x1 = int(bx + (start_idx * char_w))
                sub_x2 = int(bx + (end_idx * char_w))

                px1 = max(0, sub_x1 - 4)
                py1 = max(0, by - TEXT_PADDING_PX)
                px2 = min(w, sub_x2 + TEXT_PADDING_PX)
                py2 = min(h, by + bh + TEXT_PADDING_PX)

                if px2 > px1 and py2 > py1:
                    val_roi = img[py1:py2, px1:px2]
                    img[py1:py2, px1:px2] = apply_heavy_blur(val_roi)
                    blk["blurred"] = True

    # ---------------------------------------------------------
    # 5. Output Encoding
    # ---------------------------------------------------------
    _, buffer = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_COMPRESSION_QUALITY])
    del img

    out_b64 = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"
    del buffer
    return out_b64

# ==============================================================================
# WEBSOCKET ROUTING (WITH TELEMETRY & GC SWEEP)
# ==============================================================================
@app.websocket(WS_ENDPOINT)
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info(f"Client connected via ws://{SERVER_HOST}:{SERVER_PORT}{WS_ENDPOINT}")

    try:
        while True:
            raw_text = await websocket.receive_text()
            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({
                    "type": "ERROR",
                    "request_id": "unknown",
                    "error": "Invalid JSON format."
                }))
                continue

            msg_type = data.get("type")
            req_id = data.get("request_id", "req_unknown")

            if msg_type == "RAW_SCREENSHOT":
                try:
                    raw_b64 = data.get("image")
                    if not raw_b64:
                        raise ValueError("Payload missing 'image' field.")

                    start_time = time.perf_counter()
                    redacted_b64 = redact_image(raw_b64)
                    elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)

                    response_payload = {
                        "type": "REDACTED_SCREENSHOT",
                        "request_id": req_id,
                        "tab_id": data.get("tab_id"),
                        "step_index": data.get("step_index"),
                        "image": redacted_b64,
                        "processing_time_ms": elapsed_ms,
                        "action_result": data.get("action_result")
                    }

                    await websocket.send_text(json.dumps(response_payload))
                    logger.info(f"Redacted step {data.get('step_index')} in {elapsed_ms} ms")

                    del raw_b64, redacted_b64, response_payload, data, raw_text
                    gc.collect()

                except Exception as e:
                    logger.error(f"Redaction failed: {e}")
                    await websocket.send_text(json.dumps({
                        "type": "ERROR",
                        "request_id": req_id,
                        "error": f"Redaction failed: {str(e)}"
                    }))
                    gc.collect()
            else:
                await websocket.send_text(json.dumps({
                    "type": "ERROR",
                    "request_id": req_id,
                    "error": f"Unhandled type '{msg_type}'"
                }))

    except WebSocketDisconnect:
        logger.info("Client disconnected.")
        gc.collect()

# ==============================================================================
# APPLICATION ENTRYPOINT
# ==============================================================================
if __name__ == "__main__":
    uvicorn.run(
        app,
        host=SERVER_HOST,
        port=SERVER_PORT,
        ws_max_size=MAX_PAYLOAD_BYTES
    )