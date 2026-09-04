import json

from backend import config


def test_user_name_precedence(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BRANDING_PATH", tmp_path / "branding.json")
    monkeypatch.delenv("WORKSPACE_USER_NAME", raising=False)
    assert config.user_name() == "the user"
    (tmp_path / "branding.json").write_text(json.dumps({"user_name": "Frank"}))
    assert config.user_name() == "Frank"
    monkeypatch.setenv("WORKSPACE_USER_NAME", "  Marissa ")
    assert config.user_name() == "Marissa"
    monkeypatch.setenv("WORKSPACE_USER_NAME", "   ")
    assert config.user_name() == "Frank"


def test_local_host_precedence(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BRANDING_PATH", tmp_path / "branding.json")
    monkeypatch.delenv("WORKSPACE_LOCAL_HOST", raising=False)
    assert config.local_host() == config.DEFAULT_LOCAL_HOST
    (tmp_path / "branding.json").write_text(json.dumps({"local_host": "10.0.0.5"}))
    assert config.local_host() == "10.0.0.5"
    monkeypatch.setenv("WORKSPACE_LOCAL_HOST", "kamino.local")
    assert config.local_host() == "kamino.local"
