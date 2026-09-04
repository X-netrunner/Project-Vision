"""Project-Vision Chrome Native Messaging host.

Chrome starts this host when the extension asks for the registered native host.
The host then starts the existing app.py without changing its API or protocol.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import struct
import subprocess
import sys

# Never create __pycache__ for this launcher/host.
os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
sys.dont_write_bytecode = True

HOST_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = Path(os.environ.get("PROJECT_VISION_ROOT", HOST_DIR.parent)).resolve()


def find_server_app() -> Path:
    explicit = os.environ.get("PROJECT_VISION_APP")
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser().resolve())
    candidates.extend(
        [
            PROJECT_ROOT / "varun" / "app.py",
            PROJECT_ROOT / "app.py",
            PROJECT_ROOT / "protoType" / "app.py",
        ]
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    checked = "\n".join(f"  - {path}" for path in candidates)
    raise FileNotFoundError(
        "Could not find the existing app.py. Put it in one of these locations:\n" + checked
    )


def send(message: dict) -> None:
    payload = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) != 4:
        return None
    length = struct.unpack("<I", raw_len)[0]
    raw = sys.stdin.buffer.read(length)
    if len(raw) != length:
        return None
    return json.loads(raw.decode("utf-8"))


def main() -> None:
    try:
        server_app = find_server_app()
    except Exception as exc:
        send({"type": "SERVER_STATUS", "status": "error", "error": str(exc)})
        return

    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    # Keep the app's existing relative-path behavior intact.
    server = subprocess.Popen(
        [sys.executable, "-B", str(server_app)],
        cwd=str(server_app.parent),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    send({"type": "SERVER_STATUS", "status": "started", "pid": server.pid})

    while True:
        message = read_message()
        if message is None:
            break
        if message.get("type") == "PING":
            if server.poll() is None:
                send({"type": "SERVER_STATUS", "status": "running", "pid": server.pid})
            else:
                send({
                    "type": "SERVER_STATUS",
                    "status": "exited",
                    "pid": server.pid,
                    "returncode": server.returncode,
                })
        elif message.get("type") == "STOP":
            if server.poll() is None:
                server.terminate()
            send({"type": "SERVER_STATUS", "status": "stopping"})
            break


if __name__ == "__main__":
    main()
