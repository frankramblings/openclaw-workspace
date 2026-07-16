export interface Skill { id: string; name: string; description: string; when_to_use?: string; enabled: boolean; status?: string; category: string; source: string; emoji?: string; tags: string[]; uses?: number; confidence?: number; updated_at?: number; created_at?: number; audit_verdict?: string; audit_by_teacher?: boolean; teacher_model?: string }
export interface BuiltinSkill { id?: string; name: string; description?: string; is_overridden?: boolean }
export interface SkillDetail { name: string; markdown: string; builtin: boolean; defaultText?: string }
export interface AuditResult { skill?: string; result?: string; verdict?: { verdict?: string }; skill_state?: Partial<Skill> }
export interface AuditStatus { status: 'none' | 'running' | 'done' | 'cancelled' | 'error'; running?: boolean; done?: number; total?: number; current?: string; results?: AuditResult[]; log?: string[]; teacher?: string; error?: string }
export interface SkillCapabilities { add: boolean; delete_workspace: boolean; edit_workspace: boolean; toggle: boolean; audit: boolean; publish: boolean; builtin_edit: boolean }
