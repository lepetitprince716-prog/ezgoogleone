#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

API_BASE = "https://generativelanguage.googleapis.com/v1beta"
DECISION_URL = f"{API_BASE}/decisions"
DEFAULT_KEY_FILE = Path.home() / ".config" / "gemini-api" / "api_key"
RETRYABLE_HTTP = frozenset({429, 500, 502, 503, 504})
SAFETY_CODES = frozenset({"safety", "prohibited_content", "blocklist", "image_safety", "content_blocked"})
QUESTION_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

MODEL_ALIASES: dict[str, str] = {
    "carbon": "gemini-4-carbon",
    "argon": "gemini-4-argon",
    "neon": "gemini-4-neon",
    "hydrogen": "gemini-4-hydrogen",
    "flash": "gemini-3.8-flash",
    "decision": "gemini-decision-1",
}

THINKING_LEVELS: dict[str, str] = {
    "minimal": "MINIMAL",
    "low": "LOW",
    "medium": "MEDIUM",
    "high": "HIGH",
}


class ApiError(RuntimeError):
    pass


class PathBoundaryError(ValueError):
    pass


class SafetyBlockError(ApiError):
    pass


def resolve_model(name: str) -> str:
    key = name.strip().lower()
    return MODEL_ALIASES.get(key, name.strip())


def resolve_api_key(key_file: Path | None = None) -> str:
    env_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if env_key:
        return env_key
    kf = key_file or DEFAULT_KEY_FILE
    if kf.is_file():
        val = kf.read_text(encoding="utf-8").strip()
        if val:
            return val
    raise ApiError(f"No Gemini API key found in GEMINI_API_KEY or {kf}")


def denied_dir_names() -> set[str]:
    raw = os.environ.get("GEMINI_API_DENY_DIRS", "")
    return {p.strip().lower() for p in raw.split(",") if p.strip()}


def check_file_path(path: Path | str, deny_dirs: set[str] | None = None) -> Path:
    resolved = Path(path).expanduser().resolve()
    blocked = deny_dirs if deny_dirs is not None else denied_dir_names()
    if blocked:
        parts = {part.lower() for part in resolved.parts}
        hit = blocked & parts
        if hit:
            raise PathBoundaryError(f"Refusing to read denied path segment {sorted(hit)}: {resolved}")
    if not resolved.is_file():
        raise FileNotFoundError(f"File not found: {resolved}")
    return resolved


def guess_mime(path: Path, default: str = "application/octet-stream") -> str:
    mime, _ = mimetypes.guess_type(str(path))
    if mime:
        return mime
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".wav": "audio/wav",
        ".mp4": "video/mp4",
    }.get(path.suffix.lower(), default)


def post_json(
    url: str,
    payload: dict[str, Any],
    api_key: str,
    timeout_s: float = 300.0,
    max_retries: int = 3,
) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
    last_err: Exception | None = None
    for attempt in range(max_retries):
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_text = ""
            try:
                err_text = e.read().decode("utf-8", errors="replace")[:800]
            except Exception:
                pass
            if e.code == 400 and any(tok in err_text.lower() for tok in SAFETY_CODES):
                raise SafetyBlockError(f"Gemini API safety block (HTTP 400): {err_text}") from e
            if e.code in RETRYABLE_HTTP and attempt + 1 < max_retries:
                time.sleep(min(30.0, 2.0 * (2**attempt)))
                last_err = ApiError(f"HTTP {e.code}: {err_text}")
                continue
            raise ApiError(f"Gemini API HTTP {e.code}: {err_text}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt + 1 < max_retries:
                time.sleep(min(20.0, 2.0 * (2**attempt)))
                last_err = e
                continue
            raise ApiError(f"Gemini API transport error: {e}") from e
    raise ApiError(f"Gemini API request failed after retries: {last_err}")


def build_parts(
    prompt: str,
    context_files: list[Path] | None = None,
    image_files: list[Path] | None = None,
    max_context_chars: int = 200_000,
) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    for raw_ctx in context_files or []:
        p = check_file_path(raw_ctx)
        text = p.read_text(encoding="utf-8", errors="replace")
        if len(text) > max_context_chars:
            text = text[:max_context_chars] + f"\n\n[TRUNCATED at {max_context_chars} chars]"
        parts.append({"text": f"=== CONTEXT FILE: {p.name} ===\n{text}\n=== END FILE ==="})

    for raw_img in image_files or []:
        p = check_file_path(raw_img)
        mime = guess_mime(p, default="image/png")
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        parts.append({"text": f"[Image: {p.name}]"})
        parts.append({"inlineData": {"mimeType": mime, "data": b64}})

    parts.append({"text": prompt})
    return parts


def extract_grounding_sources(resp: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for cand in resp.get("candidates", []):
        gm = cand.get("groundingMetadata") or {}
        for chunk in gm.get("groundingChunks") or []:
            web = chunk.get("web") or {}
            uri = str(web.get("uri") or "").strip()
            title = str(web.get("title") or "").strip()
            if uri and uri not in seen:
                seen.add(uri)
                out.append({"title": title, "uri": uri})
    return out


def run_generate(
    *,
    prompt: str,
    model: str = "neon",
    system: str | None = None,
    thinking: str | None = "high",
    include_thoughts: bool = False,
    search: bool = False,
    json_mode: bool = False,
    schema: dict[str, Any] | None = None,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
    context_files: list[Path] | None = None,
    image_files: list[Path] | None = None,
    timeout_s: float = 360.0,
    api_key: str | None = None,
) -> dict[str, Any]:
    key = api_key or resolve_api_key()
    model_id = resolve_model(model)
    parts = build_parts(prompt, context_files=context_files, image_files=image_files)

    gen_cfg: dict[str, Any] = {}
    if temperature is not None:
        gen_cfg["temperature"] = temperature
    if max_output_tokens is not None:
        gen_cfg["maxOutputTokens"] = max_output_tokens
    if thinking:
        lvl = THINKING_LEVELS.get(thinking.strip().lower(), thinking.strip().upper())
        tcfg: dict[str, Any] = {"thinkingLevel": lvl}
        if include_thoughts:
            tcfg["includeThoughts"] = True
        gen_cfg["thinkingConfig"] = tcfg
    if json_mode or schema is not None:
        gen_cfg["responseMimeType"] = "application/json"
        if schema is not None:
            gen_cfg["responseSchema"] = schema

    payload: dict[str, Any] = {"contents": [{"role": "user", "parts": parts}]}
    if gen_cfg:
        payload["generationConfig"] = gen_cfg
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    if search:
        payload["tools"] = [{"google_search": {}}]

    url = f"{API_BASE}/models/{model_id}:generateContent"
    t0 = time.monotonic()
    resp = post_json(url, payload, api_key=key, timeout_s=timeout_s)
    dt = round(time.monotonic() - t0, 2)

    cands = resp.get("candidates") or []
    if not cands:
        raise ApiError(f"Empty candidates from {model_id}: {json.dumps(resp)[:500]}")

    cand = cands[0]
    text_chunks: list[str] = []
    thought_chunks: list[str] = []
    for part in (cand.get("content") or {}).get("parts") or []:
        if part.get("thought") is True:
            thought_chunks.append(part.get("text", ""))
        elif "text" in part:
            text_chunks.append(part["text"])

    usage = resp.get("usageMetadata") or {}
    return {
        "model": model_id,
        "latency_s": dt,
        "finish_reason": cand.get("finishReason"),
        "usage": {
            "prompt_tokens": usage.get("promptTokenCount"),
            "thoughts_tokens": usage.get("thoughtsTokenCount"),
            "output_tokens": usage.get("candidatesTokenCount"),
            "total_tokens": usage.get("totalTokenCount"),
        },
        "grounding_sources": extract_grounding_sources(resp),
        "thoughts": "".join(thought_chunks),
        "text": "".join(text_chunks),
    }


def validate_questions(questions: dict[str, dict[str, Any]]) -> None:
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions must be a non-empty object")
    if len(questions) > 1000:
        raise ValueError("questions count exceeds 1000")
    for key, spec in questions.items():
        if not QUESTION_KEY_RE.match(key):
            raise ValueError(f"invalid question key: {key!r}")
        qtype = spec.get("type")
        if qtype not in ("noul", "choice", "score"):
            raise ValueError(f"invalid question type for {key!r}: {qtype!r}")
        if not str(spec.get("instructions") or "").strip():
            raise ValueError(f"question {key!r} requires instructions")
        if qtype == "choice":
            c = spec.get("criteria")
            if not isinstance(c, dict) or len(c) < 2:
                raise ValueError(f"choice question {key!r} requires >=2 criteria options")
        elif qtype == "score":
            c = spec.get("criteria")
            if not isinstance(c, list) or len(c) < 2:
                raise ValueError(f"score question {key!r} requires >=2 criteria levels")


def _decision_cache_key(model_id: str, input_data: Any, questions: dict[str, Any]) -> str:
    blob = json.dumps({"model": model_id, "input": input_data, "questions": questions}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _read_cache(cache_path: Path, digest: str) -> dict[str, Any] | None:
    if not cache_path.is_file():
        return None
    for line in cache_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if row.get("key") == digest and isinstance(row.get("response"), dict):
                return row["response"]
        except json.JSONDecodeError:
            continue
    return None


def _write_cache(cache_path: Path, digest: str, response: dict[str, Any]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with cache_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"key": digest, "response": response}, ensure_ascii=False) + "\n")


def run_decision(
    *,
    prompt: str | None = None,
    choices: list[str] | None = None,
    scores: list[str] | None = None,
    noul_question: str | None = None,
    questions: dict[str, dict[str, Any]] | None = None,
    instruction: str | None = None,
    context_files: list[Path] | None = None,
    image_files: list[Path] | None = None,
    resolution: str = "low",
    model: str = "decision",
    api_key: str | None = None,
    timeout_s: float = 30.0,
    cache_path: Path | None = None,
) -> dict[str, Any]:
    key = api_key or resolve_api_key()
    model_id = resolve_model(model)

    if not context_files and not image_files:
        if not prompt or not prompt.strip():
            raise ValueError("decision input requires prompt, context_files, or image_files")
        input_data: Any = prompt
    else:
        blocks: list[dict[str, Any]] = []
        for raw_ctx in context_files or []:
            p = check_file_path(raw_ctx)
            blocks.append({"type": "text", "text": f"=== CONTEXT FILE: {p.name} ===\n{p.read_text(encoding='utf-8', errors='replace')}\n=== END FILE ===\n"})
        for raw_img in image_files or []:
            p = check_file_path(raw_img)
            blocks.append({"type": "text", "text": f"[Image: {p.name}]\n"})
            blocks.append({
                "type": "image",
                "data": base64.b64encode(p.read_bytes()).decode("ascii"),
                "mime_type": guess_mime(p, default="image/png"),
                "resolution": resolution,
            })
        if prompt and prompt.strip():
            blocks.append({"type": "text", "text": prompt})
        input_data = blocks

    if questions is not None:
        qmap = questions
    elif noul_question:
        qmap = {"answer": {"type": "noul", "instructions": noul_question}}
    elif choices:
        criteria: dict[str, str] = {}
        for item in choices:
            if "=" in item:
                k, desc = item.split("=", 1)
                criteria[k.strip()] = desc.strip()
            else:
                criteria[item.strip()] = ""
        qmap = {"choice": {"type": "choice", "instructions": instruction or "Select the single best matching option.", "criteria": criteria}}
    elif scores:
        qmap = {"score": {"type": "score", "instructions": instruction or "Rate the input on the given scale.", "criteria": scores}}
    else:
        raise ValueError("run_decision requires --decision, --decision-noul, --decision-score, or --decision-questions")

    validate_questions(qmap)
    digest = _decision_cache_key(model_id, input_data, qmap)
    if cache_path:
        cached = _read_cache(cache_path, digest)
        if cached is not None:
            return {**cached, "cached": True, "latency_s": 0.0}

    t0 = time.monotonic()
    resp = post_json(DECISION_URL, {"model": model_id, "input": input_data, "questions": qmap}, api_key=key, timeout_s=timeout_s)
    dt = round(time.monotonic() - t0, 3)

    if resp.get("error"):
        err = resp["error"]
        code = str(err.get("code") or "").lower()
        msg = str(err.get("message") or err)
        if code in SAFETY_CODES:
            raise SafetyBlockError(f"Decision safety block ({code}): {msg}")
        raise ApiError(f"Decision API error ({code}): {msg}")

    out = {"model": model_id, "cached": False, "latency_s": dt, "answers": resp.get("answers") or resp, "usage": resp.get("usage") or {}}
    if cache_path:
        _write_cache(cache_path, digest, out)
    return out


def run_batch(jobs_path: Path, workers: int = 4, api_key: str | None = None) -> list[dict[str, Any]]:
    raw = json.loads(check_file_path(jobs_path).read_text(encoding="utf-8"))
    jobs = raw if isinstance(raw, list) else raw.get("jobs", [])
    key = api_key or resolve_api_key()

    def _exec(job: dict[str, Any]) -> dict[str, Any]:
        jid = str(job.get("id") or "job")
        try:
            prompt_text = job.get("prompt")
            if not prompt_text and job.get("prompt_file"):
                prompt_text = check_file_path(Path(job["prompt_file"])).read_text(encoding="utf-8")
            if str(job.get("mode") or "").lower() == "decision" or job.get("questions") or job.get("choices") or job.get("scores"):
                res = run_decision(
                    prompt=prompt_text,
                    choices=job.get("choices"),
                    scores=job.get("scores"),
                    questions=job.get("questions"),
                    noul_question=job.get("noul_question"),
                    instruction=job.get("instruction"),
                    context_files=[Path(p) for p in (job.get("context") or [])],
                    image_files=[Path(p) for p in (job.get("images") or [])],
                    resolution=str(job.get("resolution") or "low"),
                    model=str(job.get("model") or "decision"),
                    timeout_s=float(job.get("timeout_s", 30.0)),
                    api_key=key,
                )
                out_path = job.get("out")
                if out_path:
                    dst = Path(out_path)
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    dst.write_text(json.dumps(res, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                return {"id": jid, "ok": True, "model": res["model"], "latency_s": res["latency_s"], "answers": res["answers"], "out": str(out_path) if out_path else None}

            if not isinstance(prompt_text, str) or not prompt_text.strip():
                raise ValueError(f"job {jid} missing prompt")
            schema_obj = job.get("schema")
            if isinstance(schema_obj, str):
                schema_obj = json.loads(check_file_path(Path(schema_obj)).read_text(encoding="utf-8"))
            res = run_generate(
                prompt=prompt_text,
                model=str(job.get("model") or "neon"),
                system=job.get("system"),
                thinking=job.get("thinking", "high"),
                include_thoughts=bool(job.get("include_thoughts", False)),
                search=bool(job.get("search", False)),
                json_mode=bool(job.get("json", False)),
                schema=schema_obj,
                temperature=job.get("temperature"),
                max_output_tokens=job.get("max_output_tokens"),
                context_files=[Path(p) for p in (job.get("context") or [])],
                image_files=[Path(p) for p in (job.get("images") or [])],
                timeout_s=float(job.get("timeout_s", 360.0)),
                api_key=key,
            )
            out_path = job.get("out")
            if out_path:
                dst = Path(out_path)
                dst.parent.mkdir(parents=True, exist_ok=True)
                content = res["text"]
                if res["grounding_sources"] and not job.get("json"):
                    src_lines = ["\n\n---\n## Grounding Sources"] + [f"- [{s['title'] or s['uri']}]({s['uri']})" for s in res["grounding_sources"]]
                    content = content.rstrip() + "\n" + "\n".join(src_lines) + "\n"
                dst.write_text(content, encoding="utf-8")
            return {"id": jid, "ok": True, "model": res["model"], "latency_s": res["latency_s"], "usage": res["usage"], "out": str(out_path) if out_path else None, "chars": len(res["text"])}
        except Exception as e:
            return {"id": jid, "ok": False, "error": str(e)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        return [f.result() for f in [ex.submit(_exec, job) for job in jobs]]


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Zero-dependency Gemini API & Decisions CLI")
    ap.add_argument("-m", "--model", default=None, help="Model alias (carbon|argon|neon|hydrogen|flash|decision) or full model id")
    ap.add_argument("-p", "--prompt", help="Prompt text")
    ap.add_argument("--prompt-file", type=Path, help="Read prompt from file")
    ap.add_argument("--system", help="System instruction text")
    ap.add_argument("--system-file", type=Path, help="Read system instruction from file")
    ap.add_argument("--thinking", default="high", help="Thinking level: minimal|low|medium|high|none")
    ap.add_argument("--include-thoughts", action="store_true")
    ap.add_argument("--search", action="store_true", help="Enable Google Search grounding")
    ap.add_argument("--json", action="store_true", help="Request application/json output")
    ap.add_argument("--schema", type=Path, help="JSON Schema file for structured output")
    ap.add_argument("--temperature", type=float, default=None)
    ap.add_argument("--max-output-tokens", type=int, default=None)
    ap.add_argument("--context", nargs="*", type=Path, default=[])
    ap.add_argument("--image", nargs="*", type=Path, default=[])
    ap.add_argument("--key-file", type=Path, default=None)
    ap.add_argument("--timeout", type=float, default=360.0)
    ap.add_argument("-o", "--out", type=Path, help="Write response text or decision JSON to file")
    ap.add_argument("--meta-out", type=Path, help="Write metadata JSON to file")
    ap.add_argument("--decision", nargs="+", help="Choice mode labels (supports key=description)")
    ap.add_argument("--decision-noul", help="Binary yes/no decision instruction")
    ap.add_argument("--decision-score", nargs="+", help="Rubric score mode levels")
    ap.add_argument("--decision-questions", type=Path, help="JSON file containing a questions map")
    ap.add_argument("--decision-instruction", help="Instruction for --decision / --decision-score")
    ap.add_argument("--resolution", choices=["low", "medium", "high", "ultra_high"], default="low")
    ap.add_argument("--decision-cache", type=Path, help="Optional JSONL cache file")
    ap.add_argument("--batch", type=Path, help="Run a JSON file of parallel jobs")
    ap.add_argument("--workers", type=int, default=4)
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    key = resolve_api_key(args.key_file)

    if args.batch:
        results = run_batch(args.batch, workers=args.workers, api_key=key)
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return 0 if all(r.get("ok") for r in results) else 1

    prompt = args.prompt
    if args.prompt_file:
        prompt = check_file_path(args.prompt_file).read_text(encoding="utf-8")
    if not prompt and not sys.stdin.isatty():
        prompt = sys.stdin.read()

    dec_modes = sum(bool(x) for x in (args.decision, args.decision_noul, args.decision_score, args.decision_questions))
    if dec_modes > 1:
        raise SystemExit("Provide only one of --decision, --decision-noul, --decision-score, or --decision-questions")

    if dec_modes == 1:
        qmap = json.loads(check_file_path(args.decision_questions).read_text(encoding="utf-8")) if args.decision_questions else None
        res = run_decision(
            prompt=prompt,
            choices=args.decision,
            scores=args.decision_score,
            questions=qmap,
            noul_question=args.decision_noul,
            instruction=args.decision_instruction,
            context_files=args.context,
            image_files=args.image,
            resolution=args.resolution,
            model=args.model or "decision",
            api_key=key,
            timeout_s=min(args.timeout, 60.0),
            cache_path=args.decision_cache,
        )
        out_text = json.dumps(res, indent=2, ensure_ascii=False)
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(out_text + "\n", encoding="utf-8")
        print(out_text)
        return 0

    if not prompt or not prompt.strip():
        raise SystemExit("Provide --prompt, --prompt-file, stdin, or --batch")

    system = check_file_path(args.system_file).read_text(encoding="utf-8") if args.system_file else args.system
    schema_obj = json.loads(check_file_path(args.schema).read_text(encoding="utf-8")) if args.schema else None
    thinking = None if (args.thinking or "").lower() in ("none", "off", "") else args.thinking

    res = run_generate(
        prompt=prompt,
        model=args.model or "neon",
        system=system,
        thinking=thinking,
        include_thoughts=args.include_thoughts,
        search=args.search,
        json_mode=args.json,
        schema=schema_obj,
        temperature=args.temperature,
        max_output_tokens=args.max_output_tokens,
        context_files=args.context,
        image_files=args.image,
        timeout_s=args.timeout,
        api_key=key,
    )

    content = res["text"]
    if res["grounding_sources"] and not (args.json or schema_obj):
        src_lines = ["\n\n---\n## Grounding Sources"] + [f"- [{s['title'] or s['uri']}]({s['uri']})" for s in res["grounding_sources"]]
        content = content.rstrip() + "\n" + "\n".join(src_lines) + "\n"

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(content, encoding="utf-8")
    else:
        sys.stdout.write(content)
        if not content.endswith("\n"):
            sys.stdout.write("\n")

    meta = {k: v for k, v in res.items() if k not in ("text", "thoughts")}
    if args.meta_out:
        args.meta_out.parent.mkdir(parents=True, exist_ok=True)
        args.meta_out.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
