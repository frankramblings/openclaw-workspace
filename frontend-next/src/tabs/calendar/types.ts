export interface CalendarDef { href: string; name: string; color: string; hex?: string; primary?: boolean }
export interface CalendarEvent { uid: string; summary: string; dtstart: string; dtend: string; all_day: boolean; location?: string; description?: string; color?: string; calendar?: string; calendar_href?: string; rrule?: string; event_type?: string; importance?: string }
export interface EventsResponse { events: CalendarEvent[]; error?: string }
export interface CalendarsResponse { calendars: CalendarDef[]; error?: string }
