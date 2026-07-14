#!/usr/bin/env python3
"""Manga Translator OCR Native Messaging Host.

Chrome Native Messaging protocol:
  - stdin/stdout: 4-byte message length (uint32 LE) + JSON payload
  - Extension sends {"command": "start"} | {"command": "ping"}
  - Host responds with {"status": "started" | "running" | "error", ...}
  - On stdin close (extension disconnect): kills OCR server and exits

The project root is passed via the PROJECT_ROOT environment variable from the
launcher batch file. This way the script works from any install location.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import time
import urllib.request

# Project root is set by the launcher batch file
PROJECT_ROOT = os.environ.get("PROJECT_ROOT", os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SERVER_DIR = os.path.join(PROJECT_ROOT, "local-ocr-service")
SERVER_SCRIPT = os.path.join(SERVER_DIR, "server.py")
HEALTH_URL = "http://127.0.0.1:8765/health"
SERVER_START_TIMEOUT = 90  # max seconds to wait for server readiness (PaddleOCR takes time)

server_process: subprocess.Popen | None = None


def send_message(msg: dict) -> None:
    """Send JSON message to Chrome via stdout (native messaging protocol)."""
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def read_message() -> dict | None:
    """Read JSON message from Chrome via stdin (native messaging protocol)."""
    raw = sys.stdin.buffer.read(4)
    if not raw or len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    if length == 0:
        return None
    payload = sys.stdin.buffer.read(length)
    return json.loads(payload.decode("utf-8"))


def check_health() -> bool:
    """Ping OCR server health endpoint."""
    try:
        req = urllib.request.Request(HEALTH_URL, method="GET")
        resp = urllib.request.urlopen(req, timeout=2)
        data = json.loads(resp.read().decode("utf-8"))
        return bool(data.get("ok"))
    except Exception:
        return False


def start_ocr_server() -> dict:
    """Launch server.py and wait for it to become healthy."""
    global server_process

    if not os.path.isfile(SERVER_SCRIPT):
        return {"status": "error", "error": f"server.py not found at {SERVER_SCRIPT}"}

    # Check conda environment
    conda_env = os.environ.get("CONDA_DEFAULT_ENV", "")
    python_exe = sys.executable

    # Launch server as subprocess
    try:
        server_process = subprocess.Popen(
            [python_exe, SERVER_SCRIPT],
            cwd=SERVER_DIR,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except Exception as exc:
        return {"status": "error", "error": f"Failed to launch server: {exc}"}

    # Poll health endpoint
    for _ in range(SERVER_START_TIMEOUT):
        if check_health():
            return {"status": "started", "pid": server_process.pid}
        time.sleep(1)

    # Timeout
    stop_ocr_server()
    return {"status": "error", "error": f"OCR server failed to start within {SERVER_START_TIMEOUT}s"}


def stop_ocr_server() -> None:
    """Kill the OCR server process."""
    global server_process
    if server_process is None:
        return
    try:
        server_process.terminate()
        server_process.wait(timeout=5)
    except Exception:
        try:
            server_process.kill()
        except Exception:
            pass
    server_process = None


def main() -> None:
    """Main loop: read commands from Chrome, manage OCR server."""
    message = read_message()
    if message is None:
        # Chrome closed the connection before sending anything
        return

    command = message.get("command", "")

    if command == "start":
        result = start_ocr_server()
        send_message(result)

    elif command == "ping":
        is_healthy = check_health()
        send_message({
            "status": "running" if is_healthy else "stopped",
            "serverRunning": is_healthy,
        })

    # Wait for disconnect (stdin closes when extension disconnects)
    try:
        while True:
            msg = read_message()
            if msg is None:
                break
            cmd = msg.get("command", "")
            if cmd == "ping":
                send_message({
                    "status": "running" if check_health() else "stopped",
                    "serverRunning": check_health(),
                })
            elif cmd == "stop":
                stop_ocr_server()
                send_message({"status": "stopped"})
                break
    except (EOFError, BrokenPipeError, struct.error):
        pass
    finally:
        stop_ocr_server()


if __name__ == "__main__":
    main()
