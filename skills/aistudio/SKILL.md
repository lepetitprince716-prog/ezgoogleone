---
name: aistudio
description: Drive Google AI Studio (aistudio.google.com) through ego-browser on a signed-in Google account without an API key: text runs, multi-turn chat, file/YouTube attachments, JSON schema, image generation, TTS speech, Build zip export, and local usage tracking.
---

# aistudio

Drives `https://aistudio.google.com` via `ego-browser` and prints one JSON object to stdout (diagnostics go to stderr). State and model caches live under standard XDG directories (`~/.local/state/ezgoogleone/aistudio` and `~/.cache/ezgoogleone/aistudio`).

## Commands

```bash
aistudio check
aistudio models [--refresh]
aistudio run --model gemini-4-neon --prompt-file prompt.md [--system-file sys.md] \
  [--thinking high] [--max-out 65536] [--attach a.pdf b.zip] [--youtube <url>] \
  [--tools search,url,code] [--schema schema.json] --out answer.md
aistudio send --chat <url|id> --prompt "follow-up" --out answer2.md
aistudio get --chat <url|id> [--turn last|<n>] --out answer.md
aistudio image --model gemini-nano-banana-2.1 --prompt "..." [--attach ref.png] \
  [--size 2K] [--aspect 16:9] --out-dir imgs/
aistudio speech --text "Hello world." [--voice Kira] --out voice.wav
aistudio build-export --app https://aistudio.google.com/apps/<id> --out-dir export/
aistudio usage [--days 7]
aistudio close [--space <name>]
```

- Pass `--space <name>` for parallel lanes (one driver per space; downloads serialize automatically across spaces).
- `--system-file` writes only to the driver-owned stored instruction `aistudio-driver` (`aistudio-driver:<space>`) and verifies non-driver instructions remain untouched.
- `build-export` only downloads the `.zip` archive and unpacks it with zip-slip path checks; it never pushes to GitHub or deploys.
- Run `aistudio close` when finished to release idle TaskSpaces.

## Exit codes

| Exit | Meaning | Action |
| --- | --- | --- |
| `0` | Success | Read `--out` / `--out-dir` |
| `1` | Runtime failure, timeout, busy space, or DOM/network mismatch | Read `error` and `next` |
| `2` | Bad arguments or unsupported model/thinking/voice | Fix flags from `next` |
| `3` | AI Studio DOM changed | Run `aistudio check` and update selectors |
| `4` | Quota/rate limit reached (or HTTP 429) | Check `aistudio usage` and switch model or wait |
| `5` | Blocked by safety or recitation | Rephrase prompt |
| `6` | Truncated at max output tokens | Raise `--max-out` |
| `7` | Needs user (sign-in, permission prompt, user-held space) | Stop and ask the user to act in `ego-browser` |
