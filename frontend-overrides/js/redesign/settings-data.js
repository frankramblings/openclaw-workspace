// Settings surface data, ported faithfully from the design reference's PANELS.
// Mirrors the real OpenClaw settings-modal structure. Rows are plain objects
// with a `type` discriminator; toggle on/off state is read from state.ui at
// render time, so these definitions stay pure data.

// wrench icon path body (reused)
const WR = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>';

// id -> [title, description, iconPathBody]
export const TAB = {
  services: ['Add Models', 'Connect endpoints — local or cloud', '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/>'],
  ai: ['AI Defaults', 'Models for chat, utility, vision, research', '<path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/>'],
  search: ['Search', 'Web search provider and fallbacks', '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'],
  integrations: ['Integrations', 'All external service connections', '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'],
  email: ['Email', 'Accounts, tasks, and writing style', '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'],
  reminders: ['Reminders', 'How fired reminders reach you', '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'],
  brain: ['Brain', 'Long-term memory and skills', '<path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.3C6.2 13.5 5 11.4 5 9a7 7 0 0 1 7-7z"/>'],
  scheduled: ['Scheduled', 'Recurring jobs', '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'],
  appearance: ['Appearance', 'Theme, sidebar, and chat visibility', '<circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 0 0 0 20 4 4 0 0 1 0-8 4 4 0 0 0 0-8z"/>'],
  shortcuts: ['Shortcuts', 'Keyboard shortcuts', '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>'],
  account: ['Account', 'Profile, password, and 2FA', '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'],
  tools: ['Agent Tools', 'Enable or disable agent tools', WR],
  users: ['Users', 'Accounts and registration', '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'],
  system: ['System', 'Backup and danger zone', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'],
};

// ---- row builders ---------------------------------------------------------
const head = (text, icon) => ({ type: 'head', text, icon: icon || '' });
const sel = (label, value, muted) => ({ type: 'select', label, value, muted: !!muted });
const inp = (label, value, ph, model, itype) => ({ type: 'input', label, value: value || ph || '', hasValue: !!value, font: 'sans', ph: ph || '', model, itype });
const txt = (text) => ({ type: 'text', text });
const ta = (value) => ({ type: 'textarea', value });
const chips = (label, arr) => ({ type: 'chips', label, chips: arr });
const btns = (arr) => ({ type: 'buttons', buttons: arr });
const provider = (cur, names) => ({ type: 'provider', cur, names });
const ep = (glyph, name, detail, iconBg, iconColor) => ({ type: 'endpoint', glyph, name, detail, iconBg, iconColor, status: 'Active', statusColor: 'var(--green)' });
const tgrow = (key, label, desc) => ({ type: 'toggleRow', key, label, desc });
const vis = (items) => ({ type: 'vis', items });
const shortcut = (action, keys) => ({ type: 'shortcut', action, keys });
const danger = (label, desc, kind) => ({ type: 'danger', label, desc, kind });
const user = (av, name, role) => ({ type: 'user', av, name, role });
const accents = () => ({ type: 'accent' });
const card = (o) => o;

export const PANELS = {
  services: [
    card({ title: 'Add Models', note: '(Endpoints)', icon: TAB.services[2], sub: 'Connect local models first, or add a cloud API.', rows: [
      head('LOCAL', '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'),
      inp('Endpoint URL', '', 'http://localhost:11434/v1'), sel('Type', 'LLM'),
      btns([{ label: 'Scan for Servers' }, { label: 'Ollama' }, { label: 'Test' }, { label: 'Add', primary: true }]),
      head('API', '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
      provider('DeepSeek', ['Anthropic', 'DeepSeek', 'OpenAI', 'OpenRouter', 'Ollama Cloud', 'Groq', 'Mistral', 'Together AI', 'Fireworks AI', 'Google Gemini', 'xAI Grok', 'Z.AI']),
      inp('API Key', '', 'sk-…'), sel('Type', 'LLM'),
      btns([{ label: 'Test' }, { label: 'Add', primary: true }]),
    ] }),
    card({ title: 'Added Models', note: '(Endpoints)', icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>', sub: "Manage the endpoints you've added.", rows: [
      head('LOCAL'), ep('OL', 'Ollama', 'localhost:11434 · llama3.1, qwen2.5:7b', 'rgba(91,217,127,.14)', 'var(--green)'),
      head('API'), ep('AN', 'Anthropic', 'claude-opus-4, claude-sonnet-4', 'rgba(232,194,104,.14)', 'var(--gold)'),
      ep('DS', 'DeepSeek', 'deepseek-chat, deepseek-reasoner', 'rgba(123,182,255,.14)', 'var(--blue)'),
    ] }),
  ],
  ai: [
    card({ title: 'Default Chat Model', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', sub: 'The model used when creating a new chat session.', rows: [
      sel('Endpoint', 'Anthropic'), sel('Model', 'claude-opus-4'), chips('Fallbacks', ['claude-sonnet-4']),
    ] }),
    card({ title: 'Utility Model', note: '(Recommended: Local)', icon: WR, sub: 'Runs background tasks (compaction, cleanup, auto-naming, retrieving memories) on a small/local model. Leave blank to use the chat model.', rows: [
      sel('Endpoint', 'Ollama (local)'), sel('Model', 'qwen2.5:7b'),
    ] }),
    card({ title: 'Vision', icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>', toggleKey: 'visionEnabled', sub: 'Analyze images with a vision-capable model.', rows: [sel('Model', 'Auto-detect', true)] }),
    card({ title: 'Research Model', icon: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>', sub: 'Model used for Deep Research. Falls back to the default chat model if not set.', rows: [
      sel('Endpoint', 'Same as chat', true), sel('Model', 'Same as chat', true), sel('Search', 'Same as web search', true),
      inp('Max Tokens', '', '8192 (default)'), inp('Extract Timeout', '', '90 sec'), inp('Extract Parallel', '', '3'),
    ] }),
    card({ title: 'Agent', icon: WR, sub: 'Controls for the agent tool loop.', rows: [inp('Tool call limit', '', '0 = unlimited')] }),
    card({ title: 'Teacher Model', note: '(Experimental)', icon: '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>', toggleKey: 'teacherEnabled', sub: 'When a self-hosted student fails an agent task, escalate to a SOTA teacher that writes a SKILL.md so the student learns next time. Off by default.', rows: [sel('Endpoint', '—', true), sel('Model', '—', true)] }),
  ],
  search: [
    card({ title: 'Web Search', icon: TAB.search[2], sub: 'Search API used for web search and deep research.', rows: [
      provider('SerpAPI', ['SerpAPI', 'SearXNG', 'DuckDuckGo', 'Brave', 'Google PSE', 'Tavily', 'Serper', 'Disabled']),
      sel('Results', '5'), inp('URL', 'http://localhost:8080'), chips('Fallbacks', ['DuckDuckGo', 'Brave']),
      btns([{ label: 'Test' }]),
    ] }),
  ],
  integrations: [
    card({ title: 'Connections', icon: TAB.integrations[2], sub: 'All external service connections in one place.', rows: [
      ep('GM', 'Gmail', 'femanuele@wistia.com · IMAP + SMTP', 'rgba(240,114,106,.14)', 'var(--red)'),
      ep('SL', 'Slack', 'wistia.slack.com', 'rgba(91,217,127,.14)', 'var(--green)'),
      ep('GC', 'Google Calendar', '6 calendars · CalDAV', 'rgba(123,182,255,.14)', 'var(--blue)'),
      ep('AS', 'Asana', '2 workspaces', 'rgba(232,194,104,.14)', 'var(--gold)'),
      ep('OB', 'Obsidian', 'vault: ~/Obsidian/Frank', 'rgba(169,155,245,.14)', 'var(--violet)'),
      ep('NT', 'ntfy', 'ntfy.sh/frank-reminders', 'rgba(79,227,209,.14)', 'var(--teal)'),
      btns([{ label: '+ Add Integration' }]),
    ] }),
  ],
  email: [
    card({ title: 'Email Accounts', icon: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>', rows: [txt('Add, edit, delete, and test accounts in Integrations.'), btns([{ label: 'Manage in Integrations' }])] }),
    card({ title: 'Email Tasks', icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 16l2 2 4-4"/>', rows: [txt('Manage email background tasks in Tasks.'), btns([{ label: 'Open Tasks' }])] }),
    card({ title: 'Writing Style', icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>', sub: 'AI-extracted from your sent emails. Used when AI drafts replies.', rows: [ta('I keep emails short and direct. No exclamation marks. I sign off with “— Frank”.'), btns([{ label: 'Extract from Sent (15 emails)' }, { label: 'Save', primary: true }])] }),
  ],
  reminders: [
    card({ title: "How you're reminded", icon: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>', sub: 'Controls how fired note reminders are delivered.', rows: [sel('Channel', 'Browser notification')] }),
    card({ title: 'AI Synthesis', icon: '<path d="M12 0 14.59 8.41 23 12l-8.41 3.59L12 24l-2.59-8.41L1 12l8.41-3.59z"/>', toggleKey: 'reminderLlm', sub: 'When on, the utility model writes a short, warm one-line reminder for browser, email, and ntfy reminders instead of the raw note content.' }),
    card({ title: 'Public App URL', icon: TAB.integrations[2], sub: 'Used to build clickable links back to Gary inside reminder / urgent-email emails. Leave blank to omit links.', rows: [inp('URL', 'https://chat.openclaw.local')] }),
    card({ title: 'Test', icon: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', sub: 'Fire a test reminder using your current settings.', rows: [btns([{ label: 'Send Test Reminder', primary: true }])] }),
  ],
  brain: [card({ title: 'Brain', icon: TAB.brain[2], sub: "Gary's long-term memories and skills — browse, edit, pin, and audit them.", launcher: 'Open Brain' })],
  scheduled: [card({ title: 'Scheduled', icon: TAB.scheduled[2], sub: 'Recurring jobs — run now, enable/disable, and inspect run history.', launcher: 'Open Scheduled jobs' })],
  appearance: [
    card({ title: 'Theme', icon: TAB.appearance[2], sub: 'Colorways, fonts, density and background effects. Pick an accent below or open the full picker.', rows: [accents()], launcher: 'Open theme picker' }),
    card({ title: 'Sidebar', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>', rows: [vis([['sb-brand', 'Gary', 'Brand'], ['sb-search', 'Search'], ['sb-newchat', 'New Chat'], ['sb-chats', 'Chats'], ['sb-email', 'Email'], ['sb-tools', 'Tools'], ['sb-brain', 'Brain'], ['sb-cal', 'Calendar'], ['sb-compare', 'Compare'], ['sb-cookbook', 'Cookbook'], ['sb-research', 'Deep Research'], ['sb-gallery', 'Gallery'], ['sb-library', 'Library'], ['sb-notes', 'Notes'], ['sb-tasks', 'Tasks'], ['sb-theme', 'Theme'], ['sb-user', 'User'], ['sb-settings', 'Settings']])] }),
    card({ title: 'Chat Area', icon: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>', rows: [vis([['ca-header', 'Session Header'], ['ca-welcome', 'Welcome Message'], ['ca-incognito', 'Incognito Mode'], ['ca-emoji', 'Text-only Emojis'], ['ca-think', 'Thinking Process'], ['ca-blur', 'Sensitive Blur']])] }),
    card({ title: 'Chat Bar', icon: '<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>', rows: [vis([['cb-web', 'Web Search'], ['cb-doc', 'Document Editor'], ['cb-shell', 'Shell'], ['cb-more', 'More Tools'], ['cb-mode', 'Agent / Chat'], ['cb-attach', 'Attach Files'], ['cb-research', 'Deep Research'], ['cb-chars', 'Characters']])] }),
  ],
  shortcuts: [
    card({ title: 'Keyboard Shortcuts', icon: TAB.shortcuts[2], sub: 'Click a shortcut to rebind. Press Escape to cancel.', rows: [
      shortcut('New chat', ['⌘', 'N']), shortcut('Search / command palette', ['⌘', 'K']), shortcut('Toggle sidebar', ['⌘', '\\']),
      shortcut('Send message', ['⌘', '↵']), shortcut('New line', ['⇧', '↵']), shortcut('Open settings', ['⌘', ',']),
      shortcut('Incognito mode', ['⌘', '⇧', 'I']), shortcut('Focus composer', ['/']),
    ] }),
  ],
  account: [
    card({ title: 'Account', icon: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', rows: [user('F', 'frank', 'Admin'), btns([{ label: 'Logout', danger: true, act: 'logout' }])] }),
    card({ title: 'Change Password', icon: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', rows: [inp('Current', '', 'Current password', 'pwCurrent', 'password'), inp('New', '', 'New password (min 8)', 'pwNew', 'password'), inp('Confirm', '', 'Confirm new password', 'pwConfirm', 'password'), btns([{ label: 'Update Password', primary: true, act: 'changePassword' }])] }),
    card({ title: 'Two-Factor Authentication', icon: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1"/>', sub: 'Add a second step at login with an authenticator app.', rows: [btns([{ label: 'Enable 2FA', primary: true }])] }),
  ],
  tools: [
    card({ title: 'Built-in Tools', icon: WR, sub: 'Enable or disable tools available to the AI agent.', rows: [
      tgrow('t-web', 'Web Search', 'Search the web and fetch pages'),
      tgrow('t-shell', 'Run Shell', 'Execute commands in the workspace'),
      tgrow('t-files', 'Read / Write Files', 'Access the workspace filesystem'),
      tgrow('t-cal', 'Calendar', 'Create and read calendar events'),
      tgrow('t-email', 'Email', 'Read, draft, and send mail'),
      tgrow('t-memory', 'Memory', 'Store and retrieve long-term memories'),
      tgrow('t-image', 'Image Generation', 'Generate and edit images'),
    ] }),
  ],
  users: [
    card({ title: 'Registration', icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>', rows: [tgrow('signup', 'Open signup', 'Allow anyone to create an account from the login page')] }),
    card({ title: 'Users', icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>', rows: [user('F', 'frank', 'Admin · owner'), user('M', 'mitra', 'Member')] }),
    card({ title: 'Add User', icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>', rows: [inp('Username', '', 'Username (email)', 'newUsername', 'text'), inp('Password', '', 'Password (min 8)', 'newPassword', 'password'), tgrow('newAdmin', 'Admin', 'Grant full admin access'), btns([{ label: 'Add User', primary: true, act: 'addUser' }])] }),
  ],
  system: [
    card({ title: 'Data Backup', icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', sub: 'Export or import your user data (memories, presets, settings, skills, preferences) as a JSON file.', rows: [btns([{ label: 'Export Data', act: 'exportData' }, { label: 'Import Data', act: 'importData' }])] }),
    card({ title: 'Danger Zone', danger: true, icon: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', sub: 'Irreversible. Each wipe targets one category — pick exactly what you want gone.', rows: [
      danger('Wipe all chats', 'Every session, message, and chat history.', 'chats'),
      danger('Wipe all memory', 'Clears memory.json, the Memory table, and the vector store.', 'memory'),
      danger('Wipe all skills', 'Drops data/skills/ (all SKILL.md files).', 'skills'),
      danger('Wipe all notes', 'Every note, todo, and checklist.', 'notes'),
      danger('Wipe all tasks', 'Every scheduled task and its run history.', 'tasks'),
      danger('Wipe all documents', 'Every document and version.', 'documents'),
      danger('Wipe all gallery', 'Every image record and the upload directory.', 'gallery'),
      danger('Wipe all calendar', 'Every event and every calendar.', 'calendar'),
    ] }),
  ],
};

// grouped section nav with dividers + ADMIN label
export const NAV_GROUPS = [
  ['services', 'ai', 'search'], 'div',
  ['integrations', 'email', 'reminders', 'brain', 'scheduled'], 'div',
  ['appearance', 'shortcuts'], 'div',
  ['account'], 'div',
  { label: 'ADMIN', ids: ['tools', 'users', 'system'] },
];

// default UI toggle state (visibility/feature toggles)
export const DEFAULT_UI = {
  'sb-brand': true, 'sb-search': true, 'sb-newchat': true, 'sb-chats': true, 'sb-email': true, 'sb-tools': true, 'sb-brain': true, 'sb-cal': true, 'sb-compare': true, 'sb-cookbook': true, 'sb-research': true, 'sb-gallery': true, 'sb-library': true, 'sb-notes': true, 'sb-tasks': true, 'sb-theme': true, 'sb-user': true, 'sb-settings': true,
  'ca-header': true, 'ca-welcome': true, 'ca-incognito': true, 'ca-emoji': false, 'ca-think': true, 'ca-blur': false,
  'cb-web': true, 'cb-doc': true, 'cb-shell': true, 'cb-more': true, 'cb-mode': true, 'cb-attach': true, 'cb-research': true, 'cb-chars': true,
  visionEnabled: true, teacherEnabled: false, reminderLlm: false,
  't-web': true, 't-shell': true, 't-files': true, 't-cal': true, 't-email': true, 't-memory': true, 't-image': false,
  signup: false, newAdmin: false,
};
