import os
import threading
import time
from typing import List, Tuple
import cv2
import numpy as np
from blur_utils import apply_heavy_blur
from config import (
    YUNET_MODEL_PATH,
    FACE_INPUT_DIM,
    FACE_SCORE_THRESHOLD,
    FACE_NMS_THRESHOLD,
    FACE_TOP_K,
    FACE_PADDING_RATIO,
)

if not os.path.exists(YUNET_MODEL_PATH):
    raise FileNotFoundError(f"Missing face model at: {YUNET_MODEL_PATH}")

print("[PRE-FLIGHT] Loading face detection model (YuNet)...")
_face_load_start = time.perf_counter()
face_detector = cv2.FaceDetectorYN.create(
    model=YUNET_MODEL_PATH,
    config="",
    input_size=FACE_INPUT_DIM,
    score_threshold=FACE_SCORE_THRESHOLD,
    nms_threshold=FACE_NMS_THRESHOLD,
    top_k=FACE_TOP_K,
)
print(f"[PRE-FLIGHT] Face detection model loaded in {time.perf_counter() - _face_load_start:.2f}s")

# cv2.FaceDetectorYN wraps a shared cv2.dnn.Net. setInputSize() + detect() is a
# two-step, stateful call on that single global instance, so concurrent calls
# from multiple threads (e.g. two screenshots being redacted at the same time)
# can race: one thread's setInputSize() can be overwritten by another's before
# detect() runs, corrupting results for one or both images. Serialize access.
_face_detector_lock = threading.Lock()

def detect_faces(img: np.ndarray) -> List[Tuple[int, int, int, int]]:
    """Detects faces in the image and returns padded bounding coordinates (x1, y1, x2, y2)."""
    h, w, _ = img.shape

    with _face_detector_lock:
        face_detector.setInputSize((w, h))
        _, faces = face_detector.detect(img)

    boxes: List[Tuple[int, int, int, int]] = []
    if faces is not None:
        for face in faces:
            fx, fy, fw, fh = map(int, face[:4])
            pad_x = int(fw * FACE_PADDING_RATIO)
            pad_y = int(fh * FACE_PADDING_RATIO)
            x1 = max(0, fx - pad_x)
            y1 = max(0, fy - pad_y)
            x2 = min(w, fx + fw + pad_x)
            y2 = min(h, fy + fh + pad_y)

            if x2 > x1 and y2 > y1:
                boxes.append((x1, y1, x2, y2))

    return boxes

def blur_faces(img: np.ndarray) -> np.ndarray:
    """Detects and applies heavy blur to all faces in the image matrix."""
    boxes = detect_faces(img)
    for x1, y1, x2, y2 in boxes:
        roi = img[y1:y2, x1:x2]
        if roi.size > 0:
            img[y1:y2, x1:x2] = apply_heavy_blur(roi)
    return img