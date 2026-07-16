export interface Mailbox { account_id: string; address: string; name: string; default: boolean }
export interface EmailRow { uid: string; subject: string; from_name: string; from_address: string; sender: string; snippet: string; date: string; is_read: boolean; has_attachments: boolean }
export interface EmailList { emails: EmailRow[]; total: number; error?: string }
export interface EmailRead extends EmailRow { to: string; cc: string; body_html: string; message_id: string; references: string; attachments: Array<{ index: number; filename: string; size: number }> }
export interface Folders { folders: string[]; error?: string }
export interface Urgency { per_uid: Record<string, string> }

