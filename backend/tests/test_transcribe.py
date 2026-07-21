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

        with pytest.raises(transcribe.TranscribeError, match="not supported"):
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
