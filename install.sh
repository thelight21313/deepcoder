#!/bin/sh
set -eu
cd "$(dirname "$0")"

usage() {
    printf '%s\n' 'Usage: ./install.sh CHROME_EXTENSION_ID [--launch-agent]' >&2
    exit 2
}

case "${1:-}" in
    *[!a-p]*|'') usage ;;
esac
[ "${#1}" -eq 32 ] || usage
[ "$#" -le 2 ] || usage
case "${2:-}" in
    ''|--launch-agent) ;;
    *) usage ;;
esac

if [ ! -x .venv/bin/python ]; then
    "${PYTHON_BIN:-python3}" -m venv .venv
fi
.venv/bin/python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else "Python 3.12+ required")'
.venv/bin/python -m pip install -r requirements.txt

if [ -n "${DEEPSEEK_BRIDGE_STATE:-}" ]; then
    .venv/bin/python native-host/install.py "$1" --state "$DEEPSEEK_BRIDGE_STATE"
else
    .venv/bin/python native-host/install.py "$1"
fi
.venv/bin/python -c 'from bridge.settings import local_token; local_token()'

if [ "${2:-}" = "--launch-agent" ]; then
    .venv/bin/python macos/install.py
else
    printf '%s\n' 'Start Bridge with .venv/bin/python -m bridge.main'
fi
