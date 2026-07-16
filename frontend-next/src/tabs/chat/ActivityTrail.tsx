import { groupLabel, groupSteps, type ActivityStep } from '../../lib/activity-group'
import type { ToolCard } from './reducer'

function kind(tool: string): string {
  const name = tool.toLowerCase()
  if (/grep|search|find|glob|ripgrep/.test(name)) return 'grep'
  if (/web|fetch|browse|http|url/.test(name)) return 'web'
  if (/read|cat|open|view|load/.test(name)) return 'read'
  if (/edit|write|patch|create|apply|insert/.test(name)) return 'edit'
  if (/bash|shell|run|exec|terminal|command/.test(name)) return 'run'
  return 'generic'
}

function asStep(card: ToolCard): ActivityStep {
  return {
    id: card.toolId,
    kind: kind(card.tool),
    state: card.state,
    label: card.command || card.tool,
    meta: card.exitCode === 1 ? 'exit 1' : undefined,
    lines: card.output?.split('\n') ?? [],
  }
}

function Step({ step }: { step: ActivityStep }) {
  return (
    <div className={`act-step act-${step.state}`}>
      <div className="act-step-head">
        <span className="act-step-label">{step.label || step.kind}</span>
        {step.meta && <span className="act-step-meta">{step.meta}</span>}
      </div>
      {step.lines && step.lines.length > 0 && <pre className="act-output">{step.lines.join('\n')}</pre>}
    </div>
  )
}

export function ActivityTrail({ cards }: { cards: ToolCard[] }) {
  if (!cards.length) return null
  return (
    <div className="act-trail" aria-label="Activity">
      {groupSteps(cards.map(asStep)).map((item) => item.type === 'single'
        ? <Step key={item.step.id} step={item.step} />
        : <details className="act-group" key={item.id}>
            <summary>{groupLabel(item.kind, item.steps.length)}</summary>
            {item.steps.map((step) => <Step key={step.id} step={step} />)}
          </details>)}
    </div>
  )
}
