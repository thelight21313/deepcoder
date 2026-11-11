import argparse
import json
import os
import re
import shlex
import sys
from pathlib import Path

NAME = "com.deepseek.bridge"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CHROME_DATA = Path.home() / "Library/Application Support/DeepSeekBridgeChrome"


def chrome_manifest_dir():
    return Path(os.environ.get("DEEPSEEK_BRIDGE_CHROME_DATA", DEFAULT_CHROME_DATA)) / "NativeMessagingHosts"


def write_private(path: Path, contents: str, mode: int):
    temp = path.with_name(f".{path.name}.{os.getpid()}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(contents)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def install(extension_id: str, manifest_dir: Path, state: Path):
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("Expected the 32-letter extension ID shown at chrome://extensions")
    state = state.expanduser().resolve()
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.stat().st_mode & 0o077:
        raise ValueError("State directory must be private (chmod 700)")

    launcher = state / "native-launcher"
    quote = shlex.quote
    write_private(launcher, (
        "#!/bin/sh\n"
        f"export DEEPSEEK_BRIDGE_STATE={quote(str(state))}\n"
        f"export DEEPSEEK_BRIDGE_EXTENSION_ID={quote(extension_id)}\n"
        f"exec {quote(sys.executable)} {quote(str(ROOT / 'native-host/host.py'))} \"$@\"\n"
    ), 0o700)
    manifest_dir = manifest_dir.expanduser().resolve()
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest = manifest_dir / f"{NAME}.json"
    write_private(manifest, json.dumps({
        "name": NAME,
        "description": "DeepSeek Browser Bridge",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }, indent=2) + "\n", 0o600)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("extension_id")
    parser.add_argument("--manifest-dir", type=Path, default=chrome_manifest_dir())
    parser.add_argument("--state", type=Path, default=(
        Path.home() / "Library/Application Support/DeepSeekBridge"
    ))
    args = parser.parse_args()
    try:
        print(install(args.extension_id, args.manifest_dir, args.state))
    except ValueError as exc:
        parser.error(str(exc))
