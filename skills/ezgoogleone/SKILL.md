---
name: ezgoogleone
description: Route tasks across Google AI tools outside Antigravity: Gemini Web (chat + Deep Research), Google AI Studio Web (long-context, structured output, images, TTS, Build export), Gemini REST & Decisions API, and Google Colab GPU/TPU.
---

# ezgoogleone

Run `ezgoogleone doctor` first to see which modules are ready on this machine.

## Choosing a tool

| Need | Tool | Auth / Runtime |
| --- | --- | --- |
| Gemini Web chat or 4–10 min Deep Research (`gemini.google.com/app`) | `gemini-web` | `bun` + signed-in `ego-browser` |
| AI Studio Playground: 1M context, files/YouTube, JSON schema, image gen, TTS, Build `.zip` export (`aistudio.google.com`) | `aistudio` | `bun` + signed-in `ego-browser` |
| Headless API generation, Google Search grounding, batch jobs, or `gemini-decision-1` calibrated yes/no/choice/score | `gemini-api` | `python3` + `GEMINI_API_KEY` |
| Cloud GPU/TPU training or evaluation on Google Colab (`A100`, `L4`, `T4`, `H100`) | `colab-kit` | `python3` + `colab` + `gcloud` ADC |

## Shared rules

- Never send secrets, `.env` files, API keys, or private credentials to web UIs or third-party cloud runtimes.
- Browser drivers (`gemini-web`, `aistudio`) never type passwords; on exit code `7`, stop and ask the user to sign in or resolve the prompt inside `ego-browser`.
- Close idle browser TaskSpaces (`gemini-web close`, `aistudio close`) and stop Colab sessions (`colab-kit stop`) when done.
