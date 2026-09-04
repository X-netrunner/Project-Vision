import os
import sys
import datetime

# ==============================================================================
# LOGGING & STREAMS SETUP (Terminal + File Mirroring)
# ==============================================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOGS_DIR = os.path.join(BASE_DIR, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)

session_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
LOG_FILE_PATH = os.path.join(LOGS_DIR, f"redactor_{session_timestamp}.log")

class TeeLogger:
    """Mirrors console writes to both terminal output and a log file."""
    def __init__(self, stream, file_path):
        self.stream = stream
        self.file = open(file_path, "a", encoding="utf-8", buffering=1)

    def write(self, message):
        self.stream.write(message)
        self.file.write(message)
        self.flush()

    def flush(self):
        self.stream.flush()
        self.file.flush()

    def isatty(self):
        return hasattr(self.stream, "isatty") and self.stream.isatty()

    def fileno(self):
        return self.stream.fileno()

# Redirect stdout and stderr immediately
sys.stdout = TeeLogger(sys.stdout, LOG_FILE_PATH)
sys.stderr = TeeLogger(sys.stderr, LOG_FILE_PATH)

print(f"[INIT] Session log initialized: {LOG_FILE_PATH}")

# ==============================================================================
# PRE-FLIGHT ASSET & DEPENDENCY RESOLUTION
# ==============================================================================
import subprocess
import importlib.util
import urllib.request

REQUIREMENTS_PATH = os.path.join(BASE_DIR, "requirements.txt")
YUNET_PATH = os.path.join(BASE_DIR, "face_detection_yunet_2023mar.onnx")
YUNET_DOWNLOAD_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)

def ensure_model_exists():
    """Downloads YuNet ONNX model into local directory if missing."""
    if not os.path.exists(YUNET_PATH):
        print(f"[PRE-FLIGHT] YuNet model missing. Downloading to {YUNET_PATH}...")
        try:
            headers = {"User-Agent": "Mozilla/5.0"}
            req = urllib.request.Request(YUNET_DOWNLOAD_URL, headers=headers)
            with urllib.request.urlopen(req) as response, open(YUNET_PATH, "wb") as out_file:
                out_file.write(response.read())
            print("[PRE-FLIGHT] Model downloaded successfully.")
        except Exception as e:
            print(f"[PRE-FLIGHT] Error downloading model: {e}")
            sys.exit(1)

def ensure_dependencies():
    """Checks requirements.txt and installs all packages if any are missing."""
    if not os.path.exists(REQUIREMENTS_PATH):
        print(f"[PRE-FLIGHT] Warning: '{REQUIREMENTS_PATH}' not found. Skipping dependency installation.")
        return

    try:
        from packaging.requirements import Requirement
    except ImportError:
        print("[PRE-FLIGHT] Installing 'packaging' helper...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "packaging"])
        from packaging.requirements import Requirement

    needs_install = False

    with open(REQUIREMENTS_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            if "@" in line:
                pkg_name = line.split("@")[0].strip().replace("-", "_")
                if importlib.util.find_spec(pkg_name) is None:
                    needs_install = True
                    break
                continue

            try:
                req = Requirement(line)
                clean_name = req.name.lower().replace("-", "_")

                module_map = {
                    "opencv_python_headless": "cv2",
                    "opencv_python": "cv2",
                    "rapidocr_onnxruntime": "rapidocr_onnxruntime",
                    "presidio_analyzer": "presidio_analyzer",
                }
                module_name = module_map.get(clean_name, clean_name)

                if importlib.util.find_spec(module_name) is None:
                    needs_install = True
                    break
            except Exception:
                needs_install = True
                break

    if needs_install:
        print(f"[PRE-FLIGHT] Dependencies missing. Installing from {REQUIREMENTS_PATH}...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", REQUIREMENTS_PATH])
            print("[PRE-FLIGHT] All dependencies installed successfully.\n")
        except subprocess.CalledProcessError as e:
            print(f"[PRE-FLIGHT] Installation failed with exit code {e.returncode}.")
            sys.exit(1)

def ensure_opencv_headless():
    """
    Guards against the opencv-python / opencv-python-headless collision.

    rapidocr-onnxruntime depends on plain 'opencv-python' (GUI build, needs
    system libGL/Qt), while this project needs the 'opencv-python-headless'
    build (no cv2.imshow/GUI calls exist anywhere in this codebase). Both
    packages install into the same 'cv2' import namespace, so pip can end
    up with either one "winning" depending on install order -- and that
    order isn't guaranteed to be the same across the different machines
    this gets launched on via the Chrome extension.

    Both packages also install into the *same file paths* on disk, not just
    the same namespace. That means pip's per-package uninstall manifest can
    go stale: if headless gets force-reinstalled over GUI (this function's
    own repair step does exactly that) and someone later runs
    `pip uninstall opencv-python`, pip deletes files by its old manifest --
    which now includes files that were physically overwritten with headless
    content. The GUI package is gone, but it silently guts the headless
    install with it (e.g. cv2.FaceDetectorYN vanishes).

    So a presence check alone ("is the headless dist installed") isn't
    enough -- the files backing it can be missing even though the dist-info
    says it's there. This does a real functional smoke test (imports cv2 and
    touches a symbol this codebase actually needs) and treats any failure,
    for any reason, as "needs a clean reinstall."
    """
    try:
        import importlib.metadata as importlib_metadata
    except ImportError:
        import importlib_metadata  # type: ignore

    def _installed(dist_name):
        try:
            importlib_metadata.distribution(dist_name)
            return True
        except importlib_metadata.PackageNotFoundError:
            return False

    def _cv2_functional():
        """Actually import cv2 and touch the symbols this app depends on,
        in a subprocess so a broken/partial cv2 can't crash this process."""
        probe = (
            "import cv2; "
            "assert hasattr(cv2, 'FaceDetectorYN'); "
            "assert hasattr(cv2, 'dnn'); "
            "assert hasattr(cv2, 'imencode')"
        )
        result = subprocess.run(
            [sys.executable, "-c", probe],
            capture_output=True, text=True
        )
        return result.returncode == 0

    def _reinstall_headless(reason):
        print(f"[PRE-FLIGHT] {reason} -- reinstalling opencv-python-headless cleanly...")
        try:
            subprocess.check_call([
                sys.executable, "-m", "pip", "install",
                "--force-reinstall", "--no-deps", "opencv-python-headless"
            ])
            print("[PRE-FLIGHT] cv2 resolved to a clean headless build.\n")
        except subprocess.CalledProcessError as e:
            print(f"[PRE-FLIGHT] Failed to reinstall opencv-python-headless: {e}")
            sys.exit(1)

    gui_present = _installed("opencv-python")
    headless_present = _installed("opencv-python-headless")

    if gui_present:
        _reinstall_headless(
            "Detected GUI 'opencv-python' alongside headless build"
        )
    elif not headless_present:
        # Neither variant present yet (fresh env, requirements install above
        # may have skipped it) -- install headless explicitly.
        try:
            subprocess.check_call([
                sys.executable, "-m", "pip", "install", "opencv-python-headless"
            ])
        except subprocess.CalledProcessError as e:
            print(f"[PRE-FLIGHT] Failed to install opencv-python-headless: {e}")
            sys.exit(1)
    elif not _cv2_functional():
        # dist-info says headless is installed, but the files backing it are
        # missing or broken (e.g. a prior 'pip uninstall opencv-python' tore
        # out files that had been overwritten with headless content).
        _reinstall_headless(
            "opencv-python-headless is registered but cv2 failed a functional check"
        )

# Execute checks before internal application imports
ensure_dependencies()
ensure_opencv_headless()
ensure_model_exists()

# ==============================================================================
# APPLICATION LOGIC & IMPORTS
# ==============================================================================
import gc
import json
import logging
import time
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from redact import redact_image
from config import SERVER_HOST, SERVER_PORT, WS_ENDPOINT, MAX_PAYLOAD_BYTES

# Configure Python logging to write directly into the mirrored stdout stream
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("VarunRedactor")

app = FastAPI(title="Varun Face & PII Redactor")

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

if __name__ == "__main__":
    uvicorn.run(
        app,
        host=SERVER_HOST,
        port=SERVER_PORT,
        ws_max_size=MAX_PAYLOAD_BYTES,
        log_config=None  # Preserves custom logger handlers and stdout mirroring
    )