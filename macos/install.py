import os
import plistlib
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bridge.settings import ROOT, state_dir  # noqa: E402


def install():
    state = state_dir().resolve()
    with (ROOT / "macos/launchagent.plist").open("rb") as source:
        plist = plistlib.load(source)
    plist["ProgramArguments"][0] = sys.executable
    plist["WorkingDirectory"] = str(ROOT)
    plist["EnvironmentVariables"]["DEEPSEEK_BRIDGE_STATE"] = str(state)
    plist["StandardOutPath"] = str(state / "bridge.log")
    plist["StandardErrorPath"] = str(state / "bridge-error.log")
    directory = Path.home() / "Library/LaunchAgents"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f'{plist["Label"]}.plist'
    temporary = path.with_suffix(".plist.tmp")
    with temporary.open("wb") as output:
        plistlib.dump(plist, output)
    temporary.replace(path)
    domain = f"gui/{os.getuid()}"
    service = f'{domain}/{plist["Label"]}'
    loaded = subprocess.run(
        ["/bin/launchctl", "print", service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if loaded.returncode == 0:
        subprocess.run(["/bin/launchctl", "bootout", service], check=True)
    subprocess.run(["/bin/launchctl", "bootstrap", domain, str(path)], check=True)
    print(path)


if __name__ == "__main__":
    install()
