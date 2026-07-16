export interface Mailbox { account_id: string; address: string; name: string; default: boolean }
export interface EmailRow { uid: string; subject: string; from_name: string; from_address: string; sender: string; snippet: string; date: string; is_read: boolean; has_attachments: boolean }
export interface EmailList { emails: EmailRow[]; total: number; error?: string }
export interface CalendarInvite { summary?: string; start?: string; end?: string; location?: string; organizer_email?: string; [key: string]: unknown }
export interface EmailRead extends EmailRow { to: string; cc: string; body_html: string; message_id: string; references: string; attachments: Array<{ index: number; filename: string; size: number }>; calendar?: CalendarInvite | null }
export interface Folders { folders: string[]; error?: string }
export interface Urgency { per_uid: Record<string, string> }
export interface ScheduledEmail { id?: string; sid?: string; subject?: string; send_at?: string; [key: string]: unknown }
