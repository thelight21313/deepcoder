#!/usr/bin/env python3
import http.client
import json
import logging
import os
import re
import struct
import sys
from pathlib import Path
from uuid import UUID

MAX_MESSAGE = 1_048_576
HEADER = struct.Struct("=I")
TASK_METHODS = {"start", "heartbeat", "finish"}


def read_exact(stream, size):
    data = stream.read(size)
    if len(data) != size:
        raise EOFError
    return data


def read_message(stream):
    header = stream.read(HEADER.size)
    if not header:
        return None
    if len(header) != HEADER.size:
        raise EOFError
    size = HEADER.unpack(header)[0]
    if not 0 < size <= MAX_MESSAGE:
        raise ValueError("Invalid frame length")
    payload = json.loads(read_exact(stream, size))
    if not isinstance(payload, dict):
        raise ValueError("Expected an object")
    return payload


def write_message(stream, message):
    data = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode()
    if len(data) > MAX_MESSAGE:
        data = json.dumps({"id": message["id"], "error": "response_too_large"}).encode()
    stream.write(HEADER.pack(len(data)))
    stream.write(data)
    stream.flush()


def token_path():
    default = Path.home() / "Library/Application Support/DeepSeekBridge"
    return Path(os.environ.get("DEEPSEEK_BRIDGE_STATE", default)).expanduser() / "token"


def dispatch(message):
    method = message.get("method")
    body = message.get("body")
    if not isinstance(body, dict) or not isinstance(method, str):
        raise ValueError("Invalid request")
    if method == "claim":
        path = "/internal/claim"
    elif method in TASK_METHODS:
        task_id = str(UUID(str(message.get("task_id"))))
        path = f"/internal/tasks/{task_id}/{method}"
    else:
        raise ValueError("Invalid method")

    token = token_path().read_text().strip()
    connection = http.client.HTTPConnection("127.0.0.1", 8765, timeout=3)
    try:
        connection.request("POST", path, json.dumps(body, ensure_ascii=False).encode(), {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        })
        with connection.getresponse() as response:
            if response.status == 404:
                return {"error": "stale_lease"}
            if response.status != 200:
                return {"error": "bridge_rejected"}
            data = response.read(MAX_MESSAGE + 1)
            if len(data) > MAX_MESSAGE:
                return {"error": "response_too_large"}
            return {"result": json.loads(data)}
    finally:
        connection.close()


def serve(incoming, outgoing):
    while True:
        try:
            message = read_message(incoming)
        except (EOFError, ValueError):
            logging.warning("Invalid native message frame")
            return
        if message is None:
            return
        request_id = message.get("id")
        if not isinstance(request_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", request_id):
            logging.warning("Invalid native message identifier")
            return
        try:
            response = dispatch(message)
        except (OSError, http.client.HTTPException):
            response = {"error": "bridge_unavailable"}
        except (TypeError, ValueError):
            response = {"error": "invalid_message"}
        write_message(outgoing, {"id": request_id, **response})


def main():
    allowed = os.environ.get("DEEPSEEK_BRIDGE_EXTENSION_ID", "")
    if not re.fullmatch(r"[a-p]{32}", allowed):
        raise SystemExit("Native host is missing an allowed Chrome extension ID")
    if len(sys.argv) < 2 or sys.argv[1] != f"chrome-extension://{allowed}/":
        raise SystemExit("Native host rejected Chrome caller")
    try:
        serve(sys.stdin.buffer, sys.stdout.buffer)
    except BrokenPipeError:
        pass


if __name__ == "__main__":
    main()
