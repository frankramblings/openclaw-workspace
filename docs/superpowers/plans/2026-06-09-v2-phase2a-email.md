# v2 Phase 2a — Email integration (generalize) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a new user configure email on their own account (Gmail app-password or generic IMAP) via `setup.sh --add-email`, instead of the email tab only working with the maintainer's hand-written himalaya config.

**Architecture:** A pure, unit-tested `backend/email_config.py` renders a himalaya `config.toml` account block (and writes the password to a mode-600 secret file read via a plain `cat`, so there's no TOML `\n`-escaping fragility). `scripts/setup.sh --add-email` collects inputs and calls it, then flips `integrations.email=true` in `connection.json`. The email backend is already account-agnostic (`_account_address()` reads the default account), so no backend change is needed.

**Tech Stack:** Python 3.11+ (`tomllib` to validate), pytest, bash, himalaya.

**Spec:** `docs/superpowers/specs/2026-06-09-v2-phase2-generalized-integrations-design.md` (§2a)

**SAFETY:** Tests and verification MUST use a temp `HIMALAYA_CONFIG` path — NEVER touch the maintainer's real `~/.config/himalaya/config.toml`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/email_config.py` | pure TOML renderers + default detection + `add_account` file-writer | Create |
| `backend/tests/test_email_config.py` | unit tests (renderers, default logic, add_account I/O) | Create |
| `scripts/setup.sh` | `--add-email` subcommand + flags | Modify |
| `README.md`, `.env.example` | "Optional integrations → Email" docs | Modify |

---

## Task 1: `email_config.py` — pure renderers + default detection

**Files:**
- Create: `backend/email_config.py`
- Test: `backend/tests/test_email_config.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_email_config.py
"""himalaya account-block rendering + default detection (pure, no I/O)."""
import tomllib

from backend import email_config as ec


def test_gmail_block_has_gmail_hosts_and_save_copy_false():
    toml = ec.render_gmail_account(
        email="me@gmail.com", display_name="Me", secret_path="/s/pw", is_default=True)
    assert 'backend.host = "imap.gmail.com"' in toml
    assert 'message.send.backend.host = "smtp.gmail.com"' in toml
    assert "message.send.save-copy = false" in toml   # Gmail auto-files Sent
    assert 'backend.auth.cmd = "cat \'/s/pw\'"' in toml
    assert "default = true" in toml
    tomllib.loads(toml)  # valid TOML


def test_imap_block_uses_given_hosts_and_save_copy_true():
    toml = ec.render_imap_account(
        account_id="mail", email="u@corp.example", display_name="U",
        secret_path="/s/pw", imap_host="imap.corp.example", imap_port=993,
        smtp_host="smtp.corp.example", smtp_port=465, is_default=False)
    assert 'backend.host = "imap.corp.example"' in toml
    assert 'message.send.backend.host = "smtp.corp.example"' in toml
    assert "message.send.save-copy = true" in toml    # generic server won't auto-file
    assert "default = true" not in toml               # is_default False
    assert "[accounts.mail]" in toml
    tomllib.loads(toml)


def test_toml_string_escaping():
    toml = ec.render_imap_account(
        account_id="mail", email='a"b@x.example', display_name='Te"st',
        secret_path="/s/pw", imap_host="h", imap_port=993,
        smtp_host="h", smtp_port=465, is_default=True)
    d = tomllib.loads(toml)  # must still parse despite the quote
    assert d["accounts"]["mail"]["display-name"] == 'Te"st'


def test_has_default_account():
    base = ec.render_gmail_account(email="m@gmail.com", display_name="M",
                                   secret_path="/s/pw", is_default=True)
    assert ec.has_default_account(base) is True
    nodef = ec.render_imap_account(
        account_id="mail", email="u@x.example", display_name="U",
        secret_path="/s/pw", imap_host="h", imap_port=993,
        smtp_host="h", smtp_port=465, is_default=False)
    assert ec.has_default_account(nodef) is False
    assert ec.has_default_account("") is False
    assert ec.has_default_account("not valid toml {{{") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_email_config.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.email_config'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/email_config.py
"""Generate a himalaya `config.toml` account block for a new email account, and
add it (with a mode-600 secret file) without disturbing existing accounts.

The password is stored in a separate secret file read via `cat` — the password
itself never lands in config.toml, and we avoid the `tr -d ' \\n'` / TOML escape
fragility by stripping whitespace at write time."""
from __future__ import annotations

import tomllib
from pathlib import Path

GMAIL = {"imap_host": "imap.gmail.com", "imap_port": 993,
         "smtp_host": "smtp.gmail.com", "smtp_port": 465}


def _s(value: str) -> str:
    """TOML basic-string escape (backslash + double-quote)."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _render(*, account_id, email, display_name, secret_path, imap_host, imap_port,
            smtp_host, smtp_port, is_default, save_copy) -> str:
    cat = f"cat '{secret_path}'"
    lines = [f"[accounts.{account_id}]"]
    if is_default:
        lines.append("default = true")
    lines += [
        f'email = "{_s(email)}"',
        f'display-name = "{_s(display_name)}"',
        "",
        'backend.type = "imap"',
        f'backend.host = "{_s(imap_host)}"',
        f"backend.port = {int(imap_port)}",
        'backend.encryption.type = "tls"',
        f'backend.login = "{_s(email)}"',
        'backend.auth.type = "password"',
        f'backend.auth.cmd = "{_s(cat)}"',
        "",
        f"message.send.save-copy = {'true' if save_copy else 'false'}",
        "",
        'message.send.backend.type = "smtp"',
        f'message.send.backend.host = "{_s(smtp_host)}"',
        f"message.send.backend.port = {int(smtp_port)}",
        'message.send.backend.encryption.type = "tls"',
        f'message.send.backend.login = "{_s(email)}"',
        'message.send.backend.auth.type = "password"',
        f'message.send.backend.auth.cmd = "{_s(cat)}"',
    ]
    return "\n".join(lines) + "\n"


def render_gmail_account(*, email, display_name, secret_path, is_default) -> str:
    return _render(account_id="gmail", email=email, display_name=display_name,
                   secret_path=secret_path, is_default=is_default, save_copy=False,
                   **GMAIL)


def render_imap_account(*, account_id, email, display_name, secret_path, imap_host,
                        imap_port, smtp_host, smtp_port, is_default) -> str:
    return _render(account_id=account_id, email=email, display_name=display_name,
                   secret_path=secret_path, imap_host=imap_host, imap_port=imap_port,
                   smtp_host=smtp_host, smtp_port=smtp_port, is_default=is_default,
                   save_copy=True)


def has_default_account(config_text: str) -> bool:
    """True if the existing config already has an account with default=true."""
    try:
        cfg = tomllib.loads(config_text)
    except (tomllib.TOMLDecodeError, ValueError):
        return False
    return any(a.get("default") for a in (cfg.get("accounts") or {}).values())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_email_config.py -q`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/email_config.py backend/tests/test_email_config.py
git commit -m "feat(email): pure himalaya account-block renderers + default detection"
```

---

## Task 2: `email_config.add_account` — write secret + merge config

**Files:**
- Modify: `backend/email_config.py` (add `add_account`)
- Test: `backend/tests/test_email_config.py` (add cases)

- [ ] **Step 1: Write the failing test (append to the file)**

```python
import os
import stat


def test_add_account_fresh_is_default(tmp_path):
    cfg = tmp_path / "config.toml"
    secret = tmp_path / ".pw"
    out = ec.add_account(provider="gmail", email="me@gmail.com", display_name="Me",
                         password="abcd efgh ijkl mnop", config_path=cfg,
                         secret_path=secret)
    assert out["is_default"] is True and out["account_id"] == "gmail"
    text = cfg.read_text()
    assert ec.has_default_account(text) is True
    # secret stripped of whitespace, no trailing newline, mode 600
    assert secret.read_text() == "abcdefghijklmnop"
    assert stat.S_IMODE(os.stat(secret).st_mode) == 0o600


def test_add_account_second_does_not_steal_default(tmp_path):
    cfg = tmp_path / "config.toml"
    secret = tmp_path / ".pw"
    ec.add_account(provider="gmail", email="me@gmail.com", display_name="Me",
                   password="pw1", config_path=cfg, secret_path=secret)
    out2 = ec.add_account(provider="imap", email="u@corp.example", display_name="U",
                          password="pw2", config_path=cfg, secret_path=tmp_path / ".pw2",
                          imap_host="imap.corp.example", smtp_host="smtp.corp.example")
    assert out2["is_default"] is False
    cfg_d = tomllib.loads(cfg.read_text())
    # original gmail account still the default; both accounts present
    assert cfg_d["accounts"]["gmail"]["default"] is True
    assert "u@corp.example" in cfg.read_text()


def test_add_account_imap_requires_hosts(tmp_path):
    import pytest
    with pytest.raises(ValueError):
        ec.add_account(provider="imap", email="u@x.example", display_name="U",
                       password="pw", config_path=tmp_path / "c.toml",
                       secret_path=tmp_path / ".pw")  # no imap_host
```

(Add `import tomllib` is already at the top of the test file.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `.venv/bin/python -m pytest backend/tests/test_email_config.py -q`
Expected: FAIL — `AttributeError: module 'backend.email_config' has no attribute 'add_account'`

- [ ] **Step 3: Implement `add_account` in `backend/email_config.py`**

```python
import os
import re


def _slug(email: str) -> str:
    local = email.split("@", 1)[0]
    s = re.sub(r"[^a-z0-9]+", "", local.lower())
    return s or "mail"


def add_account(*, provider, email, display_name, password, config_path,
                secret_path, imap_host=None, imap_port=993, smtp_host=None,
                smtp_port=465):
    """Write the password to a 600 secret file and append a himalaya account
    block to config_path. Returns {account_id, is_default, address}. Never steals
    `default` from an existing account. provider is 'gmail' or 'imap'."""
    config_path = Path(config_path)
    secret_path = Path(secret_path)
    if provider == "imap" and not (imap_host and smtp_host):
        raise ValueError("imap provider requires imap_host and smtp_host")

    # 1. secret file: strip ALL whitespace (Gmail app-passwords show with spaces),
    #    no trailing newline, mode 600.
    secret_path.parent.mkdir(parents=True, exist_ok=True)
    secret_clean = "".join(password.split())
    secret_path.write_text(secret_clean)
    os.chmod(secret_path, 0o600)

    # 2. decide default + render block
    existing = config_path.read_text() if config_path.exists() else ""
    is_default = not has_default_account(existing)
    if provider == "gmail":
        account_id = "gmail"
        block = render_gmail_account(email=email, display_name=display_name,
                                     secret_path=str(secret_path), is_default=is_default)
    else:
        account_id = _slug(email)
        block = render_imap_account(account_id=account_id, email=email,
                                    display_name=display_name,
                                    secret_path=str(secret_path), imap_host=imap_host,
                                    imap_port=imap_port, smtp_host=smtp_host,
                                    smtp_port=smtp_port, is_default=is_default)

    # 3. append (one blank line between blocks)
    sep = "" if not existing else ("\n" if existing.endswith("\n") else "\n\n")
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(existing + sep + block)
    return {"account_id": account_id, "is_default": is_default, "address": email}
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest backend/tests/test_email_config.py -q`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/email_config.py backend/tests/test_email_config.py
git commit -m "feat(email): add_account writes 600 secret + merges himalaya config"
```

---

## Task 3: `scripts/setup.sh --add-email`

**Files:**
- Modify: `scripts/setup.sh`

- [ ] **Step 1: Add the `--add-email` mode + flags**

In the flag-var init block, add: `ADD_EMAIL=0`, `EMAIL_PROVIDER=""`, `EMAIL_ADDRESS=""`, `EMAIL_NAME=""`, `IMAP_HOST=""`, `IMAP_PORT="993"`, `SMTP_HOST=""`, `SMTP_PORT="465"`. (The password is read into a local, never a flag — see below.)

In the `case` parser add:
```sh
    --add-email)       ADD_EMAIL=1; shift ;;
    --email-provider)  EMAIL_PROVIDER="${2:-}"; shift 2 ;;
    --email-address)   EMAIL_ADDRESS="${2:-}"; shift 2 ;;
    --email-name)      EMAIL_NAME="${2:-}"; shift 2 ;;
    --imap-host)       IMAP_HOST="${2:-}"; shift 2 ;;
    --imap-port)       IMAP_PORT="${2:-}"; shift 2 ;;
    --smtp-host)       SMTP_HOST="${2:-}"; shift 2 ;;
    --smtp-port)       SMTP_PORT="${2:-}"; shift 2 ;;
```
Add these to the `--help` block too (a short "Email setup" group).

Right AFTER the arg parse loop (before the name/accent flow), add the standalone email mode that runs and exits:
```sh
if [[ "$ADD_EMAIL" == 1 ]]; then
  HIMA_CFG="${HIMALAYA_CONFIG:-$HOME/.config/himalaya/config.toml}"
  SECRET_DIR="$(dirname "$HIMA_CFG")"
  # provider
  if [[ -z "$EMAIL_PROVIDER" ]]; then
    printf "  Email provider [gmail/imap]: "; read -r EMAIL_PROVIDER || true
  fi
  [[ "$EMAIL_PROVIDER" == "gmail" || "$EMAIL_PROVIDER" == "imap" ]] \
    || { echo "provider must be 'gmail' or 'imap'" >&2; exit 1; }
  if [[ -z "$EMAIL_ADDRESS" ]]; then
    printf "  Email address: "; read -r EMAIL_ADDRESS || true
  fi
  EMAIL_NAME="${EMAIL_NAME:-$EMAIL_ADDRESS}"
  if [[ "$EMAIL_PROVIDER" == "imap" ]]; then
    [[ -n "$IMAP_HOST" ]] || { printf "  IMAP host: "; read -r IMAP_HOST || true; }
    [[ -n "$SMTP_HOST" ]] || { printf "  SMTP host: "; read -r SMTP_HOST || true; }
  fi
  # password via env (not argv → not visible in ps); prompt hidden if interactive
  if [[ -z "${EMAIL_PW:-}" ]]; then
    printf "  App password (input hidden): "; read -rs EMAIL_PW || true; echo
  fi
  SECRET_PATH="$SECRET_DIR/.workspace-email-secret"
  EMAIL_PW="$EMAIL_PW" python3 - "$ROOT" "$EMAIL_PROVIDER" "$EMAIL_ADDRESS" \
      "$EMAIL_NAME" "$HIMA_CFG" "$SECRET_PATH" "$IMAP_HOST" "$IMAP_PORT" \
      "$SMTP_HOST" "$SMTP_PORT" <<'PY'
import os, sys
sys.path.insert(0, sys.argv[1])
from backend import email_config
prov, addr, name, cfg, secret, ih, ip, sh, sp = sys.argv[2:11]
out = email_config.add_account(
    provider=prov, email=addr, display_name=name, password=os.environ["EMAIL_PW"],
    config_path=cfg, secret_path=secret,
    imap_host=ih or None, imap_port=int(ip or 993),
    smtp_host=sh or None, smtp_port=int(sp or 465))
print(f"  wrote account '{out['account_id']}' (default={out['is_default']}) to {cfg}")
PY
  # enable the integration
  python3 - "$DATA_DIR/connection.json" <<'PY'
import json, sys
path = sys.argv[1]
try: data = json.load(open(path))
except Exception: data = {}
data.setdefault("integrations", {})["email"] = True
import os; os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(data, open(path, "w"), indent=2); open(path, "a").write("\n")
PY
  echo "  ✓ email enabled. Restart the workspace to pick up the new account."
  exit 0
fi
```

- [ ] **Step 2: Syntax check**

Run: `bash -n scripts/setup.sh && echo ok`
Expected: `ok`

- [ ] **Step 3: Verify NON-interactively against a TEMP config (never touch real himalaya)**

Run:
```bash
T=$(mktemp -d)
EMAIL_PW="test pass word" HIMALAYA_CONFIG="$T/config.toml" \
  scripts/setup.sh --add-email --email-provider gmail \
  --email-address me@gmail.com --email-name "Me"
echo "--- config.toml ---"; cat "$T/config.toml"
echo "--- secret (mode) ---"; ls -l "$T/.workspace-email-secret"
echo "--- secret content ---"; cat "$T/.workspace-email-secret"; echo
python3 -c "import tomllib,sys; d=tomllib.load(open('$T/config.toml','rb')); print('default acct:', [k for k,v in d['accounts'].items() if v.get('default')])"
echo "--- connection.json ---"; cat .data/connection.json
rm -rf "$T"; rm -f .data/connection.json
```
Expected: config.toml has `[accounts.gmail]` with `default = true`, imap.gmail.com, `message.send.save-copy = false`; the secret file is mode `-rw-------` and contains `testpassword` (whitespace stripped, no newline); `.data/connection.json` has `"email": true`. (Then it's cleaned up — `.data/` is gitignored anyway.)

- [ ] **Step 4: Verify the IMAP path + that a second account does not steal default**

Run:
```bash
T=$(mktemp -d)
EMAIL_PW=pw1 HIMALAYA_CONFIG="$T/config.toml" scripts/setup.sh --add-email \
  --email-provider gmail --email-address me@gmail.com --email-name Me >/dev/null
EMAIL_PW=pw2 HIMALAYA_CONFIG="$T/config.toml" scripts/setup.sh --add-email \
  --email-provider imap --email-address u@corp.example --email-name U \
  --imap-host imap.corp.example --smtp-host smtp.corp.example >/dev/null
python3 -c "import tomllib; d=tomllib.load(open('$T/config.toml','rb')); print('accounts:', list(d['accounts'])); print('default:', [k for k,v in d['accounts'].items() if v.get('default')])"
rm -rf "$T"; rm -f .data/connection.json
```
Expected: `accounts: ['gmail', 'ucorpexample']` (or similar slug); `default: ['gmail']` only.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup.sh
git commit -m "feat(setup): --add-email configures a Gmail/IMAP himalaya account"
```

---

## Task 4: Docs

**Files:**
- Modify: `README.md`, `.env.example`

- [ ] **Step 1: README — add an "Optional integrations" subsection**

In `README.md`, after the "## Connecting to your OpenClaw" section, add:

```markdown
## Optional integrations

Tabs that need your own accounts are off until you configure them; until then
they're hidden (the backend reports them via `/api/capabilities`).

### Email

```bash
scripts/setup.sh --add-email          # interactive (Gmail app-password or IMAP)
```

For Gmail, create an **App Password** (Google Account → Security → App passwords)
and paste it when prompted — it's stored in a mode-600 file next to your himalaya
config, never in this repo. For other providers choose `imap` and enter your
IMAP/SMTP hosts. Restart the workspace afterward to pick up the account.
```

- [ ] **Step 2: `.env.example` — note the new files**

In `.env.example`, under the Email section, add a comment:
```
# Email is configured via `scripts/setup.sh --add-email` (writes a himalaya
# config.toml account + a mode-600 secret file). HIMALAYA_CONFIG overrides the
# config path (used by tests). WORKSPACE_EMAIL_ADDRESS overrides the From address.
```

- [ ] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs(email): document setup.sh --add-email + the secret model"
```

---

## Final verification (after all tasks)

- [ ] Full suite green: `.venv/bin/python -m pytest backend/tests -q` (expect prior count + 7).
- [ ] `bash -n scripts/setup.sh` clean; `scripts/setup.sh --help` shows the email flags.
- [ ] Re-run Task 3 Step 3 against a temp config → all assertions hold; confirm the maintainer's real `~/.config/himalaya/config.toml` is UNTOUCHED (`git`-irrelevant; just don't point at it).
- [ ] Capability check still passes: with the temp config + `integrations.email=true`, `backend.capabilities._email()` would report available (himalaya binary present on this host).
