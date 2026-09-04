"""Prototype-only local server launcher.

This file does not modify the existing server API or server source. It starts the
existing Project-Vision/varun/app.py from the prototype directory when invoked.
"""
from __future__ import annotations

import os
import pathlib
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


def start_server() -> subprocess.Popen:
    if not SERVER_APP.exists():
        raise FileNotFoundError(f"Existing server app not found: {SERVER_APP}")

    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    # app.py uses relative model paths, so preserve the server's own working directory.
    return subprocess.Popen([sys.executable, str(SERVER_APP)], cwd=str(SERVER_APP.parent), env=env)


if __name__ == "__main__":
    process = start_server()
    print(f"Project-Vision local server started with PID {process.pid}", flush=True)
    raise SystemExit(process.wait())
