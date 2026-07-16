export interface McpServer { id: string; name: string; status: string; is_enabled: boolean; needs_oauth: boolean; tool_count: number; enabled_tool_count?: number; error?: string | null; transport?: string }
export interface McpTool { name: string; description?: string }
export interface DoctorCheck { id: string; ok: boolean; detail?: string; hint?: string }
export interface DoctorStatus { ok: boolean; checks: DoctorCheck[] }
export interface GatewayStatus { state: string; since?: number; shutdownReason?: string | null; updateAvailable?: unknown; agents?: Array<{ agentId: string; name?: string | null }>; sessionCount?: number }
export interface ConnectionStatus { enabled?: boolean; connected?: boolean; provider?: string; address?: string; imap_host?: string; imap_port?: number; smtp_host?: string; smtp_port?: number; scope?: string; managed_externally?: boolean }
export interface ModelGroup { endpoint_id: string; endpoint_name: string; offline?: boolean; models: string[]; models_display?: string[] }
export interface SearchSettings { search_provider?: string; search_result_count?: number; search_fallback_chain?: string[]; [key: string]: unknown }
export interface Capability { available?: boolean; reason?: string; hint?: string }
export interface SettingsSnapshot { config: { agent_name?: string; accent?: string; workspace_root?: string; source_url?: string }; capabilities: Record<string, Capability>; gateway: GatewayStatus; doctor: DoctorStatus; auth: SearchSettings; defaultChat: { endpoint_id: string; endpoint_url?: string; model: string }; email: ConnectionStatus; calendar: ConnectionStatus; mcp: McpServer[]; models: ModelGroup[] }
export interface ActionResult { kind: 'success' | 'error'; message: string }
