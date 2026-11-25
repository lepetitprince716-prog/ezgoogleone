# google-agent-kit

[中文文档](README.zh-CN.md)

A universal, agent-agnostic CLI toolkit and portable skill pack for driving **Google's AI ecosystem** from any terminal or coding agent (Claude Code, Codex, OpenCode, Pi, Cursor, Antigravity, or plain shell):

1. **`gemini-web`** — Drives **Gemini Web** (`gemini.google.com/app`) via `ego-browser`: standard chat and asynchronous Deep Research report harvesting with model + thinking-level lock verification.
2. **`aistudio`** — Drives **Google AI Studio** (`aistudio.google.com`) via `ego-browser` using your signed-in Google subscription (no API key): 1M-context chat (`run`/`send`/`get`), file & YouTube attachments, JSON Schema structured output, image generation/editing, TTS `.wav` synthesis, Build `.zip` export, parallel spaces, and a local usage ledger.
3. **`gemini-api`** — Zero-dependency Python stdlib CLI for the official **Gemini REST API** and **Gemini Decisions API** (`gemini-decision-1` calibrated `noul` / `choice` / `score`), multimodal context, Google Search grounding, and parallel JSON batches.
4. **`colab-kit`** — Thin wrapper over `google-colab-cli` that handles non-interactive `--auth=adc` ordering, environment diagnostics, and optional directory safety boundaries for Google Colab GPU/TPU sessions.

> [!NOTE]
> **Two distinct tiers inside one repo:**
> - **Official API / Cloud CLI (`gemini-api`, `colab-kit`)**: backed by standard `GEMINI_API_KEY` or `gcloud` Application Default Credentials. Suitable for headless automation and CI.
> - **Browser-Driven Web Wrappers (`gemini-web`, `aistudio`)**: experimental drivers operating your own signed-in `ego-browser` session. They never read or type passwords and stop with exit code `7` whenever sign-in or human confirmation is needed. Upstream Google web UI changes can break DOM selectors; run `check` before batch runs and respect Google's Terms of Service and rate limits.

---

## Which Module Should I Use?

| Task | Module | Auth / Dependencies | Output Contract |
| --- | --- | --- | --- |
| Gemini Web chat or 4–10 min Deep Research reports | `gemini-web` | `bun` + `ego-browser` (signed-in) | Single JSON line on stdout + `.md` report |
| AI Studio Playground (1M context, files/YouTube, schema, images, TTS, Build `.zip`) | `aistudio` | `bun` + `ego-browser` (signed-in) | Single JSON line on stdout + saved artifacts + local usage ledger |
| Headless generation, Search grounding, JSON Schema, calibrated decisions, batches | `gemini-api` | `python3` + `GEMINI_API_KEY` | Response text/JSON on stdout + metadata JSON on stderr |
| Cloud GPU/TPU training or evaluation (`A100`, `L4`, `T4`, `H100`) | `colab-kit` | `python3` + `google-colab-cli` + `gcloud` ADC | Direct `colab` output + `doctor` JSON |

---

## Quick Start

### 1. Clone and put `bin/` on `PATH`

```bash
git clone https://github.com/lepetitprince716-prog/google-agent-kit.git
cd google-agent-kit
export PATH="$PWD/bin:$PATH"
```

Or symlink individual binaries into `~/.local/bin/`:

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/"{google-agent-kit,gemini-web,aistudio,gemini-api,colab-kit} ~/.local/bin/
```

### 2. Check prerequisites

```bash
google-agent-kit doctor
```

Install only what you need:
- For `gemini-web` and `aistudio`: [Bun](https://bun.sh) (`>= 1.1`) and `ego-browser` signed into your Google account.
- For `gemini-api`: Python `>= 3.10` and `export GEMINI_API_KEY=...` (or `~/.config/gemini-api/api_key`). Zero third-party Python packages required.
- For `colab-kit`: Python `>= 3.10`, `google-colab-cli` (`uv tool install google-colab-cli`), and `gcloud auth application-default login`.

### 3. Install portable skills for your coding agent (optional)

```bash
# Default (~/.agents/skills)
google-agent-kit install-skills

# Or target specific harnesses (Claude Code, Codex, Antigravity/Gemini, OpenCode, or custom dir)
google-agent-kit install-skills --claude --codex
google-agent-kit install-skills --target /path/to/your/skills --copy
```

---

## Usage Examples

### `gemini-web` (`gemini.google.com/app`)

```bash
# Verify sign-in and UI selectors without spending quota
gemini-web check
gemini-web verify-lock --model neon --thinking high --deep-research

# Standard Gemini Web chat (supports aliases or any exact picker label like "2.5 Pro")
gemini-web chat --model neon --thinking high --prompt-file prompt.md --out reply.md

# Asynchronous Deep Research workflow (4–10 min typical runtime)
gemini-web deep-research start --model neon --thinking high --prompt-file topic.md
# ... wait asynchronously, then harvest structured Markdown:
gemini-web deep-research check --space-id 42 --out report.md

# Close idle browser TaskSpaces
gemini-web close
```

### `aistudio` (`aistudio.google.com`)

```bash
# Canary check and cached model catalog
aistudio check
aistudio models --refresh

# Long-context run with file/YouTube attachments, tools, and JSON schema
aistudio run --model gemini-4-neon --thinking high --prompt-file prompt.md \
  --attach repo.zip spec.pdf --youtube https://youtu.be/dQw4w9WgXcQ \
  --tools search,code --schema schema.json --out answer.md

# Follow-up in the same chat or re-read a saved turn
aistudio send --chat https://aistudio.google.com/prompts/<id> --prompt "Tighten section 2" --out answer2.md
aistudio get --chat <id> --turn last --out answer.md

# Image generation / editing, TTS synthesis, and Build .zip export
aistudio image --model gemini-nano-banana-2.1 --prompt "Isometric technical diagram" --size 2K --aspect 16:9 --out-dir imgs/
aistudio speech --text "Hello from AI Studio." --voice Kira --out voice.wav
aistudio build-export --app https://aistudio.google.com/apps/<id> --out-dir exported-app/

# Inspect local per-model usage ledger and close idle TaskSpaces
aistudio usage --days 7
aistudio close
```

Run multiple `aistudio` or `gemini-web` lanes concurrently by assigning distinct `--space <name>` values; locks and browser-wide downloads serialize automatically.

### `gemini-api` (REST & Decisions API)

```bash
# Headless generation with Search grounding and multimodal context
gemini-api -m neon --thinking high --search --context notes.md --image chart.png -p "Audit these numbers" -o review.md

# Calibrated decisions via gemini-decision-1 (yes/no, multi-choice, rubric score)
gemini-api --decision-noul "Does this patch change any public CLI flag?" --context patch.diff
gemini-api --decision "bug=defect" "feat=new feature" "chore=maintenance" -p "Fix lock race"
gemini-api --decision-score "low" "medium" "high" -p "Rate clarity" --decision-cache cache.jsonl

# Parallel batch runner
gemini-api --batch jobs.json --workers 4
```

### `colab-kit` (Google Colab GPU/TPU)

```bash
colab-kit doctor
colab-kit usage
colab-kit sessions

# One-shot execution (releases runtime automatically on exit or failure)
colab-kit run --gpu A100 --high-mem train.py

# Persistent session workflow
colab-kit new -s eval1 --gpu L4
colab-kit upload -s eval1 ./dataset.tar /content/dataset.tar
colab-kit exec -s eval1 -f eval.py
colab-kit download -s eval1 /content/metrics.json ./metrics.json
colab-kit stop -s eval1
```

---

## Architecture & Conventions

- **Clean CLI contract**: `aistudio` and `gemini-web` emit exactly one machine-parseable JSON object on `stdout` and send progress/diagnostics to `stderr`. Consistent exit codes (`0` ok, `1` runtime/busy, `2` usage/invalid option, `3` DOM changed, `4` quota/429, `5` safety/recitation block, `6` max-tokens truncation, `7` needs user sign-in/action).
- **XDG state isolation**: Mutable locks, space registries, cancel files, usage ledgers, and model caches live under `$XDG_STATE_HOME/google-agent-kit/` (`~/.local/state/google-agent-kit/`) and `$XDG_CACHE_HOME/google-agent-kit/` (`~/.cache/google-agent-kit/`) — never inside the git repository.
- **Cross-platform locks**: Uses macOS `O_EXLOCK` kernel locks on Darwin and atomic `O_CREAT|O_EXCL` PID-verified locks on Linux.
- **Optional path guardrails**: Set `GEMINI_API_DENY_DIRS` or `COLAB_KIT_DENY_DIRS` (comma-separated directory names, e.g., `private,secrets`) to block accidental reads/uploads from restricted folders.
- **Privacy & secret scanning**: Enable local hooks once per clone with `git config core.hooksPath .githooks`. See [PRIVACY.md](PRIVACY.md).

---

## Development & Tests

```bash
bun test packages/aistudio/tests packages/gemini-web/tests
python3 -m unittest discover -s packages/gemini-api/tests -v
python3 -m unittest discover -s packages/colab/tests -v
python3 -m unittest discover -s tests -v
```

## License

[Apache-2.0](LICENSE)
