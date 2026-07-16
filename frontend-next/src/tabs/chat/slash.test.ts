import { expect, test } from 'vitest'
import { filterSlashCommands } from './slash'

test('filters prefixes and closes once exact-command arguments begin', () => {
  expect(filterSlashCommands('/re').map((command) => command.name)).toEqual(['/research'])
  expect(filterSlashCommands('/run').map((command) => command.name)).toEqual(['/run'])
  expect(filterSlashCommands('/run ')).toHaveLength(1)
  expect(filterSlashCommands('/run ls')).toEqual([])
})

test('only opens without a leading slash when explicitly requested', () => {
  expect(filterSlashCommands('')).toEqual([])
  expect(filterSlashCommands('', true)).toHaveLength(6)
})
