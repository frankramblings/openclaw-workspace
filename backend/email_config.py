"""Generate a himalaya `config.toml` account block for a new email account, and
add it (with a mode-600 secret file) without disturbing existing accounts.

The password is stored in a separate secret file read via `cat` — the password
itself never lands in config.toml, and we avoid the `tr -d ' \\n'` / TOML escape
fragility by stripping whitespace at write time."""
from __future__ import annotations

import os
import re
import tomllib
from pathlib import Path

GMAIL = {"imap_host": "imap.gmail.com", "imap_port": 993,
         "smtp_host": "smtp.gmail.com", "smtp_port": 465}


def _s(value: str) -> str:
    """TOML basic-string escape (backslash + double-quote)."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _shq(value: str) -> str:
    """POSIX single-quote a value for safe embedding in a shell command (so a
    secret path containing e.g. a quote can't break/inject the `auth.cmd`)."""
    return "'" + str(value).replace("'", "'\\''") + "'"


def _render(*, account_id, email, display_name, secret_path, imap_host, imap_port,
            smtp_host, smtp_port, is_default, save_copy) -> str:
    cat = f"cat {_shq(secret_path)}"
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
    #    no trailing newline. Create mode-600 ATOMICALLY (O_CREAT|O_EXCL-free but
    #    opened with 0o600 so the password is never briefly world/group-readable).
    secret_path.parent.mkdir(parents=True, exist_ok=True)
    secret_clean = "".join(password.split())
    fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, secret_clean.encode())
    finally:
        os.close(fd)
    os.chmod(secret_path, 0o600)  # enforce 600 even if the file pre-existed

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
