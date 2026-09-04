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
    ("http://example.com./x", "http://example.com/x"),  # trailing root-label dot stripped
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
    ("http://exa mple.com/", "hostname alphabet"),   # embedded space
    ("http://exa\x00mple.com/", "hostname alphabet"),  # NUL byte
    ("http:// /", "hostname alphabet"),               # whitespace-only host
])
def test_check_url_rejects_bad_url(url, fragment):
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url(url)
    assert ei.value.reason == "bad_url"
    assert fragment in ei.value.detail.lower()


def test_check_url_rejects_root_dot_only_host():
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url("http://./x")
    assert ei.value.reason == "bad_url"
    assert "host" in ei.value.detail.lower()


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
    "http://100.64.0.1/",          # RFC 6598 shared address space (CGNAT)
    "http://[::ffff:10.1.2.3]/",   # IPv4-mapped IPv6, non-loopback private
    "http://240.0.0.1/",           # reserved (class E)
    "http://[::]/",                # unspecified IPv6 address
])
def test_check_url_rejects_blocked_hosts(url):
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url(url)
    assert ei.value.reason == "blocked_host"


@pytest.mark.parametrize("url", [
    "http://LOCALHOST./",
    "http://localhost./",
    "http://127.0.0.1./",
    "http://10.0.0.5./",
    "http://foo.local./",
])
def test_check_url_rejects_blocked_hosts_with_trailing_root_dot(url):
    # The dotless equivalent of each of these is already in
    # test_check_url_rejects_blocked_hosts; a trailing root-label dot must
    # not defeat the same blocked_host checks.
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url(url)
    assert ei.value.reason == "blocked_host"


def test_check_url_rejects_numeric_obfuscated_host_with_trailing_root_dot():
    # Dotless "http://0x7f000001/" is bad_url/numeric (test above); the
    # trailing dot must not let it fall through as a plain DNS name.
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url("http://0x7f000001./")
    assert ei.value.reason == "bad_url"
    assert "numeric" in ei.value.detail.lower()


@pytest.mark.parametrize("url", [
    "http://localhost../",     # two trailing dots: a single strip leaves "localhost."
    "http://127.0.0.1../",     # same, on an IP-literal host
    "http://foo.local../",     # same, on a blocked-suffix host
    "http://.example.com/",    # leading dot: empty first label
    "http://exa..mple.com/",   # doubled dot in the middle: empty label
    "http://example.com.../",  # three trailing dots
])
def test_check_url_rejects_hosts_with_an_empty_label(url):
    # Never silently allowed, whichever reason the guard settles on for a
    # given shape (bad_url for the empty-label check itself, blocked_host
    # if the normalized form also happens to hit the static denylist).
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url(url)
    assert ei.value.reason in ("bad_url", "blocked_host")


@pytest.mark.parametrize("url", [
    "http://100.63.255.255/",
    "http://100.128.0.0/",
])
def test_check_url_allows_addresses_outside_shared_address_space(url):
    assert cg.check_url(url) == url


@pytest.mark.parametrize("url,fragment", [
    ("http://intranet.local/", "local"),
    ("http://box.internal/", "internal"),
    ("http://home.lan/", "lan"),
    ("http://localhost/", "localhost"),
])
def test_check_url_blocked_hostname_detail_is_case_specific(url, fragment):
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url(url)
    assert ei.value.reason == "blocked_host"
    assert ei.value.detail
    assert fragment in ei.value.detail.lower()


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://169.254.169.254/",
    "http://100.64.0.1/",
])
def test_check_url_blocked_ip_range_detail_is_case_specific(url):
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.check_url(url)
    assert ei.value.reason == "blocked_host"
    assert ei.value.detail
    assert "range" in ei.value.detail.lower()


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


def test_resolve_and_check_fails_closed_on_any_resolver_exception():
    # Not every custom/injected resolver fails with OSError; whatever it
    # raises must still fail closed as dns_failed rather than propagate
    # and skip the range check entirely.
    def resolver(host, port):
        raise ValueError("resolver blew up")
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.resolve_and_check("nonexistent.invalid", resolver=resolver)
    assert ei.value.reason == "dns_failed"


def test_resolve_and_check_blocks_shared_address_space():
    def resolver(host, port):
        return [(2, 1, 6, "", ("100.64.0.1", 0))]
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.resolve_and_check("cgnat.example", resolver=resolver)
    assert ei.value.reason == "blocked_host"


def test_resolve_and_check_rejects_empty_label_host_without_calling_resolver():
    def resolver(host, port):
        raise AssertionError("must not be called for a host the static gate would reject")
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.resolve_and_check("localhost..", resolver=resolver)
    assert ei.value.reason == "bad_url"


def test_resolve_and_check_rejects_blocked_hostname_with_trailing_dot_without_calling_resolver():
    def resolver(host, port):
        raise AssertionError("must not be called for a host the static gate would reject")
    with pytest.raises(cg.BlockedUrl) as ei:
        cg.resolve_and_check("LOCALHOST.", resolver=resolver)
    assert ei.value.reason in ("bad_url", "blocked_host")
