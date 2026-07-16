import { useEffect } from 'react'
import { Button, Chip, EmptyState, RemoteView, SectionHeader } from '../../kit'
import { useChatStore } from './store'
import type { ModelEndpoint } from './types'

export interface ModelChoice {
  id: string
  model: string
  label: string
  endpointId: string
  offline: boolean
}

export function flattenModels(endpoints: ModelEndpoint[]): ModelChoice[] {
  return endpoints.flatMap((endpoint) => endpoint.models.map((model, index) => ({
    id: `${endpoint.endpoint_id}:${model}`,
    model,
    label: endpoint.models_display[index] || model,
    endpointId: endpoint.endpoint_id,
    offline: endpoint.offline,
  })))
}

export function ModelPicker() {
  const models = useChatStore((state) => state.models)
  const defaults = useChatStore((state) => state.defaultChat)
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeSessionId)
  const pending = useChatStore((state) => activeId ? state.pendingSessions[activeId] : undefined)
  const loadModels = useChatStore((state) => state.loadModels)
  const loadDefault = useChatStore((state) => state.loadDefaultChat)
  const setModel = useChatStore((state) => state.setSessionModel)
  const setSpeed = useChatStore((state) => state.setSessionSpeed)
  const setDefault = useChatStore((state) => state.setDefaultModel)

  useEffect(() => { if (models.status === 'idle') void loadModels() }, [loadModels, models.status])
  useEffect(() => { if (defaults.status === 'idle') void loadDefault() }, [defaults.status, loadDefault])

  const active = sessions.status === 'ready' ? sessions.data.find((record) => record.id === activeId) : undefined

  return (
    <section className="next-model-picker" aria-label="Model settings">
      <SectionHeader title="Model" />
      {!active && <EmptyState title="Select a conversation" hint="Model and speed are saved per chat." />}
      {active && <>
        <p><Chip tone="accent">{active.model}</Chip>{pending && ` ${pending}`}</p>
        <div className="next-model-speeds" aria-label="Thinking speed">
          {(['fast', 'normal', 'deep'] as const).map((speed) => (
            <Button
              key={speed}
              variant={active.speed === speed ? 'primary' : 'ghost'}
              disabled={Boolean(pending)}
              onClick={() => void setSpeed(active.id, speed)}
            >{speed}</Button>
          ))}
        </div>
        <RemoteView remote={models} onRetry={() => void loadModels()}>
          {(endpoints) => <div className="next-model-options">
            {flattenModels(endpoints).map((choice) => {
              const isDefault = defaults.status === 'ready'
                && defaults.data.endpoint_id === choice.endpointId
                && defaults.data.model === choice.model
              return (
                <div className="next-model-option" key={choice.id}>
                  <Button
                    variant={active.model === choice.model ? 'primary' : 'ghost'}
                    disabled={choice.offline || Boolean(pending)}
                    onClick={() => void setModel(active.id, choice.model, choice.endpointId)}
                  >{choice.label}{choice.offline ? ' · offline' : ''}</Button>
                  <Button
                    variant="ghost"
                    disabled={choice.offline}
                    title="Default for new chats"
                    onClick={() => void setDefault(choice.model, choice.endpointId)}
                  >{isDefault ? '★' : '☆'}</Button>
                </div>
              )
            })}
          </div>}
        </RemoteView>
      </>}
    </section>
  )
}
