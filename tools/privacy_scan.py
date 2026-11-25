#!/usr/bin/env python3
"""Privacy guard for a public repository, implemented with only the stdlib.

It looks for personal data -- LAN addresses, home paths, emails, credentials,
sensitive file/ref names and image-generation metadata -- in staged files,
unstaged changes, untracked files, tracked files, git history (all refs, one
candidate commit, or a commit range), a commit message or any path, and checks
that the configured git identity is a noreply address.

A finding is reported as ``location: rule_id -- why``; the matched value is never
printed, and any path or ref name that matches a rule is replaced with a stable
redacted alias before output. Exit status: 0 clean, 1 findings, 2 usage or
internal error. The guard fails closed: a file it cannot read or decode, an
unscanned submodule, a Git LFS pointer, or active git replace refs are findings
or errors, never a pass.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import zlib
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, NamedTuple

EXIT_CLEAN, EXIT_FINDINGS, EXIT_ERROR = 0, 1, 2

PUBLIC_RULES = Path(__file__).resolve().with_name("privacy_rules.json")
PRIVATE_RULES_ENV = "AGENT_GENOPS_PRIVATE_RULES"
REQUIRE_PRIVATE_ENV = "AGENT_GENOPS_REQUIRE_PRIVATE"
MAINTAINER_MODE_CONFIG_KEY = "genops.mode"
MAINTAINER_MODE_VALUE = "maintainer"
CONTRIBUTOR_MODE_VALUE = "contributor"

DOCUMENT_LISTS = (
    "rules",
    "allow_literals",
    "allow_patterns",
    "allowed_emails",
    "allowed_binary_suffixes",
)
DOCUMENT_KEYS = frozenset({"version", "note", *DOCUMENT_LISTS})  # "note" is free text, ignored
RULE_REQUIRED = frozenset({"id", "pattern", "why"})
RULE_KEYS = RULE_REQUIRED | {"flags", "suffixes"}
FLAG_BITS = {"i": re.IGNORECASE}

SHORT_SHA = 12
OBJECT_ID = re.compile(rb"[0-9a-f]{40}|[0-9a-f]{64}")
IDENT_FIELDS = ("author", "committer", "tagger")
IDENT_EMAIL = re.compile(r"<([^<>]*)>$")

CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_TEXT_CHUNKS = (b"tEXt", b"zTXt", b"iTXt")
PNG_PIXEL_CHUNKS = (b"IDAT", b"fdAT")
GENERATION_KEYS = frozenset({"prompt", "workflow", "parameters", "comment", "description"})
MAX_INFLATED = 64 * 1024 * 1024

LFS_HEADER = b"version https://git-lfs.github.com/spec/v1"

# The head each allowed image suffix must start with: alternatives of (offset, bytes) pairs, from
# the format specifications (PNG, JPEG SOI marker, GIF87a/GIF89a, RIFF....WEBP, ICO).
IMAGE_SIGNATURES: dict[str, tuple[tuple[tuple[int, bytes], ...], ...]] = {
    ".png": (((0, PNG_SIGNATURE),),),
    ".jpg": (((0, b"\xff\xd8\xff"),),),
    ".jpeg": (((0, b"\xff\xd8\xff"),),),
    ".gif": (((0, b"GIF87a"),), ((0, b"GIF89a"),)),
    ".webp": (((0, b"RIFF"), (8, b"WEBP")),),
    ".ico": (((0, b"\x00\x00\x01\x00"),),),
}

WHY_GENERATION = (
    "image carries generation metadata (prompt, workflow or parameters); "
    "strip it or keep the image out of the repository"
)
WHY_BINARY = (
    "binary file cannot be scanned; only image suffixes in allowed_binary_suffixes may be binary"
)
WHY_NOT_UTF8 = "file is not valid UTF-8, so it cannot be scanned"
WHY_BAD_ENCODING = (
    "commit message is not valid in its encoding (the commit's encoding header, "
    "i18n.commitEncoding for a message file, else UTF-8), so it cannot be scanned"
)
WHY_UNREADABLE = "file could not be read, so it cannot be scanned"
WHY_BAD_IMAGE = "PNG chunks could not be parsed or decoded, so its metadata cannot be checked"
WHY_IMAGE_HEADER = (
    "file does not start with the header of the image format its suffix names (or the suffix "
    "has no known header), so it is not read as that image"
)
WHY_MISSING = "object is missing from the repository, so it cannot be scanned"
WHY_SUBMODULE = (
    "git submodule (gitlink 160000) points to external commits whose content was not scanned"
)
WHY_LFS = (
    "Git LFS pointer detected; the backing binary asset was not scanned and must be reviewed"
)
WHY_REPLACE = (
    "git replace refs are present in this clone; pack transfer ignores replacements so scanned "
    "objects would not match what gets pushed"
)
WHY_IDENTITY = (
    "email is not on the allowed_emails list; set your GitHub noreply address (Settings > Emails): "
    "git config user.email '<id>+<name>@users.noreply.github.com'"
)
WHY_REDACTED_HINT = "name redacted; inspect locally with git status or git log"


class ScanError(Exception):
    """A usage or environment problem that stops the scan (exit status 2)."""


class Hit(NamedTuple):
    """One rule firing on one line of some content."""

    line: int
    rule_id: str
    why: str


class Finding(NamedTuple):
    """A hit with the place it was found; ``str()`` is the report line."""

    where: str
    line: int
    rule_id: str
    why: str

    def __str__(self) -> str:
        # A file name may hold a newline; escape it so one finding stays one line.
        where = CONTROL_CHARS.sub(lambda match: f"\\x{ord(match.group()):02x}", self.where)
        return f"{where}:{self.line}: {self.rule_id} -- {self.why}"


@dataclass(frozen=True)
class Rule:
    """A compiled deny rule, optionally limited to some file suffixes."""

    id: str
    regex: re.Pattern[str]
    why: str
    suffixes: tuple[str, ...]


@dataclass(frozen=True)
class RuleSet:
    """Everything the scanner needs from the merged rules documents."""

    rules: tuple[Rule, ...]
    allow: tuple[re.Pattern[str], ...]
    allowed_emails: tuple[re.Pattern[str], ...]
    binary_suffixes: frozenset[str]


@dataclass(frozen=True)
class LoadedRules:
    """Compiled rule set with metadata about private rule loading."""

    rules: RuleSet
    note: str
    private_loaded: bool
    private_rule_count: int


# --- rules -------------------------------------------------------------------------


def read_document(path: Path) -> dict:
    """Read one rules file and check that its outer shape is right."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ScanError(f"cannot read rules file {path}: {exc}") from exc
    if not isinstance(document, dict) or document.get("version") != 1:
        raise ScanError(f'{path}: expected a JSON object with "version": 1')
    unknown = sorted(set(document) - DOCUMENT_KEYS)
    if unknown:
        raise ScanError(f"{path}: unknown key(s): {', '.join(unknown)}")
    for key in DOCUMENT_LISTS:
        if not isinstance(document.get(key, []), list):
            raise ScanError(f"{path}: {key} must be a list")
    return document


def compile_pattern(pattern: str, flags: int, where: str) -> re.Pattern[str]:
    """Compile one regex; an error names the entry, never the pattern text."""
    try:
        return re.compile(pattern, flags)
    except re.error as exc:
        raise ScanError(f"{where}: invalid pattern ({exc.msg})") from exc


def literal_pattern(literal: str) -> re.Pattern[str]:
    """Match a literal as a whole token: never glued to a word character at an alphanumeric edge."""
    head = r"(?<!\w)" if literal[0].isalnum() else ""
    tail = r"(?!\w)" if literal[-1].isalnum() else ""
    return re.compile(head + re.escape(literal) + tail)


def compile_rule(raw: object, where: str) -> Rule:
    """Validate and compile one entry of ``rules``."""
    if not isinstance(raw, dict) or not RULE_REQUIRED <= set(raw) <= RULE_KEYS:
        raise ScanError(f"{where}: needs id, pattern and why, and may add flags and suffixes")
    flags, suffixes = raw.get("flags", ""), raw.get("suffixes", [])
    required = (raw["id"], raw["pattern"], raw["why"], flags)
    if not all(isinstance(value, str) for value in required):
        raise ScanError(f"{where}: id, pattern, why and flags must be strings")
    if set(flags) - set(FLAG_BITS) or not isinstance(suffixes, list):
        raise ScanError(f"{where}: flags allows only i, suffixes must be a list")
    bits = 0
    for letter in flags:
        bits |= FLAG_BITS[letter]
    regex = compile_pattern(raw["pattern"], bits, where)
    return Rule(raw["id"], regex, raw["why"], tuple(str(item).lower() for item in suffixes))


def compile_rules(document: dict, origin: str) -> RuleSet:
    """Validate a rules document and compile every pattern in it."""
    for key in DOCUMENT_LISTS[1:]:
        if not all(isinstance(item, str) and item for item in document.get(key, [])):
            raise ScanError(f"{origin}: {key} must be a list of non-empty strings")
    rules = [
        compile_rule(raw, f"{origin}: rules entry {number}")
        for number, raw in enumerate(document.get("rules", []), start=1)
    ]
    allow = [literal_pattern(item) for item in document.get("allow_literals", [])]
    allow += [
        compile_pattern(item, 0, f"{origin}: allow_patterns entry {number}")
        for number, item in enumerate(document.get("allow_patterns", []), start=1)
    ]
    emails = [
        compile_pattern(item, 0, f"{origin}: allowed_emails entry {number}")
        for number, item in enumerate(document.get("allowed_emails", []), start=1)
    ]
    suffixes = frozenset(item.lower() for item in document.get("allowed_binary_suffixes", []))
    return RuleSet(tuple(rules), tuple(allow), tuple(emails), suffixes)


def merge_rulesets(first: RuleSet, second: RuleSet) -> RuleSet:
    """Concatenate two rule sets, as the rules files promise."""
    return RuleSet(
        first.rules + second.rules,
        first.allow + second.allow,
        first.allowed_emails + second.allowed_emails,
        first.binary_suffixes | second.binary_suffixes,
    )


def load_ruleset(path: Path) -> RuleSet:
    """Read, validate and compile one rules file."""
    return compile_rules(read_document(path), str(path))


def private_rules_path() -> Path:
    """Where the owner's private rules live (``AGENT_GENOPS_PRIVATE_RULES`` overrides)."""
    override = os.environ.get(PRIVATE_RULES_ENV)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / "agent-genops" / "private_rules.json"


def read_clone_mode(cwd: Path | None = None) -> str | None:
    """Read clone-level ``genops.mode`` without modifying git config.

    None means the key is not set (``git config --get`` exits 1), which is the contributor
    mode. Any other failure (git cannot run, an unreadable configuration) raises ScanError:
    a read that failed is not an answer, and treating it as "not set" would let a maintainer
    clone drop to the contributor mode. The value is ``maintainer`` or ``contributor`` in any
    letter case; anything else (a typo such as ``maintaner``, ``true``, an empty value) raises
    ScanError too, since reading it as the default would switch the maintainer checks off.
    """
    target = cwd or Path.cwd()
    try:
        done = subprocess.run(
            ["git", "--no-replace-objects", "config", "--get", MAINTAINER_MODE_CONFIG_KEY],
            cwd=target,
            capture_output=True,
            check=False,
        )
    except OSError as exc:
        raise ScanError(f"cannot read {MAINTAINER_MODE_CONFIG_KEY}: cannot run git: {exc}") from exc
    if done.returncode == 1:
        return None
    if done.returncode != 0:
        detail = done.stderr.decode("utf-8", "replace").strip() or f"exit {done.returncode}"
        raise ScanError(f"cannot read {MAINTAINER_MODE_CONFIG_KEY}: git config failed: {detail}")
    value = done.stdout.decode("utf-8", "replace").strip().lower()
    if value not in (MAINTAINER_MODE_VALUE, CONTRIBUTOR_MODE_VALUE):
        raise ScanError(
            f"{MAINTAINER_MODE_CONFIG_KEY} is set to a value this scanner does not know; "
            f"set it to '{MAINTAINER_MODE_VALUE}' or '{CONTRIBUTOR_MODE_VALUE}' (any letter case), "
            f"or unset it for the contributor mode"
        )
    return value


def is_maintainer_required(cwd: Path | None = None) -> bool:
    """True when strict maintainer private-rule enforcement is active.

    The configuration is read even when the environment switch is on, so a value the scanner
    does not know is refused in every case."""
    mode = read_clone_mode(cwd)
    if os.environ.get(REQUIRE_PRIVATE_ENV) == "1":
        return True
    return mode == MAINTAINER_MODE_VALUE


def load_rules_detailed(
    public_path: Path,
    use_private: bool,
    *,
    require_private: bool = False,
    cwd: Path | None = None,
) -> LoadedRules:
    """Load public rules, merge private rules when enabled, and fail closed when required."""
    rules = load_ruleset(public_path)
    if not use_private:
        if require_private:
            raise ScanError("private rules are required in maintainer mode; --no-private is not allowed")
        return LoadedRules(rules, "private rules skipped (--no-private)", False, 0)
    strict = require_private or is_maintainer_required(cwd)
    path = private_rules_path()
    if not path.is_file():
        if strict:
            raise ScanError(f"maintainer/private rules required, but no private rules file at {path}")
        return LoadedRules(rules, "private rules not loaded (0 rules)", False, 0)
    private = load_ruleset(path)
    if strict and len(private.rules) == 0:
        raise ScanError(
            f"{path}: private rules file defines 0 rules; refusing to proceed in maintainer mode"
        )
    note = f"private rules loaded ({len(private.rules)} rules)"
    return LoadedRules(merge_rulesets(rules, private), note, True, len(private.rules))


def load_rules(
    public_path: Path, use_private: bool, require_private: bool = False
) -> tuple[RuleSet, str]:
    """Load the public rules, merge the private file if present, and say what happened."""
    loaded = load_rules_detailed(public_path, use_private, require_private=require_private)
    return loaded.rules, loaded.note


# --- matching & redaction ----------------------------------------------------------


def blank_allowed(line: str, rules: RuleSet) -> str:
    """Replace every allowed literal and allow-pattern match with spaces of equal length."""
    for pattern in rules.allow:
        line = pattern.sub(lambda match: " " * len(match.group()), line)
    return line


def scan_text(text: str, rules: RuleSet, suffix: str) -> list[Hit]:
    """Run every applicable rule over each line; a rule fires at most once per line."""
    applicable = [rule for rule in rules.rules if not rule.suffixes or suffix in rule.suffixes]
    hits = []
    for number, line in enumerate(text.split("\n"), start=1):
        if not line.strip():
            continue
        cleaned = blank_allowed(line, rules)
        fired = (rule for rule in applicable if rule.regex.search(cleaned))
        hits += [Hit(number, rule.id, rule.why) for rule in fired]
    return hits


def to_findings(where: str, hits: Iterable[Hit]) -> list[Finding]:
    """Attach a location to hits."""
    return [Finding(where, hit.line, hit.rule_id, hit.why) for hit in hits]


def scan_values(values: Iterable[str], rules: RuleSet, suffix: str) -> list[Hit]:
    """Scan decoded metadata strings; an image reports each rule once, on line 1."""
    found: dict[str, Hit] = {}
    for value in values:
        for hit in scan_text(value, rules, suffix):
            found.setdefault(hit.rule_id, Hit(1, hit.rule_id, hit.why))
    return list(found.values())


class NameRedactor:
    """Check file/ref names against rules and replace sensitive names with stable aliases."""

    def __init__(self, rules: RuleSet) -> None:
        self.rules = rules
        self._path_aliases: dict[str, str] = {}
        self._ref_aliases: dict[str, str] = {}
        self._hits_cache: dict[str, tuple[Hit, ...]] = {}

    @property
    def redacted_count(self) -> int:
        return len(self._path_aliases) + len(self._ref_aliases)

    def name_hits(self, raw: str) -> tuple[Hit, ...]:
        cached = self._hits_cache.get(raw)
        if cached is None:
            # Scan the raw name plus a slash-to-space variant so word-boundary rules fire cleanly.
            found: dict[str, Hit] = {}
            for candidate in (raw, raw.replace("/", " ").replace("\\", " ")):
                for hit in scan_text(candidate, self.rules, ""):
                    found.setdefault(hit.rule_id, Hit(1, hit.rule_id, hit.why))
            cached = tuple(found.values())
            self._hits_cache[raw] = cached
        return cached

    def safe_path(self, raw: str) -> str:
        if not raw:
            return raw
        if not self.name_hits(raw):
            return raw
        alias = self._path_aliases.get(raw)
        if alias is None:
            alias = f"<redacted-path#{len(self._path_aliases) + 1}>"
            self._path_aliases[raw] = alias
        return alias

    def safe_ref(self, raw: str) -> str:
        if not raw:
            return raw
        if not self.name_hits(raw):
            return raw
        alias = self._ref_aliases.get(raw)
        if alias is None:
            alias = f"<redacted-ref#{len(self._ref_aliases) + 1}>"
            self._ref_aliases[raw] = alias
        return alias

    def scan_path(self, raw: str, prefix: str = "") -> list[Finding]:
        hits = self.name_hits(raw)
        if not hits:
            return []
        alias = self.safe_path(raw)
        where = f"{prefix}path {alias}" if prefix else f"path {alias}"
        return [
            Finding(where, 1, hit.rule_id, f"{hit.why} ({WHY_REDACTED_HINT})") for hit in hits
        ]

    def scan_ref(self, raw: str, prefix: str = "") -> list[Finding]:
        hits = self.name_hits(raw)
        if not hits:
            return []
        alias = self.safe_ref(raw)
        where = f"{prefix}ref {alias}" if prefix else f"ref {alias}"
        return [
            Finding(where, 1, hit.rule_id, f"{hit.why} ({WHY_REDACTED_HINT})") for hit in hits
        ]

    def redact_secret_line(self, line: str) -> str:
        """Redact sensitive file paths in Betterleaks template lines (``rule path:line commit``)."""
        stripped = line.rstrip("\r\n")
        if not stripped:
            return stripped
        # Template format: "<rule_id> <file>:<line> <commit>" (commit may be empty on staged/dir).
        match = re.match(r"^(\s*\S+\s+)(.+?):(\d+)(\s+[0-9a-f]{7,64})?(\s*)$", stripped)
        if match:
            head, path_part, line_no, commit_part, tail = match.groups()
            safe = self.safe_path(path_part)
            return f"{head}{safe}:{line_no}{commit_part or ''}{tail}"
        # Fallback: if any token or the whole line hits a rule, redact sensitive tokens.
        if self.name_hits(stripped):
            tokens = re.split(r"(\s+)", stripped)
            out = []
            for tok in tokens:
                if tok and not tok.isspace() and self.name_hits(tok):
                    out.append(self.safe_path(tok))
                else:
                    out.append(tok)
            candidate = "".join(out)
            if self.name_hits(candidate):
                return "<redacted-line>"
            return candidate
        return stripped


# --- images & special files --------------------------------------------------------


def is_lfs_pointer(data: bytes) -> bool:
    """True when ``data`` looks like a Git LFS pointer file rather than real content."""
    if len(data) > 1024 or not data.startswith(LFS_HEADER):
        return False
    return b"oid sha256:" in data and b"\nsize " in data


def inflate(raw: bytes) -> bytes:
    """Decompress a zlib stream, refusing truncated streams and decompression bombs."""
    inflater = zlib.decompressobj()
    out = inflater.decompress(raw, MAX_INFLATED + 1)
    if len(out) > MAX_INFLATED or not inflater.eof:
        raise ValueError("compressed text is truncated or too large")
    return out


def decode_text_chunk(kind: bytes, payload: bytes) -> list[str]:
    """Return ``[keyword, text, ...]`` of a tEXt, zTXt or iTXt chunk; ValueError if malformed."""
    key, sep, rest = payload.partition(b"\0")
    if not sep:
        raise ValueError("text chunk has no keyword separator")
    fields = [key.decode("latin-1")]
    if kind == b"tEXt":
        fields.append(rest.decode("latin-1"))
    elif kind == b"zTXt":
        if rest[:1] != b"\0":
            raise ValueError("unknown compression method")
        fields.append(inflate(rest[1:]).decode("latin-1"))
    else:
        if len(rest) < 2:
            raise ValueError("short iTXt chunk")
        compressed, method = rest[0], rest[1]
        language, sep_a, rest = rest[2:].partition(b"\0")
        translated, sep_b, text = rest.partition(b"\0")
        if not (sep_a and sep_b) or (compressed and method != 0):
            raise ValueError("malformed iTXt chunk")
        if compressed:
            text = inflate(text)
        fields += [language.decode("latin-1"), translated.decode("utf-8"), text.decode("utf-8")]
    return fields


def raw_views(data: bytes) -> list[str]:
    """Latin-1 text of raw bytes, plus a NUL-free view so UTF-16 strings read as ASCII."""
    views = [data.decode("latin-1")]
    if b"\0" in data:
        views.append(data.replace(b"\0", b"").decode("latin-1"))
    return views


def has_class_type(text: str) -> bool:
    """True if the text holds a ComfyUI node graph (``"class_type"``)."""
    return '"class_type"' in text


def looks_generated(text: str) -> bool:
    """True if raw image bytes carry a ComfyUI graph or an A1111-style parameters block."""
    a1111 = "Steps: " in text and "Sampler: " in text
    return has_class_type(text) or a1111 or "parameters" in text


def read_png(data: bytes) -> tuple[list[str], bool]:
    """Walk a PNG: decode text chunks, read other chunks (not pixels) raw.

    Returns the strings to scan and whether generation metadata was seen. Raises
    ValueError, struct.error or zlib.error when the file cannot be parsed.
    """
    values: list[str] = []
    generated = False
    leftover = bytearray()
    pos, ended = len(PNG_SIGNATURE), False
    while pos < len(data) and not ended:
        length, kind = struct.unpack_from(">I4s", data, pos)
        start = pos + 8
        end = start + length + 4  # payload plus CRC
        if end > len(data):
            raise ValueError("truncated chunk")
        if kind in PNG_TEXT_CHUNKS:
            fields = decode_text_chunk(kind, data[start : start + length])
            values += fields
            generated |= fields[0].lower() in GENERATION_KEYS or any(map(has_class_type, fields))
        elif kind not in PNG_PIXEL_CHUNKS:
            leftover += data[start : start + length]
        pos, ended = end, kind == b"IEND"
    if not ended:
        raise ValueError("no IEND chunk")
    leftover += data[pos:]
    views = raw_views(bytes(leftover))
    return values + views, generated or any(map(has_class_type, views))


def has_image_header(suffix: str, data: bytes) -> bool:
    """True when ``data`` starts with the header of the format ``suffix`` names."""
    return any(
        all(data[offset : offset + len(magic)] == magic for offset, magic in alternative)
        for alternative in IMAGE_SIGNATURES.get(suffix, ())
    )


def scan_image(data: bytes, rules: RuleSet, suffix: str) -> list[Hit]:
    """Scan an image with an allowed suffix.

    The head must match the suffix's format. PNG text chunks are decoded and its other chunks
    read raw, pixel chunks excepted: compressed pixels match a short rule by chance (seven of
    the twelve PNGs in this repository did). A PNG that does not parse is read raw whole, as
    other formats are."""
    hits = [] if has_image_header(suffix, data) else [Hit(1, "image_header", WHY_IMAGE_HEADER)]
    values = raw_views(data)
    if data.startswith(PNG_SIGNATURE):
        try:
            values, generated = read_png(data)
        except (ValueError, struct.error, zlib.error):
            generated = False
            hits.append(Hit(1, "undecodable", WHY_BAD_IMAGE))
    else:
        generated = any(map(looks_generated, values))
    hits += scan_values(values, rules, suffix)
    if generated:
        hits.append(Hit(1, "generation_metadata", WHY_GENERATION))
    return hits


def scan_bytes(name: str, data: bytes, rules: RuleSet) -> list[Hit]:
    """Classify a file's bytes (LFS pointer, allowed image, binary or text) and scan them."""
    if is_lfs_pointer(data):
        return [Hit(1, "unsupported_lfs_pointer", WHY_LFS)]
    suffix = Path(name).suffix.lower()
    if suffix in rules.binary_suffixes:
        return scan_image(data, rules, suffix)
    binary = [Hit(1, "binary_not_allowed", WHY_BINARY)] if b"\0" in data else []
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        binary.append(Hit(1, "undecodable", WHY_NOT_UTF8))
    else:
        if not binary:
            return scan_text(text, rules, suffix)
    # Refused already; the rules still read the raw bytes, so the report names what is inside.
    return binary + scan_values(raw_views(data), rules, suffix)


# --- git ---------------------------------------------------------------------------


def git(args: list[str], cwd: Path, stdin: bytes | None = None) -> bytes:
    """Run git with ``--no-replace-objects`` and return stdout; any failure is a ScanError."""
    try:
        done = subprocess.run(
            ["git", "--no-replace-objects", *args],
            cwd=cwd,
            input=stdin,
            capture_output=True,
            check=False,
        )
    except OSError as exc:
        raise ScanError(f"cannot run git: {exc}") from exc
    if done.returncode != 0:
        detail = done.stderr.decode("utf-8", "replace").strip()
        raise ScanError(f"git {args[0]} failed: {detail}")
    return done.stdout


def repo_root(cwd: Path | None = None) -> Path:
    """The top-level directory of the repository containing ``cwd`` (or current directory)."""
    return Path(os.fsdecode(git(["rev-parse", "--show-toplevel"], cwd or Path.cwd()).strip()))


def split_names(listing: bytes) -> Iterator[str]:
    """Decode a NUL-separated name list from git."""
    return (os.fsdecode(raw) for raw in listing.split(b"\0") if raw)


def read_worktree(path: Path) -> bytes:
    """A file's bytes; a symlink yields its target text, which is what git stores."""
    if path.is_symlink():
        return os.fsencode(os.readlink(path))
    return path.read_bytes()


def scan_worktree_file(
    where: str,
    path: Path,
    rules: RuleSet,
    redactor: NameRedactor | None = None,
    prefix: str = "",
) -> list[Finding]:
    """Scan one working-tree file and its name; an unreadable file is itself a finding."""
    red = redactor or NameRedactor(rules)
    findings = red.scan_path(where, prefix=prefix)
    safe_where = f"{prefix}{red.safe_path(where)}" if prefix else red.safe_path(where)
    try:
        data = read_worktree(path)
    except OSError:
        findings.append(Finding(safe_where, 1, "undecodable", WHY_UNREADABLE))
        return findings
    findings += to_findings(safe_where, scan_bytes(path.name, data, rules))
    return findings


def parse_raw_diff_z(raw: bytes) -> list[tuple[str, str, str]]:
    """Parse ``git diff --raw -z --diff-filter=ACMRT`` into ``(new_mode, new_oid, path)``."""
    entries: list[tuple[str, str, str]] = []
    parts = raw.split(b"\0")
    idx = 0
    while idx < len(parts):
        meta = parts[idx]
        idx += 1
        if not meta:
            continue
        # Format: ":old_mode new_mode old_oid new_oid status"
        fields = meta.decode("ascii").lstrip(":").split()
        if len(fields) < 5:
            continue
        new_mode, new_oid, status = fields[1], fields[3], fields[4]
        if idx >= len(parts):
            break
        first_path = os.fsdecode(parts[idx])
        idx += 1
        if status.startswith(("R", "C")):
            if idx >= len(parts):
                break
            second_path = os.fsdecode(parts[idx])
            idx += 1
            entries.append((new_mode, new_oid, second_path))
        else:
            entries.append((new_mode, new_oid, first_path))
    return entries


def scan_staged(
    root: Path,
    rules: RuleSet,
    redactor: NameRedactor | None = None,
    prefix: str = "",
) -> list[Finding]:
    """Scan the index version (and names) of every file about to be committed."""
    red = redactor or NameRedactor(rules)
    # T: a regular file and a symlink swapping places changes the stored bytes like any edit.
    raw = git(["diff", "--cached", "--raw", "-z", "--no-abbrev", "--diff-filter=ACMRT"], root)
    findings: list[Finding] = []
    for new_mode, new_oid, name in parse_raw_diff_z(raw):
        findings += red.scan_path(name, prefix=prefix)
        safe_where = f"{prefix}{red.safe_path(name)}" if prefix else red.safe_path(name)
        if new_mode == "160000":
            findings.append(Finding(safe_where, 1, "unsupported_submodule", WHY_SUBMODULE))
            continue
        try:
            data = git(["cat-file", "blob", new_oid], root)
        except ScanError:
            findings.append(Finding(safe_where, 1, "undecodable", WHY_UNREADABLE))
        else:
            findings += to_findings(safe_where, scan_bytes(name, data, rules))
    return findings


def scan_unstaged(
    root: Path,
    rules: RuleSet,
    redactor: NameRedactor | None = None,
    prefix: str = "[unstaged] ",
) -> list[Finding]:
    """Scan working-tree files that differ from the index (and their names)."""
    red = redactor or NameRedactor(rules)
    raw = git(["diff", "--raw", "-z", "--no-abbrev", "--diff-filter=ACMRT"], root)
    findings: list[Finding] = []
    for new_mode, _new_oid, name in parse_raw_diff_z(raw):
        if new_mode == "160000":
            findings += red.scan_path(name, prefix=prefix)
            safe_where = f"{prefix}{red.safe_path(name)}"
            findings.append(Finding(safe_where, 1, "unsupported_submodule", WHY_SUBMODULE))
            continue
        findings += scan_worktree_file(name, root / name, rules, redactor=red, prefix=prefix)
    return findings


def scan_untracked(
    root: Path,
    rules: RuleSet,
    redactor: NameRedactor | None = None,
    prefix: str = "[untracked] ",
) -> list[Finding]:
    """Scan non-ignored untracked files in the working tree (and their names)."""
    red = redactor or NameRedactor(rules)
    listing = git(["ls-files", "--others", "--exclude-standard", "-z"], root)
    findings: list[Finding] = []
    for name in split_names(listing):
        findings += scan_worktree_file(name, root / name, rules, redactor=red, prefix=prefix)
    return findings


def scan_tracked(
    root: Path,
    rules: RuleSet,
    redactor: NameRedactor | None = None,
    prefix: str = "",
) -> list[Finding]:
    """Scan every tracked file (and its path name) as it is in the working tree."""
    red = redactor or NameRedactor(rules)
    listing = git(["ls-files", "--stage", "-z"], root)
    findings: list[Finding] = []
    seen: set[str] = set()
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        meta, sep, raw_name = entry.partition(b"\t")
        if not sep:
            continue
        mode = meta.decode("ascii").split()[0]
        name = os.fsdecode(raw_name)
        if name in seen:
            continue
        seen.add(name)
        if mode == "160000":
            findings += red.scan_path(name, prefix=prefix)
            safe_where = f"{prefix}{red.safe_path(name)}" if prefix else red.safe_path(name)
            findings.append(Finding(safe_where, 1, "unsupported_submodule", WHY_SUBMODULE))
            continue
        findings += scan_worktree_file(name, root / name, rules, redactor=red, prefix=prefix)
    return findings


def scan_replace_refs(root: Path) -> list[Finding]:
    """Fail closed if ``refs/replace/*`` exists in the repository."""
    out = git(["for-each-ref", "--format=%(refname)", "refs/replace"], root).strip()
    if out:
        return [Finding("git refs/replace", 1, "replace_ref", WHY_REPLACE)]
    return []


def check_ident(where: str, ident: str, rules: RuleSet) -> list[Finding]:
    """Check a ``Name <email> ...`` identity: strict email list first, then the normal rules."""
    ident = ident[: ident.rfind(">") + 1]
    match = IDENT_EMAIL.search(ident)
    findings = []
    if match is None or not any(p.fullmatch(match.group(1)) for p in rules.allowed_emails):
        findings.append(Finding(where, 1, "email", WHY_IDENTITY))
    return findings + to_findings(where, scan_text(ident, rules, ""))


def scan_identity(rules: RuleSet, cwd: Path | None = None) -> list[Finding]:
    """Check the author and committer identities git would use for the next commit."""
    findings = []
    target = cwd or Path.cwd()
    for var, role in (("GIT_AUTHOR_IDENT", "author"), ("GIT_COMMITTER_IDENT", "committer")):
        ident = git(["var", var], target).decode("utf-8", "replace").strip()
        findings += check_ident(f"identity {role}", ident, rules)
    return findings


def message_views(data: bytes, encoding: str | None) -> tuple[list[str], bool]:
    """The texts to scan for a message stored in ``encoding`` (UTF-8 when None).

    git keeps a message in the bytes of i18n.commitEncoding and shows it converted, so a rule
    with non-ASCII text matches only the decoded form. The UTF-8 reading (bad bytes replaced) is
    scanned as well, so a declared encoding can only add findings. The flag is False when the
    bytes are not valid in the encoding or the encoding is unknown: that text cannot be
    scanned, and the caller reports it.
    """
    views = [data.decode("utf-8", "replace")]
    try:
        declared = data.decode(encoding or "utf-8")
    except (LookupError, UnicodeDecodeError):
        return views, False
    if declared != views[0]:
        views.insert(0, declared)
    return views, True


def object_encoding(data: bytes) -> str | None:
    """The value of a commit object's top-level ``encoding`` header, if any."""
    for line in data.partition(b"\n\n")[0].split(b"\n"):
        if line.startswith(b"encoding "):
            return line[len(b"encoding ") :].decode("latin-1").strip()
    return None


def scan_commit(kind: str, oid: str, data: bytes, rules: RuleSet, prefix: str = "") -> list[Finding]:
    """Scan a commit or tag object: identities by the email list, everything else by the rules.

    Every header is read, not only the known ones: git keeps extra headers, and a mergetag header
    (written when a signed tag is merged) carries a whole tag object, one space in, whose tagger
    is checked like any identity. The object is read in the encoding its header names."""
    where = f"{prefix}{kind} {oid[:SHORT_SHA]}"
    views, readable = message_views(data, object_encoding(data))
    findings = [] if readable else [Finding(f"{where} message", 1, "undecodable", WHY_BAD_ENCODING)]
    for text in views:
        findings += scan_object_text(kind, where, text, rules)
    return unique(findings)


def scan_object_text(kind: str, where: str, text: str, rules: RuleSet) -> list[Finding]:
    """Scan one decoded reading of a commit or tag object."""
    head, _, body = text.partition("\n\n")
    findings = []
    other: list[str] = []
    header = ""
    for line in head.split("\n"):
        if line.startswith(" "):
            # A continuation line of the header above it.
            field, _, value = line[1:].partition(" ")
            if header == "mergetag" and field in IDENT_FIELDS:
                findings += check_ident(f"{where} mergetag {field}", value, rules)
            else:
                other.append(line[1:])
            continue
        header, _, value = line.partition(" ")
        if header in IDENT_FIELDS:
            findings += check_ident(f"{where} {header}", value, rules)
        elif kind == "tag" and header == "tag":
            # The name stored inside the tag object outlives its ref; never print it.
            hits = scan_text(value, rules, "")
            findings += [
                Finding(f"{where} name", 1, hit.rule_id, f"{hit.why} ({WHY_REDACTED_HINT})")
                for hit in hits
            ]
        else:
            other.append(line)
    findings += to_findings(f"{where} header", scan_text("\n".join(other), rules, ""))
    return findings + to_findings(f"{where} message", scan_text(body, rules, ""))


def read_batch(stream: BinaryIO) -> Iterator[tuple[str, str, bytes]]:
    """Yield ``(id, type, content)`` from ``git cat-file --batch``; type is "missing" if lost."""
    for header in iter(stream.readline, b""):
        oid, kind, *size = header.decode("ascii").split()
        if kind == "missing":
            yield oid, kind, b""
            continue
        data = stream.read(int(size[0]))
        if len(data) != int(size[0]):
            raise ScanError("git cat-file ended early")
        stream.read(1)  # the newline after the content
        yield oid, kind, data


def batch_read_objects(root: Path, oids: Iterable[str]) -> Iterator[tuple[str, str, bytes]]:
    """Stream objects from ``git --no-replace-objects cat-file --batch``."""
    oid_list = list(oids)
    if not oid_list:
        return
    with tempfile.TemporaryFile() as feed:
        feed.write("".join(f"{oid}\n" for oid in oid_list).encode("ascii"))
        feed.seek(0)
        try:
            proc = subprocess.Popen(
                ["git", "--no-replace-objects", "cat-file", "--batch"],
                cwd=root,
                stdin=feed,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise ScanError(f"cannot run git: {exc}") from exc
        assert proc.stdout is not None
        with proc:
            yield from read_batch(proc.stdout)
        if proc.returncode != 0:
            raise ScanError("git cat-file failed")


def parse_tree_entries(data: bytes) -> list[tuple[str, str, str]]:
    """Parse raw git tree object bytes into ``(mode, name, hex_oid)`` tuples."""
    entries: list[tuple[str, str, str]] = []
    pos = 0
    total = len(data)
    while pos < total:
        space = data.find(b" ", pos)
        if space == -1:
            raise ScanError("malformed git tree object (missing mode separator)")
        nul = data.find(b"\0", space + 1)
        if nul == -1 or nul + 21 > total:
            raise ScanError("malformed git tree object (truncated entry)")
        mode = data[pos:space].decode("ascii")
        name = os.fsdecode(data[space + 1 : nul])
        oid_bytes = data[nul + 1 : nul + 21]
        entries.append((mode, name, oid_bytes.hex()))
        pos = nul + 21
    return entries


def extract_commit_tree(data: bytes) -> str | None:
    """Extract the root tree OID from a raw commit object."""
    head, _, _ = data.partition(b"\n\n")
    for line in head.split(b"\n"):
        if line.startswith(b"tree "):
            return line[5:].decode("ascii").strip()
    return None


def tag_target(data: bytes) -> str | None:
    """The object id a raw tag object points at (its ``object`` header)."""
    head, _, _ = data.partition(b"\n\n")
    for line in head.split(b"\n"):
        if line.startswith(b"object "):
            return line[7:].decode("ascii").strip()
    return None


class Peeled(NamedTuple):
    """What a set of starting objects resolves to once every tag layer is read."""

    findings: list[Finding]
    commits: set[str]
    trees: set[str]
    blobs: set[str]


def peel_objects(root: Path, oids: Iterable[str], rules: RuleSet, prefix: str = "") -> Peeled:
    """Read every tag layer above ``oids`` (scanning each tag object) and sort the rest by type.

    A ref may point at a commit, a tree, a blob or an annotated tag, and a tag may point at
    another tag. Each tag object is scanned (name, tagger, message); what the chain ends in is
    returned so the caller can scan it. An unknown or missing object is a finding, never a pass.
    """
    findings: list[Finding] = []
    commits: set[str] = set()
    trees: set[str] = set()
    blobs: set[str] = set()
    seen: set[str] = set()
    pending = sorted(set(oids))
    while pending:
        seen.update(pending)
        next_round: set[str] = set()
        for oid, kind, data in batch_read_objects(root, pending):
            short = oid[:SHORT_SHA]
            if kind == "tag":
                findings += scan_commit("tag", oid, data, rules, prefix=prefix)
                target = tag_target(data)
                if target is None:
                    findings.append(Finding(f"{prefix}tag {short}", 1, "undecodable", WHY_MISSING))
                elif target not in seen:
                    next_round.add(target)
            elif kind == "commit":
                commits.add(oid)
            elif kind == "tree":
                trees.add(oid)
            elif kind == "blob":
                blobs.add(oid)
            else:
                findings.append(Finding(f"{prefix}object {short}", 1, "undecodable", WHY_MISSING))
        pending = sorted(next_round)
    return Peeled(findings, commits, trees, blobs)


def resolve_object(root: Path, rev: str) -> str:
    """The full object id ``rev`` names, whatever its type; ScanError if it names nothing."""
    try:
        out = git(["rev-parse", "--verify", "--quiet", "--end-of-options", f"{rev}^{{object}}"], root)
    except ScanError as exc:
        raise ScanError(f"not a git object: {rev}") from exc
    oid = out.strip()
    if not OBJECT_ID.fullmatch(oid):
        raise ScanError(f"not a git object: {rev}")
    return oid.decode("ascii")


def scan_history_scope(
    root: Path,
    rules: RuleSet,
    *,
    rev_args: list[str],
    start_objects: Iterable[str] = (),
    redactor: NameRedactor | None = None,
    ref_names: Iterable[str] = (),
    check_replace: bool = True,
    prefix: str = "",
) -> list[Finding]:
    """Scan commits, tags, all historical tree paths (incl. deleted/renamed/duplicate blobs),
    submodules, LFS pointers, and ref names for ``rev_args`` plus ``start_objects``.

    ``start_objects`` are object ids of any type (what refs point at): every tag layer above them
    is scanned, commits they reach join the history walk, and trees or blobs they end in are
    scanned directly."""
    red = redactor or NameRedactor(rules)
    if git(["rev-parse", "--is-shallow-repository"], root).strip() == b"true":
        raise ScanError("shallow clone: history is incomplete, run git fetch --unshallow")

    findings: list[Finding] = []
    if check_replace:
        findings += scan_replace_refs(root)

    for ref in ref_names:
        findings += red.scan_ref(ref, prefix=prefix)

    peeled = peel_objects(root, start_objects, rules, prefix=prefix)
    findings += peeled.findings

    commit_oids: list[str] = []
    if rev_args or peeled.commits:
        feed = "".join(f"{oid}\n" for oid in sorted(peeled.commits)).encode("ascii")
        commit_oids = [
            line.decode("ascii")
            for line in git(["rev-list", "--stdin", *rev_args], root, stdin=feed).split(b"\n")
            if OBJECT_ID.fullmatch(line)
        ]

    root_trees: set[str] = set(peeled.trees)
    for oid, kind, data in batch_read_objects(root, commit_oids):
        short = oid[:SHORT_SHA]
        if kind == "commit":
            findings += scan_commit(kind, oid, data, rules, prefix=prefix)
            tree_oid = extract_commit_tree(data)
            if tree_oid:
                root_trees.add(tree_oid)
        else:
            findings.append(Finding(f"{prefix}object {short}", 1, "undecodable", WHY_MISSING))

    # Walk every unique (tree_oid, path_prefix) across all historical commits so deleted paths,
    # renamed endpoints, and multiple paths sharing one blob are all checked. A blob a ref or tag
    # points at directly has no path: it is scanned once with no suffix.
    parsed_trees: dict[str, list[tuple[str, str, str]]] = {}
    visited_tree_paths: set[tuple[str, str]] = set()
    frontier: list[tuple[str, str]] = [(tree_oid, "") for tree_oid in sorted(root_trees)]
    blob_paths: dict[str, set[str]] = defaultdict(set)
    direct_blobs: set[str] = set(peeled.blobs)
    checked_paths: set[str] = set()

    while frontier:
        missing_trees = sorted({t_oid for t_oid, _ in frontier if t_oid not in parsed_trees})
        if missing_trees:
            for oid, kind, data in batch_read_objects(root, missing_trees):
                if kind == "tree":
                    parsed_trees[oid] = parse_tree_entries(data)
                else:
                    parsed_trees[oid] = []
                    findings.append(
                        Finding(
                            f"{prefix}object {oid[:SHORT_SHA]}",
                            1,
                            "undecodable",
                            WHY_MISSING,
                        )
                    )
        next_frontier: list[tuple[str, str]] = []
        for tree_oid, path_prefix in frontier:
            state = (tree_oid, path_prefix)
            if state in visited_tree_paths:
                continue
            visited_tree_paths.add(state)
            for mode, name, entry_oid in parsed_trees.get(tree_oid, ()):
                full_path = f"{path_prefix}/{name}" if path_prefix else name
                if full_path not in checked_paths:
                    checked_paths.add(full_path)
                    findings += red.scan_path(full_path, prefix=prefix)
                if mode in ("40000", "040000"):
                    next_frontier.append((entry_oid, full_path))
                elif mode == "160000":
                    safe = red.safe_path(full_path)
                    findings.append(
                        Finding(
                            f"{prefix}gitlink {entry_oid[:SHORT_SHA]} {safe}",
                            1,
                            "unsupported_submodule",
                            WHY_SUBMODULE,
                        )
                    )
                else:
                    blob_paths[entry_oid].add(full_path)
        frontier = next_frontier

    # Read each unique blob once, caching content hits by (oid, suffix).
    for oid, kind, data in batch_read_objects(root, sorted(set(blob_paths) | direct_blobs)):
        short = oid[:SHORT_SHA]
        if kind != "blob":
            # A tree entry or ref that names a missing object, or an object of the wrong type.
            findings.append(Finding(f"{prefix}object {short}", 1, "undecodable", WHY_MISSING))
            continue
        hits_by_suffix: dict[str, list[Hit]] = {}
        if oid in direct_blobs:
            hits_by_suffix[""] = scan_bytes("", data, rules)
            findings += to_findings(f"{prefix}blob {short}", hits_by_suffix[""])
        for full_path in sorted(blob_paths.get(oid, ())):
            suffix = Path(full_path).suffix.lower()
            if suffix not in hits_by_suffix:
                hits_by_suffix[suffix] = scan_bytes(full_path, data, rules)
            hits = hits_by_suffix[suffix]
            if hits:
                safe = red.safe_path(full_path)
                findings += to_findings(f"{prefix}blob {short} {safe}", hits)

    return findings


def scan_history(root: Path, rules: RuleSet, redactor: NameRedactor | None = None) -> list[Finding]:
    """Scan every object reachable from any ref: commits, every tag layer (nested tags too),
    trees and blobs, including refs that point straight at a tree or a blob, plus every
    historical path and every ref name. Covers at least what ``git rev-list --objects --all``
    lists."""
    all_refs: list[str] = []
    ref_objects: list[str] = []
    for line in git(["for-each-ref", "--format=%(objectname) %(refname)"], root).split(b"\n"):
        if not line:
            continue
        oid, _, ref = line.decode("utf-8", "replace").partition(" ")
        ref_objects.append(oid)
        all_refs.append(ref)
    return scan_history_scope(
        root,
        rules,
        rev_args=["--all"],
        start_objects=ref_objects,
        redactor=redactor,
        ref_names=all_refs,
        check_replace=True,
    )


# --- files and messages ------------------------------------------------------------


def read_commit_encoding(cwd: Path | None = None) -> str | None:
    """``i18n.commitEncoding`` as git would apply it to the next commit; None when not set."""
    try:
        done = subprocess.run(
            ["git", "--no-replace-objects", "config", "--get", "i18n.commitEncoding"],
            cwd=cwd or Path.cwd(),
            capture_output=True,
            check=False,
        )
    except OSError as exc:
        raise ScanError(f"cannot read i18n.commitEncoding: cannot run git: {exc}") from exc
    if done.returncode == 1:
        return None
    if done.returncode != 0:
        detail = done.stderr.decode("utf-8", "replace").strip() or f"exit {done.returncode}"
        raise ScanError(f"cannot read i18n.commitEncoding: git config failed: {detail}")
    return done.stdout.decode("latin-1").strip() or None


CUT_LINE = b"------------------------ >8 ------------------------\n"


UNREADABLE = object()  # a config value git cannot give: read as "do not assume a cleanup"


def last_config_value(pattern: str, cwd: Path | None = None) -> bytes | None | object:
    """The value git applies for the keys matching ``pattern`` (the last one set), raw bytes.

    None when no such key is set. UNREADABLE when one is set without a value or git cannot
    answer: the callers read that as "do not assume a cleanup", which scans more, never less."""
    try:
        done = subprocess.run(
            ["git", "--no-replace-objects", "config", "-z", "--get-regexp", pattern],
            cwd=cwd or Path.cwd(),
            capture_output=True,
            check=False,
        )
    except OSError:
        return UNREADABLE
    entries = [entry for entry in done.stdout.split(b"\0") if entry]
    if done.returncode == 1 and not entries:
        return None
    if done.returncode != 0 or not entries:
        return UNREADABLE
    _key, newline, value = entries[-1].partition(b"\n")
    return value if newline and value else UNREADABLE


def committed_message(data: bytes, cwd: Path | None = None) -> bytes:
    """The part of a commit-msg hook's message file that the commit will keep.

    git runs the hook before it cleans the message up (git-commit(1) ``--cleanup``,
    githooks(5)). With no editor git sets ``GIT_EDITOR=:`` for the hook and cleans up
    whitespace only, so every line stays. With an editor the default cleanup, ``strip``,
    removes the lines that start with the comment string (``core.commentChar`` or
    ``core.commentString``, ``#`` by default) and, under ``-v``, the diff from the scissors
    line on; ``scissors`` removes only the scissors line and what follows it; ``verbatim`` and
    ``whitespace`` remove nothing. ``--cleanup`` on the command line is not visible here, and
    neither is ``-v``: a scissors line under ``strip`` is taken as git's. Whatever cannot be
    read (the comment string ``auto``, a config git cannot answer) keeps every line.

    Removed comment lines become empty lines, so line numbers still match the hook's file.
    """
    if os.environ.get("GIT_EDITOR") == ":":
        return data
    cleanup = last_config_value(r"^commit\.cleanup$", cwd)
    if cleanup is None or cleanup == b"default":
        cleanup = b"strip"
    if cleanup not in (b"strip", b"scissors"):
        return data
    comment = last_config_value(r"^core\.comment(char|string)$", cwd)
    if comment is None:
        comment = b"#"
    if not isinstance(comment, bytes) or comment == b"auto":
        return data
    cut = comment + b" " + CUT_LINE
    if data.startswith(cut):
        data = b""
    else:
        at = data.find(b"\n" + cut)
        if at >= 0:
            data = data[: at + 1]
    if cleanup == b"scissors":
        return data
    lines = data.split(b"\n")
    return b"\n".join(b"" if line.startswith(comment) else line for line in lines)


def scan_message(path: Path, rules: RuleSet, kept_out: Path | None = None) -> list[Finding]:
    """Scan a commit message file, every line of it.

    A line starting with ``#`` is not skipped: git keeps it in the stored message unless the
    commit is cleaned up (``git commit -F FILE`` without ``--cleanup`` does not strip it), and
    what an editor's template adds there (branch, file names) is as public as the commit.
    There is no commit object yet, so the bytes are read in i18n.commitEncoding (UTF-8 when it
    is not set), the encoding git will store them under.

    With ``kept_out`` (the commit-msg hook) only what the commit will keep is scanned, as
    ``committed_message`` works it out, and those bytes are written to ``kept_out`` first so
    the hook's next scanner reads the same text; a failed write is an error, not a pass."""
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise ScanError(f"cannot read message file {path}: {exc.strerror}") from exc
    if kept_out is not None:
        data = committed_message(data)
        try:
            kept_out.write_bytes(data)
        except OSError as exc:
            raise ScanError(f"cannot write {kept_out}: {exc.strerror}") from exc
    where = path.as_posix()
    views, readable = message_views(data, read_commit_encoding())
    findings = [] if readable else [Finding(where, 1, "undecodable", WHY_BAD_ENCODING)]
    for text in views:
        findings += to_findings(where, scan_text(text, rules, ""))
    return unique(findings)


def walk_error(exc: OSError) -> None:
    """os.walk skips unlistable directories silently; make that an error instead."""
    raise ScanError(f"cannot list {exc.filename}: {exc.strerror}")


def iter_files(paths: list[Path]) -> Iterator[Path]:
    """Yield files under the given paths in a stable order; symlinks are not followed."""
    for top in paths:
        if top.is_dir() and not top.is_symlink():
            for folder, dirs, files in os.walk(top, onerror=walk_error):
                links = [d for d in dirs if os.path.islink(os.path.join(folder, d))]
                dirs[:] = sorted(d for d in dirs if d != ".git" and d not in links)
                for name in sorted(files + links):
                    if name != ".git":
                        yield Path(folder, name)
        elif top.exists() or top.is_symlink():
            yield top
        else:
            raise ScanError(f"no such path: {top}")


def scan_paths(
    paths: list[Path],
    rules: RuleSet,
    redactor: NameRedactor | None = None,
    prefix: str = "",
) -> list[Finding]:
    """Scan files and directories given on the command line (including path names)."""
    red = redactor or NameRedactor(rules)
    findings = []
    for path in iter_files(paths):
        findings += scan_worktree_file(path.as_posix(), path, rules, redactor=red, prefix=prefix)
    return findings


# --- command line ------------------------------------------------------------------


def unique(findings: Iterable[Finding]) -> list[Finding]:
    """Drop repeats of one rule at one place, keeping the first wording."""
    seen: set[tuple[str, int, str]] = set()
    kept = []
    for finding in findings:
        if finding[:3] not in seen:
            seen.add(finding[:3])
            kept.append(finding)
    return kept


def run_scans(
    args: argparse.Namespace, rules: RuleSet, redactor: NameRedactor
) -> list[Finding]:
    """Run every requested mode and collect the findings."""
    findings: list[Finding] = []
    needs_repo = any(
        (
            args.staged,
            args.unstaged,
            args.untracked,
            args.tracked,
            args.history,
            args.rev,
            args.range_spec,
            args.other_refs_except,
        )
    )
    root = repo_root() if needs_repo else None
    if args.staged:
        assert root is not None
        prefix = "[staged] " if args.source_labels else ""
        findings += scan_staged(root, rules, redactor=redactor, prefix=prefix)
    if args.unstaged:
        assert root is not None
        prefix = "[unstaged] " if args.source_labels else ""
        findings += scan_unstaged(root, rules, redactor=redactor, prefix=prefix)
    if args.untracked:
        assert root is not None
        prefix = "[untracked] " if args.source_labels else ""
        findings += scan_untracked(root, rules, redactor=redactor, prefix=prefix)
    if args.tracked:
        assert root is not None
        findings += scan_tracked(root, rules, redactor=redactor)
    if args.history:
        assert root is not None
        findings += scan_history(root, rules, redactor=redactor)
    if args.rev:
        assert root is not None
        # The object may be a commit, an annotated (possibly nested) tag, a tree or a blob:
        # each tag layer is scanned and what the chain ends in is scanned by its type.
        findings += scan_history_scope(
            root,
            rules,
            rev_args=[],
            start_objects=[resolve_object(root, args.rev)],
            redactor=redactor,
            ref_names=args.ref_names,
            check_replace=True,
        )
    if args.range_spec:
        assert root is not None
        prefix = "[branch] " if args.source_labels else ""
        findings += scan_history_scope(
            root,
            rules,
            rev_args=[args.range_spec],
            redactor=redactor,
            ref_names=args.ref_names,
            check_replace=True,
            prefix=prefix,
        )
    if args.other_refs_except:
        assert root is not None
        excluded = set(args.other_refs_except)
        other_refs = [
            line.decode("utf-8", "replace")
            for line in git(["for-each-ref", "--format=%(refname)"], root).split(b"\n")
            if line and line.decode("utf-8", "replace") not in excluded
        ]
        rev_args = ["--all", "--not", *args.other_refs_except]
        findings += scan_history_scope(
            root,
            rules,
            rev_args=rev_args,
            redactor=redactor,
            ref_names=other_refs,
            check_replace=False,
            prefix="[other-refs] ",
        )
    if args.ref_names and not (args.rev or args.range_spec):
        for ref in args.ref_names:
            findings += redactor.scan_ref(ref)
    if args.identity:
        findings += scan_identity(rules)
    if args.message:
        findings += scan_message(args.message, rules, kept_out=args.as_committed)
    if args.paths:
        findings += scan_paths(args.paths, rules, redactor=redactor)
    return findings


def build_parser() -> argparse.ArgumentParser:
    """The command-line interface."""
    parser = argparse.ArgumentParser(
        prog="privacy_scan.py",
        description="Scan for personal data before it reaches a public repository. "
        "Matched values and sensitive path/ref names are never printed.",
        epilog="exit status: 0 clean, 1 findings, 2 usage or internal error",
        allow_abbrev=False,
    )
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        metavar="PATH",
        help="files or directories to scan (recursive, skips .git)",
    )
    parser.add_argument(
        "--staged", action="store_true", help="scan staged content and names (the index)"
    )
    parser.add_argument(
        "--unstaged",
        action="store_true",
        help="scan unstaged working-tree changes relative to the index",
    )
    parser.add_argument(
        "--untracked",
        action="store_true",
        help="scan non-ignored untracked files in the working tree",
    )
    parser.add_argument(
        "--tracked",
        action="store_true",
        help="scan every tracked file as it is in the working tree",
    )
    parser.add_argument(
        "--history",
        action="store_true",
        help="scan every blob, commit, tag, historical path and ref reachable from any ref",
    )
    parser.add_argument(
        "--rev",
        metavar="COMMIT",
        help="scan one object and everything it reaches: a commit and its history, an annotated (nested) tag layer by layer, a tree or a blob",
    )
    parser.add_argument(
        "--range",
        dest="range_spec",
        metavar="BASE..HEAD",
        help="scan commits and historical paths in a commit range",
    )
    parser.add_argument(
        "--other-refs-except",
        action="append",
        default=[],
        metavar="REV",
        help="scan local history reachable from other refs excluding the given rev(s)",
    )
    parser.add_argument(
        "--ref-name",
        dest="ref_names",
        action="append",
        default=[],
        metavar="REF",
        help="check a target ref name against the rules (repeatable)",
    )
    parser.add_argument(
        "--identity",
        action="store_true",
        help="require noreply author and committer emails in the git identity",
    )
    parser.add_argument(
        "--message",
        type=Path,
        metavar="FILE",
        help="scan a commit message file, every line of it",
    )
    parser.add_argument(
        "--as-committed",
        type=Path,
        metavar="OUT",
        help="with --message, for the commit-msg hook: scan only what git keeps after it cleans "
        "the message up (an editor commit strips its comment lines) and write that text to OUT",
    )
    parser.add_argument(
        "--rules",
        type=Path,
        metavar="FILE",
        default=PUBLIC_RULES,
        help="use this public rules file instead of privacy_rules.json",
    )
    parser.add_argument(
        "--no-private", action="store_true", help="do not load the private rules file"
    )
    parser.add_argument(
        "--require-private",
        action="store_true",
        help="fail closed unless non-empty private rules are loaded",
    )
    parser.add_argument(
        "--source-labels",
        action="store_true",
        help="prefix staged/unstaged/untracked/branch findings with their source state",
    )
    parser.add_argument(
        "--json",
        dest="json_output",
        action="store_true",
        help="emit a structured, redacted JSON report on stdout",
    )
    parser.add_argument(
        "--clone-mode",
        action="store_true",
        help="print 'maintainer' or 'contributor' (genops.mode, case-insensitive, or "
        "AGENT_GENOPS_REQUIRE_PRIVATE=1) and exit; the hooks act on this answer",
    )
    parser.add_argument(
        "--redact-stream",
        action="store_true",
        help="read lines from stdin and print them with sensitive paths redacted",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, run the scans, print findings; return the exit status."""
    parser = build_parser()
    args = parser.parse_args(argv)
    modes = [
        args.staged,
        args.unstaged,
        args.untracked,
        args.tracked,
        args.history,
        args.rev,
        args.range_spec,
        args.other_refs_except,
        args.ref_names,
        args.identity,
        args.message,
        args.paths,
    ]
    if args.as_committed and not args.message:
        parser.error("--as-committed needs --message")
    if args.clone_mode:
        if args.redact_stream or any(modes):
            parser.error("--clone-mode takes no other mode")
        try:
            maintainer = is_maintainer_required()
        except ScanError as exc:
            print(f"privacy_scan: error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        print(MAINTAINER_MODE_VALUE if maintainer else CONTRIBUTOR_MODE_VALUE)
        return EXIT_CLEAN
    if args.redact_stream:
        sys.stdout.reconfigure(errors="backslashreplace")
        try:
            loaded = load_rules_detailed(
                args.rules,
                use_private=not args.no_private,
                require_private=args.require_private,
            )
            redactor = NameRedactor(loaded.rules)
            for line in sys.stdin:
                print(redactor.redact_secret_line(line))
            return EXIT_CLEAN
        except ScanError as exc:
            print(f"privacy_scan: error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        except Exception as exc:
            print(f"privacy_scan: internal error: {type(exc).__name__}: {exc}", file=sys.stderr)
            return EXIT_ERROR

    if not any(modes):
        parser.error("nothing to scan: give a mode (see --help) or a PATH")
    sys.stdout.reconfigure(errors="backslashreplace")
    try:
        loaded = load_rules_detailed(
            args.rules,
            use_private=not args.no_private,
            require_private=args.require_private,
        )
        if not args.json_output:
            print(f"privacy_scan: {loaded.note}", file=sys.stderr)
        redactor = NameRedactor(loaded.rules)
        findings = unique(run_scans(args, loaded.rules, redactor))
    except ScanError as exc:
        if args.json_output:
            print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"privacy_scan: error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except Exception as exc:  # keep the exit-status contract: a crash is 2, never 1
        if args.json_output:
            print(
                json.dumps(
                    {"status": "error", "error": f"{type(exc).__name__}: {exc}"},
                    ensure_ascii=False,
                )
            )
        else:
            print(f"privacy_scan: internal error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_ERROR

    if args.json_output:
        payload = {
            "status": "findings" if findings else "clean",
            "note": loaded.note,
            "private_loaded": loaded.private_loaded,
            "private_rule_count": loaded.private_rule_count,
            "redacted_names": redactor.redacted_count,
            "findings": [
                {
                    "where": f.where,
                    "line": f.line,
                    "rule_id": f.rule_id,
                    "why": f.why,
                }
                for f in findings
            ],
        }
        print(json.dumps(payload, ensure_ascii=False))
        return EXIT_FINDINGS if findings else EXIT_CLEAN

    for finding in findings:
        print(finding)
    sys.stdout.flush()  # keep the summary after the findings when both streams share a terminal
    if findings:
        print(f"privacy_scan: {len(findings)} finding(s)", file=sys.stderr)
        return EXIT_FINDINGS
    print("privacy_scan: clean", file=sys.stderr)
    return EXIT_CLEAN


if __name__ == "__main__":
    sys.exit(main())
