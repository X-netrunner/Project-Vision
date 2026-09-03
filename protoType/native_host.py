"""Chrome Native Messaging host for the prototype.

Chrome starts this host on extension startup. The host starts the existing
server app without changing its API or source. Native Messaging registration
is OS-level configuration; all project code remains inside protoType/.
"""
from __future__ import annotations

import json
import os
import pathlib
import struct
import subprocess
import sys
sys.dont_write_bytecode = True

PROTO = pathlib.Path(__file__).resolve().parent
ROOT = PROTO.parent


def find_server_app() -> pathlib.Path:
    candidates = [
        ROOT / "varun" / "app.py",
        ROOT / "app.py",
        PROTO / "app.py",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    checked = "\n".join(f"  - {path}" for path in candidates)
    raise FileNotFoundError(
        "Could not find the existing app.py. Put it in one of these locations:\n" + checked
    )


SERVER_APP = find_server_app()


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
    if not SERVER_APP.exists():
        send({"type": "SERVER_STATUS", "status": "error", "error": f"Missing {SERVER_APP}"})
        return

    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    server = subprocess.Popen(
        [sys.executable, str(SERVER_APP)],
        cwd=str(SERVER_APP.parent),
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
            send({"type": "SERVER_STATUS", "status": "running", "pid": server.pid})
        elif message.get("type") == "STOP":
            server.terminate()
            send({"type": "SERVER_STATUS", "status": "stopping"})
            break


if __name__ == "__main__":
    main()
