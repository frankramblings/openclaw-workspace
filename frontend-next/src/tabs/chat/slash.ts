export interface SlashCommand {
  glyph: string
  name: string
  description: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { glyph: '⚡', name: '/run', description: 'shell command in the Terminal' },
  { glyph: '◇', name: '/pplx', description: 'ask the Perplexity research sidecar' },
  { glyph: '⌕', name: '/research', description: 'multi-step web research' },
  { glyph: '▤', name: '/split', description: 'open a surface beside chat' },
  { glyph: '▣', name: '/nano', description: 'generate or edit an image' },
  { glyph: '✎', name: '/note', description: 'capture a note to the vault' },
]

export function filterSlashCommands(draft: string, forced = false): SlashCommand[] {
  if (!forced && !draft.startsWith('/')) return []
  const rest = draft.startsWith('/') ? draft.slice(1) : ''
  const space = rest.indexOf(' ')
  const query = (space === -1 ? rest : rest.slice(0, space)).toLowerCase()
  if (space !== -1 && rest.slice(space + 1).length > 0 && SLASH_COMMANDS.some((command) => command.name.slice(1) === query)) return []
  return SLASH_COMMANDS.filter((command) => !query || command.name.slice(1).startsWith(query))
}
