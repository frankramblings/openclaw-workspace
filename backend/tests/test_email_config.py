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
