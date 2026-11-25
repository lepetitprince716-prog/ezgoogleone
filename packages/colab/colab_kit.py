#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

VALID_AUTH = ("adc", "oauth2")
PASSTHROUGH_CMDS = ("usage", "sessions", "run", "new", "stop", "exec", "upload", "download", "install", "ssh")


def adc_path() -> Path:
    custom = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if custom:
        return Path(custom).expanduser()
    return Path.home() / ".config" / "gcloud" / "application_default_credentials.json"


def doctor_report() -> dict[str, Any]:
    colab_bin = shutil.which("colab")
    gcloud_bin = shutil.which("gcloud")
    adc = adc_path()
    adc_ok = adc.is_file()
    ready = bool(colab_bin and adc_ok)
    hints: list[str] = []
    if not colab_bin:
        hints.append("Install google-colab-cli: `uv tool install google-colab-cli` or `pip install google-colab-cli`")
    if not gcloud_bin:
        hints.append("Install Google Cloud CLI (`gcloud`) so you can initialize Application Default Credentials")
    if not adc_ok:
        hints.append("Authenticate once: `gcloud auth application-default login`")
    return {
        "ok": ready,
        "colab": colab_bin,
        "gcloud": gcloud_bin,
        "adc_path": str(adc),
        "adc_present": adc_ok,
        "next": hints,
    }


def check_denied_paths(args: list[str]) -> None:
    raw = os.environ.get("COLAB_KIT_DENY_DIRS", "")
    denied = {p.strip().lower() for p in raw.split(",") if p.strip()}
    if not denied:
        return
    for tok in args:
        if tok.startswith("-"):
            continue
        p = Path(tok).expanduser()
        if p.exists():
            parts = {part.lower() for part in p.resolve().parts}
            hit = denied & parts
            if hit:
                raise ValueError(f"Refusing to pass denied path segment {sorted(hit)} to Colab: {p}")


def build_colab_cmd(subcmd: str, rest: list[str], auth: str = "adc", colab_bin: str | None = None) -> list[str]:
    if auth not in VALID_AUTH:
        raise ValueError(f"Unsupported --auth mode: {auth} (expected one of {', '.join(VALID_AUTH)})")
    if subcmd not in PASSTHROUGH_CMDS:
        raise ValueError(f"Unknown colab-kit command: {subcmd}")
    binary = colab_bin or shutil.which("colab")
    if not binary:
        raise FileNotFoundError("`colab` (google-colab-cli) not found on PATH; run `colab-kit doctor`")
    # google-colab-cli requires --auth before the subcommand; passing it after fails argument parsing.
    return [binary, f"--auth={auth}", subcmd, *rest]


def usage_text() -> str:
    return (
        "usage: colab-kit [--auth adc|oauth2] <command> [args...]\n"
        "  doctor                     Check colab CLI, gcloud, and ADC credentials\n"
        "  usage                      Check Colab compute unit balance\n"
        "  sessions                   List active Colab runtimes\n"
        "  run --gpu A100 ... script  Run one-shot script and auto-release runtime\n"
        "  new|stop|exec|upload|download|install|ssh ...\n"
    )


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    auth = os.environ.get("COLAB_KIT_AUTH", "adc").strip() or "adc"
    while args and args[0] in ("--auth", "-a"):
        if len(args) < 2:
            print("error: --auth requires a value (adc|oauth2)", file=sys.stderr)
            return 2
        auth = args[1]
        args = args[2:]
    if args and args[0].startswith("--auth="):
        auth = args[0].split("=", 1)[1]
        args = args[1:]

    if not args or args[0] in ("help", "-h", "--help"):
        print(usage_text(), end="")
        return 0

    cmd, rest = args[0], args[1:]
    if cmd == "doctor":
        rep = doctor_report()
        print(json.dumps(rep, indent=2, ensure_ascii=False))
        return 0 if rep["ok"] else 1

    try:
        check_denied_paths(rest)
        full_cmd = build_colab_cmd(cmd, rest, auth=auth)
    except (ValueError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    return subprocess.run(full_cmd, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
