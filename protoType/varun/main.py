import os
import sys
import datetime
from config import LOG_RETENTION_COUNT, YUNET_MIN_EXPECTED_BYTES


# ==============================================================================
# LOGGING & STREAMS SETUP (Terminal + File Mirroring)
# ==============================================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOGS_DIR = os.path.join(BASE_DIR, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)


def _prune_old_logs(logs_dir: str, keep: int) -> None:
    """Keeps at most `keep` most recent session log files, deleting older ones.

    Session logs previously accumulated forever with no cleanup, which -- combined
    with per-request payload logging -- meant sensitive data could pile up on disk
    indefinitely. Runs once at startup before the new session log is opened.
    """
    try:
        existing = [
            os.path.join(logs_dir, f)
            for f in os.listdir(logs_dir)
            if f.startswith("redactor_") and f.endswith(".log")
        ]
        existing.sort(key=os.path.getmtime, reverse=True)
        for old_path in existing[max(0, keep - 1):]:
            try:
                os.remove(old_path)
            except OSError:
                pass
    except OSError:
        pass


_prune_old_logs(LOGS_DIR, LOG_RETENTION_COUNT)

session_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
LOG_FILE_PATH = os.path.join(LOGS_DIR, f"redactor_{session_timestamp}.log")

# Open shared log file for the session
log_file_handle = open(LOG_FILE_PATH, "a", encoding="utf-8", buffering=1)

class TeeLogger:
    """Mirrors console writes to both terminal output and a log file."""
    def __init__(self, stream, file_obj):
        self.stream = stream
        self.file = file_obj

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
sys.stdout = TeeLogger(sys.stdout, log_file_handle)
sys.stderr = TeeLogger(sys.stderr, log_file_handle)

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

            # Basic integrity sanity check -- catches truncated/corrupt downloads
            # (e.g. an interrupted connection, or an HTML error page saved instead
            # of the binary model) before the app tries to load it as an ONNX net.
            downloaded_size = os.path.getsize(YUNET_PATH)
            if downloaded_size < YUNET_MIN_EXPECTED_BYTES:
                os.remove(YUNET_PATH)
                raise ValueError(
                    f"Downloaded model file is only {downloaded_size} bytes "
                    f"(expected at least {YUNET_MIN_EXPECTED_BYTES}); download likely corrupted."
                )

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

    def _reinstall_headless(reason, uninstall_gui_first=False):
        print(f"[PRE-FLIGHT] {reason} -- reinstalling opencv-python-headless cleanly...")
        try:
            if uninstall_gui_first:
                # Order matters: uninstall GUI *before* headless ever touches
                # its files, so pip removes GUI's own untouched files by its
                # manifest. Doing this the other way around (reinstall
                # headless on top, uninstall GUI after) is what corrupts cv2
                # -- pip would then delete files by GUI's stale manifest that
                # have since been overwritten with headless's content.
                subprocess.check_call([
                    sys.executable, "-m", "pip", "uninstall", "-y", "opencv-python"
                ])
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
        # Uninstall GUI first (see _reinstall_headless) so opencv-python's
        # dist-info is actually removed -- otherwise this branch fires again
        # on every future launch even though nothing is wrong.
        _reinstall_headless(
            "Detected GUI 'opencv-python' alongside headless build",
            uninstall_gui_first=True
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
import asyncio
from contextlib import asynccontextmanager
import gc
import json
import logging
import time
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from redact import redact_image
from config import SERVER_HOST, SERVER_PORT, WS_ENDPOINT, MAX_PAYLOAD_BYTES, GC_COLLECT_INTERVAL

# Standard logger for application lifecycle (terminal + log file via TeeLogger)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("VarunRedactor")

# Dedicated logger strictly writing to file (bypasses terminal display)
payload_file_handler = logging.FileHandler(LOG_FILE_PATH, encoding="utf-8")
payload_file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))

payload_file_logger = logging.getLogger("PayloadLogger")
payload_file_logger.setLevel(logging.INFO)
payload_file_logger.addHandler(payload_file_handler)
payload_file_logger.propagate = False  # Avoid echoing to root logger and terminal

# Counts processed messages so gc.collect() runs periodically instead of on every
# single message -- a full GC sweep per message adds a real latency tax to what's
# meant to be a low-latency, per-screenshot pipeline.
_processed_message_count = 0

def _maybe_collect() -> None:
    global _processed_message_count
    _processed_message_count += 1
    if _processed_message_count % GC_COLLECT_INTERVAL == 0:
        gc.collect()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Pre-warms deep learning models during server startup before receiving traffic."""
    logger.info("[INIT] Pre-warming OCR, NLP, and Face Detection pipelines...")
    start_warmup = time.perf_counter()
    try:
        dummy_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        payload_file_logger.info(f"[WARMUP-IN] {len(dummy_b64)} base64 chars (image content intentionally not logged)")
        warmup_out = await asyncio.to_thread(redact_image, dummy_b64)
        payload_file_logger.info(f"[WARMUP-OUT] {len(warmup_out)} base64 chars (image content intentionally not logged)")
        warmup_duration = round((time.perf_counter() - start_warmup) * 1000, 2)
        logger.info(f"[INIT] Models pre-warmed successfully in {warmup_duration} ms. Server ready.")
    except Exception as e:
        logger.warning(f"[INIT] Cold-start pre-warm encountered an error: {e}")
    yield

app = FastAPI(title="Varun Face & PII Redactor", lifespan=lifespan)

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

                    # Metadata only -- the actual image content is never written to
                    # disk. This pipeline exists to strip PII/faces before a
                    # screenshot goes anywhere; logging the raw payload here would
                    # permanently persist the exact data it's meant to remove.
                    payload_file_logger.info(
                        f"[{req_id}] INCOMING RAW_SCREENSHOT (step {data.get('step_index')}): "
                        f"{len(raw_b64)} base64 chars (image content intentionally not logged)"
                    )

                    start_time = time.perf_counter()
                    # Offload the blocking CPU-bound redaction pipeline to an async worker thread
                    redacted_b64 = await asyncio.to_thread(redact_image, raw_b64)
                    elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)

                    payload_file_logger.info(
                        f"[{req_id}] OUTGOING REDACTED_SCREENSHOT (step {data.get('step_index')}): "
                        f"{len(redacted_b64)} base64 chars (image content intentionally not logged)"
                    )

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
                    _maybe_collect()

                except Exception as e:
                    logger.error(f"Redaction failed: {e}")
                    await websocket.send_text(json.dumps({
                        "type": "ERROR",
                        "request_id": req_id,
                        "error": f"Redaction failed: {str(e)}"
                    }))
                    _maybe_collect()
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
        ws_ping_interval=20.0,
        ws_ping_timeout=120.0,
        log_config=None  # Preserves custom logger handlers and stdout mirroring
    )