import cv2
import numpy as np
from config import BLUR_KERNEL_DIVISOR, BLUR_MIN_KERNEL_SIZE, BLUR_SIGMA

def apply_heavy_blur(roi: np.ndarray) -> np.ndarray:
    """Applies an irreversible, double-pass Gaussian blur scaled to ROI dimensions."""
    rh, rw = roi.shape[:2]
    if rh <= 0 or rw <= 0:
        return roi

    k_w = max(BLUR_MIN_KERNEL_SIZE, (rw // BLUR_KERNEL_DIVISOR) | 1)
    k_h = max(BLUR_MIN_KERNEL_SIZE, (rh // BLUR_KERNEL_DIVISOR) | 1)

    blurred = cv2.GaussianBlur(roi, (k_w, k_h), sigmaX=BLUR_SIGMA, sigmaY=BLUR_SIGMA)
    blurred = cv2.GaussianBlur(blurred, (k_w, k_h), sigmaX=BLUR_SIGMA, sigmaY=BLUR_SIGMA)
    return blurred