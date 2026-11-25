#!/bin/sh
# Second secret scan, next to tools/privacy_scan.py: wraps Betterleaks.
#
#   sh tools/secret_scan.sh staged           the index, as the next commit would contain it
#   sh tools/secret_scan.sh unstaged         working-tree diff relative to the index
#   sh tools/secret_scan.sh message FILE     one commit message file
#   sh tools/secret_scan.sh history          every object any ref reaches: every commit diff
#                                            (merge commits against their first parent), all
#                                            commit messages, every tag object (nested tags
#                                            layer by layer), and trees or blobs a ref or tag
#                                            points at directly
#   sh tools/secret_scan.sh rev OBJECT       one pushed object: a commit and its history, an
#                                            annotated (nested) tag layer by layer plus what it
#                                            ends in, a tree or a blob
#   sh tools/secret_scan.sh range BASE..HEAD commits in a range (merges against their first
#                                            parent), plus their messages
#   sh tools/secret_scan.sh files FILE...    specific working-tree files (symlinks not followed);
#                                            files Betterleaks' dir mode skips by head or as binary
#                                            go through the secondary pass with exact line numbers
#   sh tools/secret_scan.sh ignore-check --index | OBJECT
#                                            exit 1 unless the working tree's .betterleaksignore
#                                            and .gitleaksignore are byte for byte the versions in
#                                            the index or in OBJECT's tree (absent counts as a
#                                            version); the hooks run it before each scan
#
# Betterleaks itself scans diffs only and shows a merge commit no diff, so content that only a
# merge adds would pass unseen; every diff walk here asks git for merges against their first
# parent. Content Betterleaks skips as binary (plus printable-string extraction and PNG text
# chunks), tag objects, whole commit objects (every header and the message), symlink targets, and
# directly referenced trees and blobs go through a secondary stdin pass that maps every finding
# back to a stable per-file or per-object fingerprint and matches the active ignore file itself.
# Bare pathless ":rule:line" fingerprints are never honoured.
#
# Without SECRET_SCAN_IGNORE_PATH, Betterleaks applies the ignore files it finds on disk at the root
# of its source, whatever the scanned commit holds. A hook that scanned with a working-tree copy the
# commit does not carry would pass content under an exemption no reviewer sees; ignore-check is how
# the hooks refuse that.
#
# Optional environment controls:
#   SECRET_SCAN_IGNORE_PATH   explicit .betterleaksignore/.gitleaksignore file or directory. When
#                             set, it is the only ignore list: Betterleaks runs from an empty
#                             directory, so no .betterleaksignore or .gitleaksignore in the working
#                             tree (tracked, untracked, or checked out from the scanned history)
#                             applies. A path that does not exist is a usage error. The unstaged
#                             mode cannot be isolated from the working tree and refuses it.
#   SECRET_SCAN_IGNORE_ALLOW  when "1", pass --ignore-gitleaks-allow (inline allow comments off)
#   SECRET_SCAN_REDACT_SCANNER path to privacy_scan.py used to redact sensitive file paths
#   SECRET_SCAN_RULES         optional public rules file for path redaction
#   SECRET_SCAN_NO_PRIVATE    when "1", pass --no-private during path redaction
#
# Exit status: 0 clean, 2 usage error, 3 betterleaks missing, anything else: findings or a
# betterleaks failure. Secret values are never printed (--redact); a finding is one line,
# "rule path:line commit", with sensitive paths redacted by the privacy scanner; when that cannot
# redact, a placeholder is printed in place of the finding.
# Validation is off (it would send candidates to the network). The rules are Betterleaks' default
# rules, named with --config: the repository's own Betterleaks config is not loaded
# (--unsafe-auto-load-config is not used), and a config named in the environment
# (BETTERLEAKS_CONFIG, GITLEAKS_CONFIG and their _TOML forms) is cleared before the scan. The
# default config's path prefilter, which skips whole files by name, is switched off (see below).
set -eu

usage() {
  echo "usage: sh tools/secret_scan.sh staged | unstaged | message FILE | history | rev OBJECT | range SPEC | files FILE... | ignore-check --index|OBJECT" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
mode=$1
case "$mode" in
  staged | unstaged | history) [ "$#" -eq 1 ] || usage ;;
  message) [ "$#" -eq 2 ] && [ -r "$2" ] || usage ;;
  rev | range | ignore-check) [ "$#" -eq 2 ] && [ -n "$2" ] || usage ;;
  files) [ "$#" -ge 2 ] || usage ;;
  *) usage ;;
esac

if ! command -v betterleaks >/dev/null 2>&1; then
  echo "secret_scan: betterleaks is not on PATH, so the secret scan cannot run (a guard that skips itself is no guard)." >&2
  echo "secret_scan: install it with 'brew install betterleaks', or from https://github.com/betterleaks/betterleaks/releases" >&2
  exit 3
fi

here=$(cd "$(dirname "$0")" && pwd)
template="$here/secret_scan.tmpl"
redact_scanner=${SECRET_SCAN_REDACT_SCANNER:-"$here/privacy_scan.py"}

g() {
  git --no-replace-objects "$@"
}

# Scratch space for content streams, and (with an explicit ignore path) the isolated source.
work=$(mktemp -d "${TMPDIR:-/tmp}/secret-scan.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM HUP

# Betterleaks takes its config from --config, else from these variables (the names its 1.10.1
# --help lists, and the only ones its binary holds). One left in the shell for another project
# would replace the rules and allowlists here, so they are cleared and the default rules are
# named explicitly.
#
# The default config of 1.10.1 (`betterleaks config show`) opens with a prefilter that drops a
# file by its path before any rule runs: image and font suffixes (.svg among them), office
# documents and executables, lock files (yarn.lock, package-lock.json, go.sum, poetry.lock and
# more), node_modules, vendor and virtualenv folders. Its git and dir modes alike never read
# such a file, so a token in it, or in any file renamed to look like one, would pass. A top-level
# prefilter here replaces the default one (`config show` prints ours; checked with 1.10.1), and
# 'false' drops nothing. The default rules and their per-finding filters stay as they are.
unset BETTERLEAKS_CONFIG GITLEAKS_CONFIG BETTERLEAKS_CONFIG_TOML GITLEAKS_CONFIG_TOML
config="$work/config.toml"
printf "prefilter = 'false'\n\n[extend]\nuseDefault = true\n" >"$config"

ignore_path=${SECRET_SCAN_IGNORE_PATH:-}
src=.
iso=
if [ -n "$ignore_path" ]; then
  case "$ignore_path" in
    /*) ;;
    *) ignore_path="$(pwd)/$ignore_path" ;;
  esac
  if [ ! -e "$ignore_path" ]; then
    echo "secret_scan: SECRET_SCAN_IGNORE_PATH does not exist: $ignore_path" >&2
    exit 2
  fi
  if [ "$mode" = unstaged ]; then
    echo "secret_scan: the unstaged mode reads the working tree, where a .betterleaksignore would apply next to SECRET_SCAN_IGNORE_PATH; use 'files' instead" >&2
    exit 2
  fi
  case "$mode" in
    staged | history | rev | range)
      # Betterleaks reads .betterleaksignore and .gitleaksignore from the root of its source and,
      # for stdin, from the current directory, even when -i names another file (checked with
      # 1.10.1). An empty directory whose .git file points at this repository gives it the same
      # history with nothing else to read.
      iso="$work/src"
      mkdir "$iso"
      gitdir=$(g rev-parse --absolute-git-dir)
      printf 'gitdir: %s\n' "$gitdir" >"$iso/.git"
      src=$iso
      ;;
  esac
fi

# Findings carry file paths, which can be private names: they are printed only after the
# scanner's --redact-stream has seen them. A scanner that is missing, too old to know the flag
# or failing leaves a placeholder, never the raw text.
redact_output() {
  set -- -I -B "$redact_scanner" --redact-stream
  if [ -n "${SECRET_SCAN_RULES:-}" ]; then
    set -- "$@" --rules "$SECRET_SCAN_RULES"
  fi
  if [ "${SECRET_SCAN_NO_PRIVATE:-0}" = "1" ]; then
    set -- "$@" --no-private
  fi
  if [ -f "$redact_scanner" ] && redacted=$(python3 "$@"); then
    printf '%s\n' "$redacted"
  else
    echo "<redacted: path redaction failed; inspect locally>"
  fi
}

# bl SUBCOMMAND [ARGS...]: one Betterleaks run with the shared flags; stdin is passed through.
# With an explicit ignore path, git and stdin runs start in the isolated directory (a dir run
# names a single file as its source, so no ignore file is read from beside it).
bl() {
  sub=$1
  if [ -n "$ignore_path" ]; then
    set -- "$@" -i "$ignore_path"
  fi
  if [ "${SECRET_SCAN_IGNORE_ALLOW:-0}" = "1" ]; then
    set -- "$@" --ignore-gitleaks-allow
  fi
  set -- "$@" --config "$config" --redact --no-banner --no-color --log-level warn \
    --report-format template --report-template "$template" --report-path -
  if [ -n "$iso" ] && [ "$sub" != dir ]; then
    (
      cd "$iso"
      unset GIT_DIR GIT_WORK_TREE
      exec betterleaks "$@"
    )
  else
    betterleaks "$@"
  fi
}

# scan LABEL SUBCOMMAND [ARGS...]
scan() {
  label=$1
  shift
  rc=0
  out=$(bl "$@") || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "secret_scan: $label: betterleaks exited $rc" >&2
    if [ -n "$out" ]; then
      printf '%s\n' "$out" | redact_output | sed 's/^/  /' >&2
    fi
    echo "secret_scan: values are redacted. For a false positive see 'Second scan: Betterleaks' in PRIVACY.md." >&2
    return 1
  fi
}

# scan_secondary LABEL KIND [ARGS...]: run Betterleaks stdin with stable per-file / per-object
# fingerprints, printable-byte isolation and PNG text-chunk decoding (tEXt/zTXt/iTXt), and
# wrapper-side ignore-file matching. Betterleaks itself runs from an empty directory with an
# empty ignore file so bare ":rule:line" fingerprints can never apply.
#
# KINDS:
#   binary staged | unstaged | log REV-ARGS... | file PATH
#   objects history | rev OBJECT | range SPEC
#   symlink PATH
#   message PATH
scan_secondary() {
  label=$1
  shift
  mkdir -p "$work/sec-empty"
  : >"$work/sec-empty.ignore"
  out_file="$work/sec-findings"
  : >"$out_file"
  rc=0
  python3 -I -B -c '
import bisect, json, os, struct, subprocess, sys, tempfile, zlib

config_path, empty_dir, empty_ignore, ignore_path, ignore_allow_flag, out_file, feed_dir, kind, *args = sys.argv[1:]
ignore_allow = ignore_allow_flag == "1"
git_cmd = ["git", "--no-replace-objects"]
diff_opts = ["--no-renames", "--no-relative", "--no-textconv", "--no-ext-diff"]
PNG_SIG = b"\x89PNG\r\n\x1a\n"
MAX_INFLATED = 64 * 1024 * 1024
MAX_BATCH_BYTES = 32 * 1024 * 1024
PRINTABLE_TRANS = bytes(b if (b in (9, 10) or 32 <= b <= 126) else 32 for b in range(256))
SYNTHETIC_PREFIXES = (".git/commit:", ".git/tag:", ".git/blob:", ".git/blob#")

def fail(why, code=1):
    prefix = "binary content" if kind == "binary" else kind
    sys.stderr.write(f"secret_scan: {prefix}: {why}; nothing was passed as clean\n")
    sys.exit(code)

def run_child(cmd, data=None, **kwargs):
    # Input goes through an unlinked file, never a pipe: writing a pipe while the child fills
    # its output pipe deadlocks once the kernel shrinks pipes to PIPE_BUF and poll still
    # reports a full pipe writable (macOS under pipe-memory pressure).
    if data is None:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    feed = None
    try:
        feed = tempfile.TemporaryFile(dir=feed_dir)
        feed.write(data)
        feed.seek(0)
    except OSError as error:
        if feed is not None:
            feed.close()
        fail(f"cannot stage the input for {cmd[0]} ({error.strerror})")
    with feed:
        return subprocess.run(cmd, stdin=feed, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)

def run_git(gargs, data=None, allow_fail=False):
    proc = run_child(git_cmd + gargs, data)
    if proc.returncode != 0 and not allow_fail:
        fail(f"git {gargs[0]} exited {proc.returncode}")
    return proc

def git_top(required=True):
    proc = run_git(["rev-parse", "--show-toplevel"], allow_fail=not required)
    if proc.returncode != 0:
        return None
    top = proc.stdout.removesuffix(b"\n")
    if not top:
        if required:
            fail("git rev-parse --show-toplevel printed nothing")
        return None
    return os.fsdecode(top)

def sanitize_printable(data):
    return data.translate(PRINTABLE_TRANS)

def is_valid_utf8(data):
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False

def needs_binary_pass(data):
    return b"\0" in data or data.startswith(PNG_SIG) or not is_valid_utf8(data)

def inflate_limited(raw, limit):
    if limit <= 0:
        fail("PNG compressed text chunk exceeds size limit")
    inflater = zlib.decompressobj()
    try:
        out = inflater.decompress(raw, limit + 1)
    except zlib.error:
        fail("cannot decompress PNG text chunk")
    if len(out) > limit or not inflater.eof:
        fail("PNG compressed text chunk is truncated or exceeds size limit")
    return out

def extract_png_text(data):
    if not data.startswith(PNG_SIG):
        return None
    pos = len(PNG_SIG)
    total_inflated = 0
    parts = []
    while pos < len(data):
        if pos + 8 > len(data):
            break
        length, chunk_kind = struct.unpack_from(">I4s", data, pos)
        start = pos + 8
        end = start + length + 4
        if end > len(data):
            if chunk_kind in (b"tEXt", b"zTXt", b"iTXt"):
                fail("truncated PNG text chunk")
            break
        payload = data[start : start + length]
        if chunk_kind == b"tEXt":
            key, sep, text = payload.partition(b"\0")
            if not sep:
                fail("malformed PNG tEXt chunk")
            parts.extend([key, text])
        elif chunk_kind == b"zTXt":
            key, sep, rest = payload.partition(b"\0")
            if not sep or rest[:1] != b"\0":
                fail("malformed PNG zTXt chunk")
            inflated = inflate_limited(rest[1:], MAX_INFLATED - total_inflated)
            total_inflated += len(inflated)
            parts.extend([key, inflated])
        elif chunk_kind == b"iTXt":
            key, sep, rest = payload.partition(b"\0")
            if not sep or len(rest) < 2:
                fail("malformed PNG iTXt chunk")
            comp_flag, comp_method = rest[0], rest[1]
            lang, sep_a, rest2 = rest[2:].partition(b"\0")
            trans, sep_b, text = rest2.partition(b"\0")
            if not (sep_a and sep_b) or comp_flag not in (0, 1) or (comp_flag == 1 and comp_method != 0):
                fail("malformed PNG iTXt chunk")
            if comp_flag == 1:
                text = inflate_limited(text, MAX_INFLATED - total_inflated)
                total_inflated += len(text)
            parts.extend([key, lang, trans, text])
        pos = end
        if chunk_kind == b"IEND":
            break
    if not parts:
        return None
    return b"\n".join(parts) + b"\n"

def decode_path(raw):
    return raw.decode("utf-8", "replace")

def escape_display_path(text):
    return text.replace("\r", "\\r").replace("\n", "\\n")

def normalize_fs_path(target, top):
    # Preserve the symlink own path (never follow the final component).
    parent = os.path.realpath(os.path.dirname(os.path.abspath(target)))
    base = os.path.basename(os.path.abspath(target))
    full = os.path.join(parent, base)
    if top is not None:
        real_top = os.path.realpath(top)
        try:
            rel = os.path.relpath(full, real_top)
        except ValueError:
            rel = None
        if rel and rel != "." and not rel.startswith(".." + os.sep) and rel != "..":
            return rel.replace(os.sep, "/")
    cleaned = target
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned.replace(os.sep, "/")

def load_ignores():
    paths = []
    if ignore_path:
        if os.path.isdir(ignore_path):
            for name in (".betterleaksignore", ".gitleaksignore"):
                cand = os.path.join(ignore_path, name)
                if os.path.exists(cand):
                    paths.append(cand)
        else:
            paths.append(ignore_path)
    else:
        base = git_top(required=False) or os.getcwd()
        for name in (".betterleaksignore", ".gitleaksignore"):
            cand = os.path.join(base, name)
            if os.path.exists(cand) or os.path.islink(cand):
                paths.append(cand)
    entries = set()
    for p in paths:
        try:
            with open(p, "r", encoding="utf-8", errors="surrogateescape") as fh:
                for raw_line in fh:
                    line = raw_line.strip()
                    if not line or line.startswith("#"):
                        continue
                    # Bare pathless ":rule:line" and unscoped synthetic git-object entries never match.
                    if line.startswith(":") or line.startswith(SYNTHETIC_PREFIXES):
                        continue
                    entries.add(line)
        except OSError as exc:
            fail(f"cannot read ignore file ({exc.strerror})")
    return entries

def is_ignored(ignores, commit, path, rule, line, oid_only, allow_ignore):
    if not allow_ignore or not ignores:
        return False
    if "\n" in path or "\r" in path:
        return False
    if commit and f"{commit}:{path}:{rule}:{line}" in ignores:
        return True
    if not oid_only and f"{path}:{rule}:{line}" in ignores:
        return True
    return False

def run_bl_batch(chunks, allow_inline):
    """Run betterleaks stdin once on packed chunks.

    ``chunks`` is a list of ``(key, data_bytes)``. Returns ``(mapped, unmapped)`` where
    ``mapped`` is a set of ``(key, rule_id, local_line)`` and ``unmapped`` is a list of
    ``(rule_id, stream_line)`` if a finding ever landed outside an item boundary.
    """
    mapped = set()
    unmapped = []
    idx = 0
    while idx < len(chunks):
        buf = bytearray(b"\n")  # line 1 empty so stdin never sniffs binary
        cur_line = 2
        starts = []
        meta = []
        while idx < len(chunks):
            key, data = chunks[idx]
            if not data:
                idx += 1
                continue
            payload = data if data.endswith(b"\n") else data + b"\n"
            if meta and len(buf) + len(payload) + 1 > MAX_BATCH_BYTES:
                break
            n_lines = payload.count(b"\n")
            start_line = cur_line
            end_line = cur_line + n_lines - 1
            starts.append(start_line)
            meta.append((start_line, end_line, key))
            buf.extend(payload)
            buf.append(10)  # blank separator line between items
            cur_line = end_line + 2
            idx += 1
        if not meta:
            continue
        cmd = [
            "betterleaks", "stdin",
            "-i", empty_ignore,
            "--config", config_path,
            "--redact", "--no-banner", "--no-color", "--log-level", "error",
            "--report-format", "json", "--report-path", "-",
        ]
        if not allow_inline:
            cmd.append("--ignore-gitleaks-allow")
        env = {k: v for k, v in os.environ.items() if k not in ("GIT_DIR", "GIT_WORK_TREE")}
        proc = run_child(cmd, buf, cwd=empty_dir, env=env)
        if proc.returncode not in (0, 1):
            fail(f"betterleaks stdin exited {proc.returncode}")
        if proc.returncode == 0:
            continue
        try:
            findings = json.loads(proc.stdout.decode("utf-8") or "[]")
        except (UnicodeDecodeError, ValueError):
            fail("betterleaks stdin returned unreadable JSON")
        if not isinstance(findings, list) or not findings:
            fail("betterleaks stdin exited 1 without findings")
        for item in findings:
            rule = str(item.get("RuleID") or "unknown")
            s_line = int(item.get("StartLine") or 0)
            e_line = int(item.get("EndLine") or s_line)
            pos = bisect.bisect_right(starts, s_line) - 1
            if 0 <= pos < len(meta):
                m_start, m_end, key = meta[pos]
                if m_start <= s_line <= m_end and e_line <= m_end:
                    mapped.add((key, rule, s_line - m_start + 1))
                    continue
            unmapped.append((rule, s_line))
    return mapped, unmapped

def batch_cat_file(oids, expect_type=None):
    if not oids:
        return []
    out = run_git(["cat-file", "--batch"], b"".join(o + b"\n" for o in oids)).stdout
    pos = 0
    results = []
    for oid in oids:
        header = out[pos:].partition(b"\n")[0]
        fields = header.split()
        if len(fields) != 3 or fields[0] != oid or (expect_type is not None and fields[1] != expect_type):
            oid_text = oid.decode("ascii", "replace")
            fail(f"git cat-file did not return expected object {oid_text}")
        size = int(fields[2])
        start = pos + len(header) + 1
        results.append((fields[1], out[start : start + size]))
        pos = start + size + 1
    return results

def expand_binary_views(key_base, data):
    """Build (subkey, bytes) views for binary content: raw, printable-sanitized, and PNG text."""
    views = []
    if data:
        views.append(((key_base, "content"), data))
        san = sanitize_printable(data)
        if san != data:
            views.append(((key_base, "content"), san))
    png_text = extract_png_text(data)
    if png_text:
        views.append(((key_base, "png_text"), png_text))
        san_png = sanitize_printable(png_text)
        if san_png != png_text:
            views.append(((key_base, "png_text"), san_png))
    return views

def marked(numstat):
    added, deleted, path = numstat.split(b"\t", 2)
    return path, added == b"-" and deleted == b"-"

def changed_entries(log):
    """Return list of (commit_sha, path_bytes, oid_bytes, is_binary) from log -z --raw --numstat."""
    records = []
    def close(commit_sha, entries, binary):
        if not entries:
            return
        if not commit_sha:
            fail("git log printed changes without a commit header")
        for path, oid in entries:
            if path not in binary:
                fail("git log printed no --numstat line for a changed file")
            records.append((commit_sha, path, oid, binary[path]))
    commit_sha = ""
    entries, binary = [], {}
    fields = iter(log.split(b"\0"))
    for token in fields:
        token = token.lstrip(b"\n")
        if token.startswith(b"\x01"):
            close(commit_sha, entries, binary)
            commit_sha = token[1:].decode("ascii", "strict")
            entries, binary = [], {}
        elif token.startswith(b":"):
            path = next(fields, None)
            parts = token[1:].split(b" ")
            if path is None or len(parts) != 5:
                fail("git log --raw output did not parse")
            _, new_mode, _, oid, status = parts
            if (new_mode.startswith(b"100") or new_mode == b"120000") and status[:1] in b"AMT":
                entries.append((path, oid))
        elif token:
            if token.count(b"\t") < 2:
                fail("git log --numstat output did not parse")
            path, is_binary = marked(token)
            binary[path] = binary.get(path, False) or is_binary
    close(commit_sha, entries, binary)
    return records

def peel_object(start_oid):
    """Peel tags from start_oid; return (tags_list, final_type, final_oid)."""
    oid = start_oid
    tags = []
    depth = 0
    while True:
        proc = run_git(["cat-file", "-t", oid], allow_fail=True)
        if proc.returncode != 0:
            sys.stderr.write(f"secret_scan: cannot read object {oid}\n")
            sys.exit(2)
        obj_type = proc.stdout.decode("ascii", "replace").strip()
        if obj_type == "tag":
            tag_data = run_git(["cat-file", "tag", oid]).stdout
            tags.append((oid, tag_data))
            first = tag_data.partition(b"\n")[0].decode("ascii", "replace")
            if not first.startswith("object "):
                sys.stderr.write("secret_scan: malformed or too deeply nested tag object\n")
                sys.exit(2)
            oid = first[len("object "):].strip()
            depth += 1
            if not oid or depth > 64:
                sys.stderr.write("secret_scan: malformed or too deeply nested tag object\n")
                sys.exit(2)
        elif obj_type in ("commit", "tree", "blob"):
            return tags, obj_type, oid
        else:
            sys.stderr.write(f"secret_scan: unsupported object type \x27{obj_type}\x27 for {oid}\n")
            sys.exit(2)

# Findings collected as tuples: (commit, path, rule, line, oid_only, allow_ignore)
raw_findings = []
unmapped_findings = []

if kind == "binary":
    sub, *rest = args
    if sub in ("staged", "unstaged"):
        cmd = ["diff", "--numstat", "-z", *diff_opts, "--ignore-submodules=all", "--diff-filter=ACMT"]
        if sub == "staged":
            cmd.append("--cached")
            top = None
        else:
            top = git_top(required=True)
        chunks = []
        path_map = {}
        idx = 0
        for record in run_git(cmd).stdout.split(b"\0"):
            if not record:
                continue
            path_bytes, is_binary = marked(record)
            if sub == "staged":
                data = run_git(["cat-file", "blob", b":0:" + path_bytes]).stdout
            else:
                local = os.path.join(top, os.fsdecode(path_bytes))
                try:
                    if os.path.islink(local):
                        data = os.fsencode(os.readlink(local))
                    else:
                        with open(local, "rb") as handle:
                            data = handle.read()
                except OSError as error:
                    fail(f"a changed file that git lists cannot be read ({error.strerror})")
            if is_binary or needs_binary_pass(data):
                idx += 1
                path_map[idx] = decode_path(path_bytes)
                chunks.extend(expand_binary_views(idx, data))
        mapped, unmapped = run_bl_batch(chunks, allow_inline=False)
        unmapped_findings.extend(unmapped)
        for (item_id, view), rule, line in mapped:
            p = path_map[item_id]
            loc = f"{p}#png-text" if view == "png_text" else p
            raw_findings.append(("", loc, rule, line, False, True))
    elif sub == "log":
        log_out = run_git([
            "log", "-z", "--raw", "--numstat", "--no-abbrev", *diff_opts,
            "--diff-merges=first-parent", "--format=%x01%H", *rest,
        ]).stdout
        records = changed_entries(log_out)
        # Fetch each unique blob once, then scan only blobs that are binary or PNG or invalid UTF-8.
        unique_oids = list(dict.fromkeys(oid for _, _, oid, _ in records))
        oid_binary_flag = {}
        for _, _, oid, is_bin in records:
            if is_bin:
                oid_binary_flag[oid] = True
        blob_data = {}
        for oid, (_t, data) in zip(unique_oids, batch_cat_file(unique_oids, expect_type=b"blob")):
            if oid_binary_flag.get(oid) or needs_binary_pass(data):
                blob_data[oid] = data
        chunks = []
        for oid, data in blob_data.items():
            chunks.extend(expand_binary_views(oid, data))
        mapped, unmapped = run_bl_batch(chunks, allow_inline=False)
        unmapped_findings.extend(unmapped)
        hits_by_oid = {}
        for (oid, view), rule, line in mapped:
            hits_by_oid.setdefault(oid, set()).add((view, rule, line))
        for commit_sha, path_bytes, oid, is_bin in records:
            if oid not in hits_by_oid:
                continue
            p = decode_path(path_bytes)
            for view, rule, line in hits_by_oid[oid]:
                loc = f"{p}#png-text" if view == "png_text" else p
                raw_findings.append((commit_sha, loc, rule, line, False, True))
    elif sub == "file":
        target = rest[0]
        try:
            with open(target, "rb") as handle:
                data = handle.read()
        except OSError as error:
            fail(f"cannot read file ({error.strerror})")
        p = normalize_fs_path(target, git_top(required=False))
        if needs_binary_pass(data):
            chunks = expand_binary_views(0, data)
            mapped, unmapped = run_bl_batch(chunks, allow_inline=False)
            unmapped_findings.extend(unmapped)
            for (_id, view), rule, line in mapped:
                loc = f"{p}#png-text" if view == "png_text" else p
                raw_findings.append(("", loc, rule, line, False, True))
        elif data:
            # Also catch text files whose head Betterleaks dir mode sniffs and skips (PDF, ELF, ZIP, MZ, 7z, gzip).
            mapped, unmapped = run_bl_batch([(0, data)], allow_inline=not ignore_allow)
            unmapped_findings.extend(unmapped)
            for _id, rule, line in mapped:
                raw_findings.append(("", p, rule, line, False, True))
    else:
        fail(f"unknown binary submode {sub}", code=2)

elif kind == "objects":
    sub, *rest = args
    tags = {}       # tag_oid -> bytes
    commits = []    # list of commit_sha (deduped)
    trees = set()   # tree_oid
    blobs = set()   # blob_oid

    if sub == "history":
        refs_out = run_git(["for-each-ref", "--format=%(objecttype) %(objectname)"]).stdout.decode("ascii", "replace")
        ref_lines = [ln for ln in refs_out.splitlines() if ln.strip()]
        if ref_lines:
            for ln in ref_lines:
                otype, oid = ln.split(" ", 1)
                if otype != "commit":
                    peeled_tags, final_type, final_oid = peel_object(oid)
                    for t_oid, t_data in peeled_tags:
                        tags[t_oid] = t_data
                    if final_type == "tree":
                        trees.add(final_oid)
                    elif final_type == "blob":
                        blobs.add(final_oid)
            revs = run_git(["rev-list", "--all"]).stdout.decode("ascii", "strict").splitlines()
            commits = list(dict.fromkeys(r for r in revs if r))
    elif sub == "rev":
        obj_spec = rest[0]
        verify = run_git(["rev-parse", "--verify", "--quiet", "--end-of-options", f"{obj_spec}^{{object}}"], allow_fail=True)
        if verify.returncode != 0:
            sys.stderr.write(f"secret_scan: not a git object: {obj_spec}\n")
            sys.exit(2)
        obj_oid = verify.stdout.decode("ascii", "strict").strip()
        peeled_tags, final_type, final_oid = peel_object(obj_oid)
        for t_oid, t_data in peeled_tags:
            tags[t_oid] = t_data
        if final_type == "commit":
            revs = run_git(["rev-list", final_oid]).stdout.decode("ascii", "strict").splitlines()
            commits = list(dict.fromkeys(r for r in revs if r))
        elif final_type == "tree":
            trees.add(final_oid)
        elif final_type == "blob":
            blobs.add(final_oid)
    elif sub == "range":
        spec = rest[0]
        revs = run_git(["rev-list", spec]).stdout.decode("ascii", "strict").splitlines()
        commits = list(dict.fromkeys(r for r in revs if r))
    else:
        fail(f"unknown objects submode {sub}", code=2)

    inline_chunks = []   # scanned with allow_inline=(not ignore_allow)
    strict_chunks = []   # binary direct tree/blob views scanned with allow_inline=False

    for t_oid, t_data in tags.items():
        inline_chunks.append((("tag", t_oid), t_data))

    if commits:
        commit_oids = [c.encode("ascii") for c in commits]
        for cid, (_t, cdata) in zip(commits, batch_cat_file(commit_oids, expect_type=b"commit")):
            inline_chunks.append((("commit", cid), cdata))

    if blobs:
        blob_list = sorted(blobs)
        for boid, (_t, bdata) in zip(blob_list, batch_cat_file([b.encode("ascii") for b in blob_list], expect_type=b"blob")):
            if needs_binary_pass(bdata):
                strict_chunks.extend(expand_binary_views(("blob", boid), bdata))
            else:
                inline_chunks.append((("blob_text", boid), bdata))

    tree_entries = []  # (tree_oid, path_str, blob_oid_bytes)
    for toid in sorted(trees):
        ls = run_git(["ls-tree", "-r", "-z", toid]).stdout
        for entry in ls.split(b"\0"):
            if not entry:
                continue
            head, sep, path_bytes = entry.partition(b"\t")
            if not sep:
                fail("git ls-tree output did not parse")
            parts = head.split(b" ")
            if len(parts) != 3:
                fail("git ls-tree header did not parse")
            _mode, etype, eoid = parts
            if etype == b"blob":
                tree_entries.append((toid, decode_path(path_bytes), eoid))
    if tree_entries:
        u_oids = list(dict.fromkeys(eoid for _, _, eoid in tree_entries))
        fetched = {oid: data for oid, (_t, data) in zip(u_oids, batch_cat_file(u_oids, expect_type=b"blob"))}
        for eoid, bdata in fetched.items():
            if needs_binary_pass(bdata):
                strict_chunks.extend(expand_binary_views(("tree_bin", eoid), bdata))
            else:
                inline_chunks.append((("tree_text", eoid), bdata))

    if inline_chunks:
        mapped, unmapped = run_bl_batch(inline_chunks, allow_inline=not ignore_allow)
        unmapped_findings.extend(unmapped)
        tree_hits = {}
        for key, rule, line in mapped:
            ktype, koid = key
            if ktype == "commit":
                raw_findings.append((koid, ".git/commit", rule, line, True, True))
            elif ktype == "tag":
                raw_findings.append((koid, ".git/tag", rule, line, True, True))
            elif ktype == "blob_text":
                raw_findings.append((koid, ".git/blob", rule, line, True, True))
            elif ktype == "tree_text":
                tree_hits.setdefault(koid, set()).add(("content", rule, line))
        for toid, pstr, eoid in tree_entries:
            for _view, rule, line in tree_hits.get(eoid, ()):
                raw_findings.append((toid, pstr, rule, line, False, True))

    if strict_chunks:
        mapped, unmapped = run_bl_batch(strict_chunks, allow_inline=False)
        unmapped_findings.extend(unmapped)
        tree_hits = {}
        for (inner_key, view), rule, line in mapped:
            ktype, koid = inner_key
            if ktype == "blob":
                loc = ".git/blob#png-text" if view == "png_text" else ".git/blob"
                raw_findings.append((koid, loc, rule, line, True, True))
            elif ktype == "tree_bin":
                tree_hits.setdefault(koid, set()).add((view, rule, line))
        for toid, pstr, eoid in tree_entries:
            for view, rule, line in tree_hits.get(eoid, ()):
                loc = f"{pstr}#png-text" if view == "png_text" else pstr
                raw_findings.append((toid, loc, rule, line, False, True))

elif kind == "symlink":
    target = args[0]
    try:
        link_bytes = os.fsencode(os.readlink(target))
    except OSError as error:
        fail(f"cannot read symlink ({error.strerror})")
    p = normalize_fs_path(target, git_top(required=False))
    mapped, unmapped = run_bl_batch([(0, link_bytes)], allow_inline=not ignore_allow)
    unmapped_findings.extend(unmapped)
    for _id, rule, line in mapped:
        raw_findings.append(("", p, rule, line, False, True))

elif kind == "message":
    target = args[0]
    try:
        with open(target, "rb") as handle:
            data = handle.read()
    except OSError as error:
        fail(f"cannot read message file ({error.strerror})", code=2)
    mapped, unmapped = run_bl_batch([(0, data)], allow_inline=not ignore_allow)
    unmapped_findings.extend(unmapped)
    for _id, rule, line in mapped:
        raw_findings.append(("", "<commit-message>", rule, line, False, False))

else:
    fail(f"unknown secondary scan kind {kind}", code=2)

ignores = load_ignores()
kept_lines = []
seen = set()
for commit, path, rule, line, oid_only, allow_ignore in sorted(raw_findings):
    if is_ignored(ignores, commit, path, rule, line, oid_only, allow_ignore):
        continue
    key = (commit, path, rule, line)
    if key in seen:
        continue
    seen.add(key)
    disp = escape_display_path(path)
    if commit:
        kept_lines.append(f"{rule} {disp}:{line} {commit}")
    else:
        kept_lines.append(f"{rule} {disp}:{line} ")
for rule, s_line in sorted(set(unmapped_findings)):
    kept_lines.append(f"{rule} <unmapped>:{s_line} ")

if kept_lines:
    with open(out_file, "w", encoding="utf-8") as fh:
        fh.write("\n".join(kept_lines) + "\n")
    sys.exit(1)
' "$config" "$work/sec-empty" "$work/sec-empty.ignore" "$ignore_path" "${SECRET_SCAN_IGNORE_ALLOW:-0}" "$out_file" "$work" "$@" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ -s "$out_file" ]; then
      echo "secret_scan: $label: betterleaks exited $rc" >&2
      redact_output <"$out_file" | sed 's/^/  /' >&2
      echo "secret_scan: values are redacted. For a false positive see 'Second scan: Betterleaks' in PRIVACY.md." >&2
    fi
    return "$rc"
  fi
}

case "$mode" in
  ignore-check)
    top=$(g rev-parse --show-toplevel)
    if [ "$2" = --index ]; then
      label="the index"
    else
      obj=$(g rev-parse --verify --quiet --end-of-options "$2^{object}") || {
        echo "secret_scan: not a git object: $2" >&2
        exit 2
      }
      label="the scanned object $(printf '%s' "$obj" | cut -c1-12)"
      # A blob (or a tag of one) has no tree, so no ignore file comes with it.
      tree=$(g rev-parse --verify --quiet "$obj^{tree}") || tree=
    fi
    rc_all=0
    for name in .betterleaksignore .gitleaksignore; do
      path="$top/$name"
      have=
      if [ -e "$path" ]; then
        # hash-object reads through a symlink, as Betterleaks does; a directory is unreadable.
        have=$(g hash-object --no-filters -- "$path") || {
          echo "secret_scan: cannot read $name in the working tree" >&2
          exit 2
        }
      fi
      if [ "$2" = --index ]; then
        want=$(g rev-parse --verify --quiet ":0:$name") || want=
      elif [ -n "$tree" ]; then
        want=$(g rev-parse --verify --quiet "$tree:$name") || want=
      else
        want=
      fi
      if [ "$have" != "$want" ]; then
        if [ -z "$want" ]; then
          what="exists in the working tree but not in $label"
        elif [ -z "$have" ]; then
          what="is in $label but missing from the working tree"
        else
          what="in the working tree differs from the version in $label"
        fi
        echo "secret_scan: $name $what. Betterleaks would apply the working-tree copy, not the exemptions the scanned content carries. Commit it, restore it, or move it away, then retry." >&2
        rc_all=1
      fi
    done
    exit "$rc_all"
    ;;
  staged)
    scan "staged changes" git --pre-commit --staged "$src"
    scan_secondary "content Betterleaks skips as binary" binary staged
    ;;
  unstaged)
    scan "unstaged changes" git --pre-commit .
    scan_secondary "content Betterleaks skips as binary" binary unstaged
    ;;
  message)
    scan_secondary "commit message" message "$2"
    ;;
  history)
    scan "history" git --log-opts="--full-history --all --diff-merges=first-parent" "$src"
    scan_secondary "content Betterleaks skips as binary" binary log --full-history --all
    scan_secondary "commit messages, tag objects, and trees or blobs refs point at" objects history
    ;;
  rev)
    obj=$(g rev-parse --verify --quiet --end-of-options "$2^{object}") || {
      echo "secret_scan: not a git object: $2" >&2
      exit 2
    }
    peeled_type=$(g cat-file -t "$obj")
    peel_cur=$obj
    peel_depth=0
    while [ "$peeled_type" = tag ]; do
      peel_cur=$(g cat-file tag "$peel_cur" | sed -n '1s/^object //p')
      peel_depth=$((peel_depth + 1))
      if [ -z "$peel_cur" ] || [ "$peel_depth" -gt 64 ]; then
        echo "secret_scan: malformed or too deeply nested tag object" >&2
        exit 2
      fi
      peeled_type=$(g cat-file -t "$peel_cur" 2>/dev/null) || {
        echo "secret_scan: cannot read object $peel_cur" >&2
        exit 2
      }
    done
    if [ "$peeled_type" = commit ]; then
      scan "candidate history" git --log-opts="--diff-merges=first-parent $peel_cur" "$src"
      scan_secondary "content Betterleaks skips as binary" binary log "$peel_cur"
    fi
    scan_secondary "candidate messages, tag objects, and tree or blob content" objects rev "$obj"
    ;;
  range)
    spec=$2
    count=$(g rev-list --count "$spec")
    if [ "$count" -gt 0 ]; then
      scan "branch commit range" git --log-opts="--diff-merges=first-parent $spec" "$src"
      scan_secondary "content Betterleaks skips as binary" binary log "$spec"
      scan_secondary "branch commit messages" objects range "$spec"
    fi
    ;;
  files)
    shift
    rc_all=0
    top=$(g rev-parse --show-toplevel 2>/dev/null || true)
    for target in "$@"; do
      if [ -L "$target" ]; then
        scan_secondary "symlink target" symlink "$target" || rc_all=1
      elif [ -f "$target" ]; then
        # Run dir mode first from the repository top with the normalized relative path so path-scoped
        # Betterleaks rules and .betterleaksignore paths align regardless of cwd or leading "./".
        # If dir mode passes (clean, or skipped because of a binary/sniffed head such as PDF/ELF/ZIP/PNG),
        # the secondary pass reads the file through stdin with exact line numbers, printable-byte
        # isolation, PNG text-chunk decoding, and stable per-file fingerprints.
        dir_cwd=.
        dir_target=$target
        if [ -n "$top" ]; then
          rel=$(python3 -I -B -c '
import os, sys
top = os.path.realpath(sys.argv[1])
target = sys.argv[2]
full = os.path.join(os.path.realpath(os.path.dirname(os.path.abspath(target))), os.path.basename(os.path.abspath(target)))
try:
    rel = os.path.relpath(full, top)
except ValueError:
    rel = ""
if rel and rel != "." and not rel.startswith(".." + os.sep) and rel != "..":
    sys.stdout.write(rel.replace(os.sep, "/"))
' "$top" "$target")
          if [ -n "$rel" ]; then
            dir_cwd=$top
            dir_target=$rel
          fi
        fi
        case "$dir_target" in
          -*) dir_target="./$dir_target" ;;
        esac
        if (cd "$dir_cwd" && scan "working-tree file" dir "$dir_target") &&
          scan_secondary "working-tree file" binary file "$target"; then
          :
        else
          rc_all=1
        fi
      else
        echo "secret_scan: unreadable or missing file: $target" >&2
        exit 2
      fi
    done
    exit "$rc_all"
    ;;
esac
