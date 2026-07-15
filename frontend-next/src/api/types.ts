// Response types for every backend route /next touches. One reviewable file so
// contract drift is one diff. Types are written from OBSERVED responses (curl
// against :8800) — when reality and expectation differ, reality wins and the
// surprise goes in the morning report.
//
// Sections are append-only, one block per tab, to keep parallel agents from
// colliding. Add your tab's types under its banner.

// ---------------------------------------------------------------- shared/app
export interface AppConfig {
  agent_name: string
  accent: string
  workspace_root: string
  source_url: string
}

// /api/capabilities — per-tab gating snapshot; shape read at runtime, keys
// verified by the tabs that consume them.
export type Capabilities = Record<string, unknown>

export interface GatewayStatus {
  state: 'ok' | 'restarting' | 'down'
  [k: string]: unknown
}
