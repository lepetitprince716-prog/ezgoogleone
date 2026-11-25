---
name: gemini-web
description: Drive Gemini Web (gemini.google.com/app) through ego-browser for chat and Deep Research reports on a signed-in Google account, without an API key.
---

# gemini-web

Drives `https://gemini.google.com/app` via `ego-browser` and prints one JSON result object to stdout (diagnostics go to stderr).

## Commands

```bash
gemini-web check
gemini-web verify-lock --model neon --thinking high [--deep-research]
gemini-web chat --model neon --thinking high --prompt-file prompt.md --out reply.md
gemini-web deep-research start --model neon --thinking high --prompt-file prompt.md
gemini-web deep-research check --space-id <id> --out report.md [--reload] [--keep]
gemini-web close [--space <name>]
```

- `--model` accepts shortcuts (`neon`, `carbon`, `argon`, `hydrogen`, `pro`, `fast`, `thinking`) or any exact label shown in Gemini Web's mode picker (for example `--model "2.5 Pro"`).
- Deep Research runs typically take 4–10 minutes. Start with `deep-research start`, wait asynchronously (do not poll in a tight loop), then harvest Markdown with `deep-research check`.
- Use `--space <name>` to run independent sessions without colliding on the default `gemini-web` space.

## Exit codes

| Exit | Meaning | Action |
| --- | --- | --- |
| `0` | Success (or `status: "running"` for Deep Research) | Read `--out` or check later |
| `1` | Runtime/timeout/busy-space error | Read `error` and `next` |
| `2` | Invalid arguments or model/thinking option not offered | Fix flags from `next` |
| `3` | Gemini Web DOM changed | Run `gemini-web check` and update selectors |
| `7` | Needs user (sign-in, CAPTCHA, user-held space) | Stop and ask the user to act in `ego-browser` |
