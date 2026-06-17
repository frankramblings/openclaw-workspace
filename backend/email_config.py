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
