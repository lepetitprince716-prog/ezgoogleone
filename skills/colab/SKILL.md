---
name: colab
description: Provision and manage Google Colab GPU/TPU runtimes (A100, L4, T4, H100) via colab-kit (wrapping google-colab-cli with --auth=adc).
---

# colab

Thin portable wrapper (`colab-kit`) over `google-colab-cli` that automatically puts `--auth=adc` before the subcommand so non-interactive ADC authentication works cleanly.

## Setup & check

```bash
colab-kit doctor
```

If missing, install `google-colab-cli` and authenticate once with `gcloud auth application-default login`.

## Commands

```bash
# Check compute unit balance and active runtimes
colab-kit usage
colab-kit sessions

# Preferred: one-shot run (auto-releases VM on exit or error)
colab-kit run --gpu A100 --high-mem train.py

# Persistent session lifecycle (always stop when done)
colab-kit new -s work1 --gpu L4
colab-kit upload -s work1 ./data.tar /content/data.tar
colab-kit exec -s work1 -f eval.py
colab-kit download -s work1 /content/results.json ./results.json
colab-kit stop -s work1
colab-kit sessions   # confirm 0 active sessions
```

Set `COLAB_KIT_DENY_DIRS` (comma-separated directory names) to prevent accidental uploads from restricted local folders.
