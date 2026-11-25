---
name: gemini-api
description: Call the Gemini REST API and Gemini Decisions API (gemini-decision-1) via a zero-dependency Python stdlib CLI using GEMINI_API_KEY.
---

# gemini-api

Zero-dependency Python CLI for headless text generation, multimodal context, Google Search grounding, JSON Schema output, calibrated decisions (`noul`, `choice`, `score`), and parallel JSON batches.

## Auth

Set `GEMINI_API_KEY` in the environment, or place the key in `~/.config/gemini-api/api_key` (or pass `--key-file`).

## Commands

```bash
# Text / reasoning with optional context, images, and search grounding
gemini-api -m neon --thinking high --search --context doc.md --image chart.png -p "Summarize findings" -o out.md

# Structured JSON output
gemini-api -m hydrogen --schema schema.json -p "Extract entities" -o entities.json

# Calibrated decisions (gemini-decision-1)
gemini-api --decision-noul "Does this diff introduce a breaking API change?" --context diff.patch
gemini-api --decision "bug=defect in logic" "feature=new capability" "docs=documentation only" -p "Fix off-by-one"
gemini-api --decision-score "poor" "acceptable" "strong" -p "Review clarity" --decision-cache cache.jsonl

# Parallel batch runner
gemini-api --batch jobs.json --workers 4
```

Set `GEMINI_API_DENY_DIRS=private,secrets` to fail closed before reading files under restricted directory names.
