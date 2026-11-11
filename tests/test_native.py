import json
import os
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST = ROOT / "native-host/host.py"
EXTENSION_ID = "a" * 32


def test_manifest_and_origin(tmp_path):
    state = tmp_path / "private state"
    chrome_data = tmp_path / "isolated profile"
    manifest_dir = chrome_data / "NativeMessagingHosts"
    subprocess.run([
        sys.executable, str(ROOT / "native-host/install.py"), EXTENSION_ID,
        "--state", str(state),
    ], env={**os.environ, "DEEPSEEK_BRIDGE_CHROME_DATA": str(chrome_data)},
        check=True, capture_output=True)
    manifest = json.loads((manifest_dir / "com.deepseek.bridge.json").read_text())
    assert manifest["allowed_origins"] == [f"chrome-extension://{EXTENSION_ID}/"]
    launcher = Path(manifest["path"])
    assert launcher.stat().st_mode & 0o777 == 0o700
    rejected = subprocess.run(
        [str(launcher), "chrome-extension://" + "b" * 32 + "/"], capture_output=True,
    )
    assert rejected.returncode != 0
    assert rejected.stdout == b""
    assert b"rejected" in rejected.stderr


def test_bad_native_frame_is_rejected_without_echoing_data():
    result = subprocess.run(
        [sys.executable, str(HOST), f"chrome-extension://{EXTENSION_ID}/"],
        env={**os.environ, "DEEPSEEK_BRIDGE_EXTENSION_ID": EXTENSION_ID},
        input=struct.pack("=I", 1_048_577) + b"untrusted frame",
        capture_output=True, check=True,
    )
    assert result.stdout == b""
    assert b"Invalid native message frame" in result.stderr
    assert b"untrusted" not in result.stderr


def test_full_browser_protocol(tmp_path):
    state = tmp_path / "state"
    manifest_dir = tmp_path / "Chrome Data" / "NativeMessagingHosts"
    subprocess.run([
        sys.executable, str(ROOT / "native-host/install.py"), EXTENSION_ID,
        "--state", str(state), "--manifest-dir", str(manifest_dir),
    ], check=True, capture_output=True)
    manifest = json.loads((manifest_dir / "com.deepseek.bridge.json").read_text())
    subprocess.run(
        ["node", "tests/e2e.cjs"],
        cwd=ROOT,
        env={
            **os.environ,
            "DEEPSEEK_BRIDGE_STATE": str(state),
            "BRIDGE_TEST_PYTHON": sys.executable,
            "BRIDGE_TEST_NATIVE_LAUNCHER": manifest["path"],
            "DEEPSEEK_BRIDGE_EXTENSION_ID": EXTENSION_ID,
        },
        timeout=100, check=True,
    )
