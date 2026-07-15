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

## CLI

```bash
./src/cli.mjs --json "Research the current state of OpenClaw tool calling"
```

## MCP

Command:

```bash
node /home/frank/openclaw-workspace/tools/perplexity-agent/src/server.mjs
```

Tool:

```text
pplx_agent.ask
```

v0 tools are research-only: web_search and web_fetch. Shell/filesystem are intentionally out of scope.
