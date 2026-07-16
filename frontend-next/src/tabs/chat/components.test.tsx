import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SessionList } from './SessionList'
import { flattenModels, ModelPicker } from './ModelPicker'
import { useChatStore } from './store'
import type { ModelEndpoint, SessionRecord } from './types'

afterEach(cleanup)

const record: SessionRecord = {
  id: 'one', name: 'Important chat', model: 'gpt-test', speed: 'deep',
  sessionKey: 'agent:main:web-one', endpoint_url: 'ws://localhost', endpoint_id: 'openai',
  folder: null, archived: false, important: true, created: 1, updated: 2,
  origin: null, gary_terminal: null,
}

const endpoint: ModelEndpoint = {
  endpoint_id: 'openai', endpoint_name: 'OpenAI', url: 'ws://localhost', category: 'api',
  model_type: 'api', offline: false, models: ['gpt-test'], models_display: ['GPT Test'],
  models_extra: [], models_extra_display: [],
}

test('SessionList renders backend session metadata and pending state', () => {
  useChatStore.setState({
    sessions: { status: 'ready', data: [record], fetchedAt: 1 },
    activeSessionId: 'one',
    pendingSessions: { one: 'archiving' },
    sessionError: null,
  })
  render(<SessionList />)

  expect(screen.getByText(/Important chat/)).toBeTruthy()
  expect(screen.getByText('archiving')).toBeTruthy()
  expect((screen.getByTitle('Conversation actions') as HTMLButtonElement).disabled).toBe(true)
})

test('ModelPicker renders observed model groups and saved chat speed', () => {
  useChatStore.setState({
    sessions: { status: 'ready', data: [record], fetchedAt: 1 },
    activeSessionId: 'one',
    models: { status: 'ready', data: [endpoint], fetchedAt: 1 },
    defaultChat: { status: 'ready', data: { endpoint_id: 'openai', endpoint_url: 'ws://localhost', model: 'gpt-test' }, fetchedAt: 1 },
    pendingSessions: {},
  })
  render(<ModelPicker />)

  expect(screen.getByRole('button', { name: 'GPT Test' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'deep' }).classList.contains('btn-teal')).toBe(true)
  expect(screen.getByTitle('Default for new chats').textContent).toBe('★')
})

test('flattenModels preserves endpoint identity and offline state', () => {
  expect(flattenModels([{ ...endpoint, offline: true }])).toEqual([{
    id: 'openai:gpt-test', model: 'gpt-test', label: 'GPT Test', endpointId: 'openai', offline: true,
  }])
})
