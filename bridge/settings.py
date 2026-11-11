import os
import secrets
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseModel):
    deepseek_browser_enabled: bool = False
    task_timeout: int = Field(default=180, ge=20, le=900)
    lease_timeout: int = Field(default=15, ge=5, le=60)
    max_attempts: int = Field(default=3, ge=1, le=10)


def state_dir() -> Path:
    directory = Path(os.environ.get("DEEPSEEK_BRIDGE_STATE", str(
        Path.home() / "Library/Application Support/DeepSeekBridge"
    ))).expanduser()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_mode & 0o077:
        raise RuntimeError("Bridge state directory must be private (chmod 700)")
    return directory


def local_token() -> str:
    path = state_dir() / "token"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if path.stat().st_mode & 0o077:
            raise RuntimeError("Bridge token file must be private (chmod 600)")
    else:
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_urlsafe(32) + "\n")
    token = path.read_text().strip()
    if not token or not token.isascii():
        raise RuntimeError("Invalid Bridge token file")
    return token


def load_settings() -> Settings:
    with (ROOT / "config.yaml").open() as handle:
        return Settings.model_validate(yaml.safe_load(handle))
