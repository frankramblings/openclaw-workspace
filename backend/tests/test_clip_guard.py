"""backend/clip_guard.py: SSRF policy for URL clip. check_url is the fast,
DNS-free static gate (scheme/credentials/hostname-literal); resolve_and_check
is the DNS-time gate every fetch hop (backend/clip_fetch.py) re-runs so a
hostname that LOOKS public can't rebind to a private address after the
static check passed (DNS rebinding)."""
import pytest

from backend import clip_guard as cg


@pytest.mark.parametrize("url,normalized", [
    ("https://example.com/article", "https://example.com/article"),
    ("HTTPS://EXAMPLE.com/Path?q=1", "https://example.com/Path?q=1"),
    ("http://example.com:8080/x", "http://example.com:8080/x"),
    ("https://example.com:443/x", "https://example.com/x"),
    ("http://example.com:80/x", "http://example.com/x"),
    ("https://example.com", "https://example.com/"),
    ("https://93.184.216.34/x", "https://93.184.216.34/x"),
])
def test_check_url_accepts_and_normalizes(url, normalized):
    assert cg.check_url(url) == normalized


@pytest.mark.parametrize("url,fragment", [
    ("", "empty"),
    ("   ", "empty"),
    ("ftp://example.com/x", "scheme"),
    ("javascript:alert(1)", "scheme"),
    ("example.com/x", "scheme"),
    ("http://user:pass@example.com/", "credentials"),
    ("http://user@example.com/", "credentials"),
    ("http:///no-host", "host"),
    ("http://2130706433/", "numeric"),   # bare 32-bit decimal == 127.0.0.1
    ("http://127.1", "numeric"),          # short dotted form == 127.0.0.1
    ("http://0x7f000001/", "numeric"),    # hex form == 127.0.0.1
    ("http://0177.0.0.1/", "numeric"),    # octal-looking dotted form == 127.0.0.1
])
def test_check_url_rejects_bad_url(url, fragment):
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url(url)
    assert ei.value.reason == "bad_url"
    assert fragment in ei.value.detail.lower()


@pytest.mark.parametrize("url", [
    "http://localhost/",
    "http://localhost:8080/",
    "http://LOCALHOST/",
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://[::1]/",
    "http://0.0.0.0/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",  # cloud metadata endpoint
    "http://224.0.0.1/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/",  # IPv4-mapped IPv6 loopback
    "http://intranet.local/",
    "http://box.internal/",
    "http://home.lan/",
    "http://INTRANET.LOCAL/",
])
def test_check_url_rejects_blocked_hosts(url):
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url(url)
    assert ei.value.reason == "blocked_host"


def test_resolve_and_check_skips_dns_for_ip_literal_host():
    def resolver(host, port):
        raise AssertionError("must not be called for an IP literal host")
    assert cg.resolve_and_check("93.184.216.34", resolver=resolver) == ["93.184.216.34"]


def test_resolve_and_check_uses_socket_getaddrinfo_by_default(monkeypatch):
    def fake_getaddrinfo(host, port):
        return [(2, 1, 6, "", ("93.184.216.34", 0))]
    monkeypatch.setattr(cg.socket, "getaddrinfo", fake_getaddrinfo)
    assert cg.resolve_and_check("example.com") == ["93.184.216.34"]


def test_resolve_and_check_accepts_all_public_addresses():
    def resolver(host, port):
        return [(2, 1, 6, "", ("93.184.216.34", 0)), (2, 1, 6, "", ("1.1.1.1", 0))]
    assert cg.resolve_and_check("example.com", resolver=resolver) == ["1.1.1.1", "93.184.216.34"]


def test_resolve_and_check_blocks_if_any_address_is_private():
    def resolver(host, port):
        return [(2, 1, 6, "", ("93.184.216.34", 0)), (2, 1, 6, "", ("10.0.0.5", 0))]
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.resolve_and_check("evil.example", resolver=resolver)
    assert ei.value.reason == "blocked_host"


def test_resolve_and_check_blocks_dns_rebinding_to_loopback():
    def resolver(host, port):
        return [(2, 1, 6, "", ("127.0.0.1", 0))]
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.resolve_and_check("looks-public.example", resolver=resolver)
    assert ei.value.reason == "blocked_host"


def test_resolve_and_check_dns_failure_is_dns_failed():
    def resolver(host, port):
        raise OSError("nodename nor servname provided")
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.resolve_and_check("nonexistent.invalid", resolver=resolver)
    assert ei.value.reason == "dns_failed"
