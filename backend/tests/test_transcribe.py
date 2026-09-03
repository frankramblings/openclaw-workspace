"""Tests for backend.transcribe module: OpenAI Whisper API integration."""
from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from backend import config, transcribe
from backend.app import app

pytest_plugins = ("pytest_asyncio",)


@pytest.fixture
def mock_data_dir(tmp_path, monkeypatch):
    """Point DATA_DIR to a temp directory for isolation."""
    test_data_dir = tmp_path / "data"
    monkeypatch.setattr(config, "DATA_DIR", test_data_dir)
    return test_data_dir


@pytest.fixture
def client(mock_data_dir):
    """FastAPI TestClient for endpoint testing."""
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture(autouse=True)
def _no_local_stt(monkeypatch):
    """Default every test to the key-only world: the module constant
    _KAMINO_STT is read at import from GARY_STT_BASE and defaults to the real
    kamino host, so without this the OpenAI-path tests would try the network
    and the key-only assertions would be false. Tests that exercise the local
    path opt in with `local_stt`."""
    monkeypatch.setattr(transcribe, "_KAMINO_STT", "")


LOCAL_BASE = "http://stt.test:9000"


@pytest.fixture
def local_stt(monkeypatch):
    """Point the local Whisper path at a fake base (never a real host)."""
    monkeypatch.setattr(transcribe, "_KAMINO_STT", LOCAL_BASE)
    return LOCAL_BASE


def _write_config(tmp_path, monkeypatch, key=None):
    """Write an openclaw.json with (or without) the OpenAI Whisper key and
    point config at it. Returns the path."""
    config_file = tmp_path / "openclaw.json"
    payload = {}
    if key is not None:
        payload = {"skills": {"entries": {"openai-whisper-api": {"apiKey": key}}}}
    config_file.write_text(json.dumps(payload))
    monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
    config._openclaw_json.cache_clear()
    return config_file


def _mock_client(*responses):
    """An httpx.AsyncClient stand-in whose post() returns the given responses
    in order (a single response repeats). Each response is a MagicMock with
    status_code and json()."""
    mock_client = mock.AsyncMock()
    if len(responses) == 1:
        mock_client.post = mock.AsyncMock(return_value=responses[0])
    else:
        mock_client.post = mock.AsyncMock(side_effect=list(responses))
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__ = mock.AsyncMock(return_value=None)
    return mock_client


def _response(status_code, payload=None):
    resp = mock.MagicMock()
    resp.status_code = status_code
    resp.json = mock.MagicMock(return_value=payload if payload is not None else {})
    return resp


class TestSupported:
    """Test the supported() check."""

    def test_supported_with_key(self, monkeypatch, tmp_path):
        """supported() returns True when OpenAI key is configured."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key-12345"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        # Clear the cache
        config._openclaw_json.cache_clear()

        assert transcribe.supported() is True

    def test_supported_without_key(self, monkeypatch, tmp_path):
        """supported() returns False when OpenAI key is missing."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({}))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        assert transcribe.supported() is False

    def test_supported_empty_key(self, monkeypatch, tmp_path):
        """supported() returns False when OpenAI key is empty."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": ""
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        assert transcribe.supported() is False

    def test_supported_local_base_only(self, monkeypatch, tmp_path, local_stt):
        """supported() is True with a local STT base and no OpenAI key."""
        _write_config(tmp_path, monkeypatch, key=None)

        assert transcribe.supported() is True


class TestTranscribe:
    """Test the transcribe() function."""

    @pytest.mark.asyncio
    async def test_transcribe_happy_path(self, monkeypatch, tmp_path):
        """transcribe() posts to OpenAI and returns text."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        # Mock httpx.AsyncClient
        mock_response = mock.MagicMock()
        mock_response.status_code = 200
        mock_response.json = mock.MagicMock(return_value={"text": "hello world"})

        mock_client = mock.AsyncMock()
        mock_client.post = mock.AsyncMock(return_value=mock_response)
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__ = mock.AsyncMock(return_value=None)

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            text = await transcribe.transcribe("test.webm", "audio/webm", b"fake audio data")

        assert text == "hello world"
        mock_client.post.assert_called_once()

    @pytest.mark.asyncio
    async def test_transcribe_model_fallback(self, monkeypatch, tmp_path):
        """transcribe() falls back from gpt-4o-mini-transcribe to whisper-1 on 404."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        # Mock responses: first call returns 404, second returns 200
        response_404 = mock.MagicMock()
        response_404.status_code = 404

        response_200 = mock.MagicMock()
        response_200.status_code = 200
        response_200.json = mock.MagicMock(return_value={"text": "transcribed text"})

        mock_client = mock.AsyncMock()
        mock_client.post = mock.AsyncMock(side_effect=[response_404, response_200])
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__ = mock.AsyncMock(return_value=None)

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            text = await transcribe.transcribe("test.webm", "audio/webm", b"fake audio data")

        assert text == "transcribed text"
        assert mock_client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_transcribe_no_key(self, monkeypatch, tmp_path):
        """transcribe() raises TranscribeError when key is missing."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({}))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        with pytest.raises(
            transcribe.TranscribeError,
            match=r"transcription not supported \(no local STT or OpenAI key\)",
        ):
            await transcribe.transcribe("test.webm", "audio/webm", b"fake audio data")

    @pytest.mark.asyncio
    async def test_transcribe_upstream_500(self, monkeypatch, tmp_path):
        """transcribe() raises TranscribeError on upstream 500."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        mock_response = mock.AsyncMock()
        mock_response.status_code = 500

        mock_client = mock.AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = None

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(transcribe.TranscribeError, match="upstream error"):
                await transcribe.transcribe("test.webm", "audio/webm", b"fake audio data")

    @pytest.mark.asyncio
    async def test_transcribe_timeout(self, monkeypatch, tmp_path):
        """transcribe() raises TranscribeError on timeout."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        mock_client = mock.AsyncMock()
        mock_client.post = mock.AsyncMock(side_effect=Exception("Timeout"))
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__ = mock.AsyncMock(return_value=None)

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(transcribe.TranscribeError):
                await transcribe.transcribe("test.webm", "audio/webm", b"fake audio data")

    @pytest.mark.asyncio
    async def test_transcribe_local_success_skips_openai(self, monkeypatch, tmp_path, local_stt):
        """A successful local transcription returns without calling OpenAI,
        even when a key is configured."""
        _write_config(tmp_path, monkeypatch, key="sk-test-key")
        mock_client = _mock_client(_response(200, {"text": " local text "}))

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            text = await transcribe.transcribe("clip.m4a", "audio/mp4", b"fake audio data")

        assert text == "local text"
        mock_client.post.assert_called_once()
        url = mock_client.post.call_args.args[0]
        assert url.startswith(LOCAL_BASE + "/asr")
        assert "audio_file" in mock_client.post.call_args.kwargs["files"]
        assert "headers" not in mock_client.post.call_args.kwargs

    @pytest.mark.asyncio
    async def test_transcribe_local_failure_falls_back_to_openai(self, monkeypatch, tmp_path, local_stt):
        """A local HTTP error falls back to OpenAI when a key exists."""
        _write_config(tmp_path, monkeypatch, key="sk-test-key")
        mock_client = _mock_client(_response(500), _response(200, {"text": "cloud text"}))

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            text = await transcribe.transcribe("clip.m4a", "audio/mp4", b"fake audio data")

        assert text == "cloud text"
        assert mock_client.post.call_count == 2
        first_url = mock_client.post.call_args_list[0].args[0]
        second_url = mock_client.post.call_args_list[1].args[0]
        assert first_url.startswith(LOCAL_BASE + "/asr")
        assert second_url == "https://api.openai.com/v1/audio/transcriptions"
        assert mock_client.post.call_args_list[1].kwargs["headers"] == {"Authorization": "Bearer sk-test-key"}

    @pytest.mark.asyncio
    async def test_transcribe_local_empty_text_falls_back_to_openai(self, monkeypatch, tmp_path, local_stt):
        """A local 200 with empty text is treated as a miss and falls back."""
        _write_config(tmp_path, monkeypatch, key="sk-test-key")
        mock_client = _mock_client(_response(200, {"text": ""}), _response(200, {"text": "cloud text"}))

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            text = await transcribe.transcribe("clip.m4a", "audio/mp4", b"fake audio data")

        assert text == "cloud text"
        assert mock_client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_transcribe_local_failure_without_key_raises(self, monkeypatch, tmp_path, local_stt):
        """Local failure with no OpenAI key raises the not-supported error
        (and never posts to OpenAI)."""
        _write_config(tmp_path, monkeypatch, key=None)
        mock_client = _mock_client(_response(503))

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(
                transcribe.TranscribeError,
                match=r"transcription not supported \(no local STT or OpenAI key\)",
            ):
                await transcribe.transcribe("clip.m4a", "audio/mp4", b"fake audio data")

        mock_client.post.assert_called_once()
        assert mock_client.post.call_args.args[0].startswith(LOCAL_BASE + "/asr")


class TestTranscribeEndpoints:
    """Test the HTTP routes."""

    def test_status_endpoint_supported(self, client, monkeypatch, tmp_path):
        """GET /api/transcribe/status returns supported=true when key exists."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        response = client.get("/api/transcribe/status")
        assert response.status_code == 200
        assert response.json() == {"supported": True}

    def test_status_endpoint_unsupported(self, client, monkeypatch, tmp_path):
        """GET /api/transcribe/status returns supported=false when key missing."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({}))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        response = client.get("/api/transcribe/status")
        assert response.status_code == 200
        assert response.json() == {"supported": False}

    def test_transcribe_no_file(self, client, monkeypatch, tmp_path):
        """POST /api/transcribe with no file returns 400."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        response = client.post("/api/transcribe")
        assert response.status_code == 400
        assert "no file" in response.json()["error"]

    def test_transcribe_empty_file(self, client, monkeypatch, tmp_path):
        """POST /api/transcribe with empty file returns 400."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        response = client.post("/api/transcribe", files={"audio": ("test.wav", b"")})
        assert response.status_code == 400
        assert "empty" in response.json()["error"]

    def test_transcribe_oversized_file(self, client, monkeypatch, tmp_path):
        """POST /api/transcribe with file > 25 MB returns 413."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        # Create a file > 25 MB
        oversized_data = b"x" * (26 * 1024 * 1024)
        response = client.post("/api/transcribe", files={"audio": ("test.wav", oversized_data)})
        assert response.status_code == 413
        assert "large" in response.json()["error"]

    def test_transcribe_unsupported(self, client, monkeypatch, tmp_path):
        """POST /api/transcribe returns 503 when transcription not supported."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({}))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        response = client.post("/api/transcribe", files={"audio": ("test.wav", b"fake audio")})
        assert response.status_code == 503
        assert "not supported" in response.json()["error"]

    def test_transcribe_happy_path(self, client, monkeypatch, tmp_path):
        """POST /api/transcribe successfully transcribes audio."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        # Mock httpx.AsyncClient
        mock_response = mock.MagicMock()
        mock_response.status_code = 200
        mock_response.json = mock.MagicMock(return_value={"text": "transcribed text"})

        mock_client = mock.AsyncMock()
        mock_client.post = mock.AsyncMock(return_value=mock_response)
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__ = mock.AsyncMock(return_value=None)

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            response = client.post("/api/transcribe", files={"audio": ("test.wav", b"fake audio")})

        assert response.status_code == 200
        assert response.json() == {"text": "transcribed text"}

    def test_transcribe_upstream_failure(self, client, monkeypatch, tmp_path):
        """POST /api/transcribe returns 502 on upstream failure."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-key"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        # Mock httpx.AsyncClient
        mock_response = mock.MagicMock()
        mock_response.status_code = 500

        mock_client = mock.AsyncMock()
        mock_client.post = mock.AsyncMock(return_value=mock_response)
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__ = mock.AsyncMock(return_value=None)

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            response = client.post("/api/transcribe", files={"audio": ("test.wav", b"fake audio")})

        assert response.status_code == 502
        assert "failed" in response.json()["error"]

    def test_transcribe_key_never_leaked(self, client, monkeypatch, tmp_path):
        """POST /api/transcribe never leaks the OpenAI key in responses or logs."""
        config_file = tmp_path / "openclaw.json"
        config_file.write_text(json.dumps({
            "skills": {
                "entries": {
                    "openai-whisper-api": {
                        "apiKey": "sk-test-secret-key-12345"
                    }
                }
            }
        }))
        monkeypatch.setattr(config, "OPENCLAW_CONFIG", config_file)
        config._openclaw_json.cache_clear()

        # Mock httpx.AsyncClient
        mock_response = mock.MagicMock()
        mock_response.status_code = 500

        mock_client = mock.AsyncMock()
        mock_client.post = mock.AsyncMock(return_value=mock_response)
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__ = mock.AsyncMock(return_value=None)

        with mock.patch("backend.transcribe.httpx.AsyncClient", return_value=mock_client):
            response = client.post("/api/transcribe", files={"audio": ("test.wav", b"fake audio")})

        response_text = response.json()
        assert "sk-test-secret-key" not in str(response_text)
        assert response.status_code == 502

    def test_status_endpoint_supported_local_only(self, client, monkeypatch, tmp_path, local_stt):
        """GET /api/transcribe/status is supported=true with only a local base."""
        _write_config(tmp_path, monkeypatch, key=None)

        response = client.get("/api/transcribe/status")
        assert response.status_code == 200
        assert response.json() == {"supported": True}
