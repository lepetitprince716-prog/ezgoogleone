# Privacy & Secret Hygiene

This repository is public, and so is every commit in its history. It holds generic CLI drivers,
portable agent skills, and synthetic unit tests. It never holds personal data, machine names,
account identifiers, credentials, cookies, or live account dumps.

## What Never Goes In

- API keys, OAuth tokens, cookies, browser profiles, or `.env` files.
- Personal home paths (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`), LAN/CGNAT IPs, MAC addresses, or private hostnames.
- Emails or personal handles other than GitHub noreply commit identities.
- Live session outputs, usage ledgers, or private account state (all runtime state lives under XDG directories outside the repository).

## Local & CI Guards

1. **Local Git hooks** (`.githooks/pre-commit`, `commit-msg`, `pre-push`):
   Enable once per clone:
   ```bash
   git config core.hooksPath .githooks
   ```
   Every commit and push runs `tools/privacy_scan.py` (standard-library regex & metadata scanner) and `tools/secret_scan.sh` (Betterleaks with `--redact` and fail-closed checks).
2. **CI workflows** (`.github/workflows/privacy.yml`):
   On every push and pull request, CI runs `privacy_scan.py` over tracked files and full history plus Betterleaks over git history using the trusted base branch scanner on pull requests.
3. **Runtime safety**:
   - Browser drivers (`aistudio`, `gemini-web`) never log Google account labels or emails and never type credentials.
   - `gemini-api` reads `GEMINI_API_KEY` from the environment or a user-managed config file outside the repo, and never echoes key values.
