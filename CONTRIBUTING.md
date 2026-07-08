# Contributing

Thanks for hacking on OpenClaw Workspace. It's a small project with a clear shape
— read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

## Dev setup

```bash
scripts/setup.sh --name Dev --yes        # branding + build the frontend
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt
python -m pytest backend/tests -q        # 670+ tests, ~70s
uvicorn backend.app:app --reload --port 8800
```

You need a running OpenClaw gateway for chat to work; the pure-mapper tests run
without one.

Frontend JS tests: `node --test frontend-overrides/js/__tests__/*.test.js`.

## Dependencies

`backend/requirements.txt` floors are the contract: the minimum version each
feature needs, with an `# Optional features` section for packages that are
lazily imported inside a function so their absence just degrades a feature
(e.g. no `openpyxl` → `.xlsx` attachments aren't text-extracted) rather than
breaking the app. `backend/requirements.lock` is a full `pip freeze` snapshot
of the known-good production venv — install from it (`pip install -r
backend/requirements.lock`) when you want exact reproducibility instead of
floors. Refresh the lock (`pip freeze --exclude-editable > backend/requirements.lock`,
keeping the header comment) whenever the production venv's dependency set
changes, not on every commit.

## Ground rules

- **Tests first for backend logic.** The suite tests pure mappers/helpers (no live
  gateway). Add tests next to the code in `backend/tests/`. Keep them gateway-free.
- **Don't hardcode personal data or secrets.** Everything machine-specific is an
  env var (see `.env.example`) or read from `~/.openclaw/openclaw.json` at runtime.
  Defaults must be generic (`example.com`, `~/...`), never a real domain or abs path.
- **Run `scripts/smoke.sh`** before opening a PR.

## Frontend changes

Never edit `frontend/` directly — it's generated and gitignored. Instead:

- Brand-neutral upstream change → edit `frontend-vendor/` (the base).
- Workspace customization → add/edit a file in `frontend-overrides/` (additive
  CSS/JS preferred over full-file overrides; they survive base updates). New
  scripts/styles need an injection step in `scripts/sync-frontend.sh`.
- Any user-visible agent name in an override → use the literal `__AGENT_NAME__`
  token, never a hardcoded name. Don't tokenize JS identifiers/slugs.
- Re-run `scripts/sync-frontend.sh` and reload to see changes.

See `frontend-overrides/README.md` for the override inventory and conventions.

## Adding a tab

1. Write `backend/<tab>.py` exposing an `APIRouter` (`router`) — a thin adapter
   over your data source or an OpenClaw gateway method via `bridge.gateway_call`.
2. `app.include_router(<tab>_router)` in `backend/app.py`, before the catch-all.
3. Add pure-mapper tests in `backend/tests/`.
4. Wire any UI via `frontend-overrides/` (see above).

## Commits & PRs

- Conventional-commit-ish subjects (`feat(scope): …`, `fix(scope): …`).
- Keep PRs focused; include what you ran to verify.
