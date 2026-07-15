# Perplexity Agent Sidecar Design

## Purpose

Build a local, personal-use agent sidecar that lets Perplexity-backed models use tools even though the current `perplexity-web` provider is configured as chat-only (`compat.supportsTools: false`). The first version should run alongside OpenClaw Workspace, not inside the core gateway runtime.

The goal is a useful, low-risk v0:

- use Perplexity models through Frank's existing local `pwm` OpenAI-compatible proxy
- provide a small tool loop owned by the sidecar
- expose that loop as an MCP tool and optionally as a CLI
- start with research-only tools before adding shell/filesystem power

## Recommendation

Build a separate `perplexity-agent` sidecar MCP server first.

Do not start by changing OpenClaw's gateway runtime. A native runtime adapter may be the right long-term version, but a sidecar gives us faster proof, fewer blast-radius problems, and a cleaner rollback path.

## Architecture Overview

```
OpenClaw / CLI / Workspace
        |
        | MCP tool call or CLI command
        v
perplexity-agent sidecar
        |
        | chat completions
        v
pwm local proxy (:18080/v1)
        |
        v
Perplexity web-backed model

Sidecar-owned tools:
  - web_search
  - web_fetch
  - later: filesystem, shell, memory, OpenClaw tasks
```

The sidecar is the agent runtime. The Perplexity model does not need native tool calling. Instead, the sidecar uses a constrained text protocol:

```text
THOUGHT: ...
TOOL web_search {"query":"..."}
```

The sidecar parses a tool request, executes it, appends a tool result message, and asks the model to continue until it emits a final answer.

## Components

### Sidecar Runtime

Responsibilities:

- own the tool loop
- call the local `pwm` proxy using OpenAI-compatible chat completions
- parse model tool requests from text
- enforce max rounds, timeout, and output limits
- return final answer plus a compact trace

Likely location:

- `tools/perplexity-agent/` or `plugins/perplexity-agent/`

### MCP Server

Expose one initial tool:

```json
{
  "name": "pplx_agent.ask",
  "input": {
    "prompt": "string",
    "model": "string?",
    "max_rounds": "number?",
    "mode": "research"
  }
}
```

Return shape:

```json
{
  "answer": "string",
  "model": "string",
  "rounds": 3,
  "trace": [
    {"tool":"web_search","input":{"query":"..."},"summary":"..."}
  ]
}
```

### CLI Wrapper

Optional but useful for direct testing:

```bash
pplx-agent "research Perplexity tool calling limitations"
pplx-agent --model claude-sonnet-4-6 --max-rounds 4 "compare X and Y"
```

The CLI should call the same runtime as the MCP server so tests cover both.

### Tool Providers

v0 tools:

- `web_search`: use existing workspace search provider settings where reasonable
- `web_fetch`: fetch and extract readable page text with hard byte limits

Deferred tools:

- filesystem read
- shell
- OpenClaw memory search
- task/session operations

## Data Flow

1. Caller invokes `pplx_agent.ask`.
2. Sidecar creates a system prompt describing the allowed tool syntax.
3. Sidecar sends the user prompt to the selected Perplexity model through `pwm`.
4. If the model emits a valid `TOOL ...` request:
   - validate tool name and JSON input
   - run the tool
   - trim/summarize the result
   - append result to the conversation
   - continue
5. If the model emits `FINAL:` or no valid tool request, return the final answer.
6. Include a compact trace for debugging and UI display.

## Error Handling

- Invalid tool JSON: send a tool error back to the model once; if repeated, stop with a clear failure.
- Unknown tool: stop immediately unless an alias maps safely.
- Tool timeout: return a bounded error result to the model.
- Too many rounds: stop and return the best available answer with `stopped_reason: max_rounds`.
- Provider failure: surface the `pwm`/HTTP error without retry storms.
- Oversized fetch/search results: trim deterministically and note truncation.

## Safety Boundaries

v0 is research-only.

No shell, filesystem writes, external messaging, email, posting, or account actions. The sidecar may fetch public pages and return text.

When shell/filesystem tools are added later, they should require explicit opt-in config and clear allowlists.

## Testing Strategy

Unit tests:

- parses valid `TOOL name {...}` blocks
- rejects malformed tool calls
- stops at `max_rounds`
- trims oversized tool results
- returns trace entries in order

Integration tests with fake model:

- model asks for `web_search`, then final answer
- model emits invalid JSON, then recovers
- model loops until max rounds

Smoke test with real `pwm`:

- ask a question that requires current web research
- verify at least one tool call appears in trace
- verify final answer cites fetched/search-derived evidence when available

## Implementation Phases

### Phase 1: Runtime Spike

Build the sidecar runtime with a fake model and fake tools. Prove the loop and parser before touching Perplexity.

### Phase 2: Real Perplexity Call

Connect the runtime to `http://127.0.0.1:18080/v1/chat/completions` and run one real prompt without tools.

### Phase 3: Research Tools

Add `web_search` and `web_fetch` with strict limits and tests.

### Phase 4: MCP Server

Expose `pplx_agent.ask` as an MCP server that OpenClaw can register.

### Phase 5: Workspace Integration

Add a Workspace slash command or plugin entry only after the MCP server is stable.

## Open Questions

- Preferred implementation language: Node.js matches MCP/OpenClaw packaging; Python may be faster for local prototyping.
- Should this live inside `openclaw-workspace`, the main OpenClaw config/plugin area, or a separate personal repo?
- Should v0 return source URLs/citations as structured data or only in the answer text?

## Default Decisions

- Use Node.js unless there is a strong reason not to.
- Keep v0 research-only.
- Put the first design/implementation under `openclaw-workspace` until it proves useful, then decide whether to promote it into a proper OpenClaw plugin.
- Do not modify the gateway runtime for v0.
