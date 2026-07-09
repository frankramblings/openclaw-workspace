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


import os  # noqa: E402 - intentionally scoped to this section (house style)
import stat  # noqa: E402 - intentionally scoped to this section (house style)


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


def test_secret_path_with_quote_is_shell_safe():
    # A secret path containing a single quote must not break/inject auth.cmd.
    toml = ec.render_gmail_account(
        email="m@gmail.com", display_name="M",
        secret_path="/home/o'reilly/.pw", is_default=True)
    d = tomllib.loads(toml)  # still valid TOML
    # the parsed auth.cmd is a valid POSIX command that cats the exact path
    cmd = d["accounts"]["gmail"]["backend"]["auth"]["cmd"]
    assert cmd == "cat '/home/o'\\''reilly/.pw'"


def test_add_account_secret_is_600_atomic(tmp_path):
    import os as _os
    import stat as _stat
    secret = tmp_path / ".pw"
    ec.add_account(provider="gmail", email="me@gmail.com", display_name="Me",
                   password="p w", config_path=tmp_path / "c.toml", secret_path=secret)
    assert _stat.S_IMODE(_os.stat(secret).st_mode) == 0o600
    assert secret.read_text() == "pw"
