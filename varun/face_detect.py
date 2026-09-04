import os
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

face_detector = cv2.FaceDetectorYN.create(
    model=YUNET_MODEL_PATH,
    config="",
    input_size=FACE_INPUT_DIM,
    score_threshold=FACE_SCORE_THRESHOLD,
    nms_threshold=FACE_NMS_THRESHOLD,
    top_k=FACE_TOP_K,
)

def blur_faces(img: np.ndarray) -> np.ndarray:
    """Detects and applies heavy blur to all faces in the image matrix."""
    h, w, _ = img.shape
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

    return img