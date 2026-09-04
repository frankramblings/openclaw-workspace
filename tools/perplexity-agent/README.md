# Perplexity Agent Sidecar

Local research-only sidecar that gives Perplexity-backed models a small tool loop.

## Run tests

```bash
npm test
```

## Smoke test the local pwm proxy

```bash
node scripts/smoke.mjs
```

The sidecar expects the Perplexity Web proxy to be reachable at `127.0.0.1:18080`.
On this workspace host it is managed by the user service:

```bash
systemctl --user status perplexity-web-api.service
systemctl --user restart perplexity-web-api.service
```

The service runs:

```bash
~/.local/bin/pwm api --host 127.0.0.1 --port 18080 --log-level warning
```

If real prompts fail, check the upstream auth/session first:

```bash
pwm doctor
pwm login --email you@example.com
pwm login --email you@example.com --code 123456
```

## CLI

```bash
./src/cli.mjs --json "Research the current state of OpenClaw tool calling"
```

## MCP

Command:

```bash
node ~/openclaw-workspace/tools/perplexity-agent/src/server.mjs
```

Tool:

```text
pplx_agent.ask
```

v0 tools are research-only: web_search and web_fetch. Shell/filesystem are intentionally out of scope.
