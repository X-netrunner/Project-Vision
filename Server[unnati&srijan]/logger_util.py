import base64
import io
import os
import re
import time
from datetime import datetime

from PIL import Image

SCREENSHOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots")
LOG_FILENAME = "server.log"

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"

CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
MAGENTA = "\033[95m"
BLUE = "\033[94m"

_use_color = True


def _ts() -> str:
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def _p(level: str, color: str, msg: str):
    line = f"[{_ts()}] [{level}] {msg}"
    if _use_color and _file_ok():
        print(f"{color}{BOLD}[{_ts()}]{RESET} [{color}{level}{RESET}] {msg}")
    else:
        print(line)


def _file_ok() -> bool:
    try:
        os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs"), exist_ok=True)
        return True
    except Exception:
        return False


def info(msg: str):    _p("INFO", CYAN, msg)
def ok(msg: str):      _p(" OK ", GREEN, msg)
def warn(msg: str):    _p("WARN", YELLOW, msg)
def error(msg: str):   _p("ERR ", RED, msg)
def step(msg: str):    _p("STEP", BLUE, msg)
def task(msg: str):    _p("TASK", MAGENTA, msg)


def sanitize_filename(name: str, max_len: int = 60) -> str:
    name = re.sub(r"[^A-Za-z0-9_.\- ]+", "_", name).strip().replace(" ", "_")
    return name[:max_len].strip("_") or "step"


def save_screenshot(base64_img: str, label: str = "screenshot") -> str | None:
    """Save a raw base64 screenshot to the screenshots/ folder.

    Returns the saved file path (or None on failure). The label is used to
    build a human-readable filename like '<timestamp>_<label>.png'.
    """
    if not base64_img:
        return None
    try:
        os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
        fname = f"{ts}_{sanitize_filename(label)}.png"
        path = os.path.join(SCREENSHOT_DIR, fname)

        b64 = base64_img.strip().strip('"').strip("'")
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        b64 = "".join(b64.split())
        if len(b64) % 4:
            b64 += "=" * (4 - len(b64) % 4)

        data = base64.b64decode(b64)
        img = Image.open(io.BytesIO(data)).convert("RGB")
        img.save(path)
        return path
    except Exception as e:
        warn(f"Failed to save screenshot: {e}")
        return None
