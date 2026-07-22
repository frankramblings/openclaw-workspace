import { groupLabel, groupSteps, type ActivityStep } from '../../lib/activity-group'
import { Icon, type IconName } from '../../kit/icons'
import type { ToolCard } from './reducer'

// Renders tool activity in the classic redesign's trail language (.act-wrap /
// .act-summary / .act-spine / .act-row / .act-code — all ported in app.css):
// a quiet collapsible summary, one row per step, output behind the row's own
// disclosure as a bordered code card. Never a bare wall of tool output.

function kind(tool: string): string {
  const name = tool.toLowerCase()
  if (/grep|search|find|glob|ripgrep/.test(name)) return 'grep'
  if (/web|fetch|browse|http|url/.test(name)) return 'web'
  if (/read|cat|open|view|load/.test(name)) return 'read'
  if (/edit|write|patch|create|apply|insert/.test(name)) return 'edit'
  if (/bash|shell|run|exec|terminal|command/.test(name)) return 'run'
  return 'generic'
}

const KIND_ICON: Record<string, IconName> = {
  grep: 'search', web: 'research', read: 'file', edit: 'pencil', run: 'terminal', generic: 'dots',
}

function asStep(card: ToolCard): ActivityStep {
  return {
    id: card.toolId,
    kind: kind(card.tool),
    state: card.state,
    label: card.command || card.tool,
    meta: card.exitCode != null && card.exitCode !== 0 ? `exit ${card.exitCode}` : undefined,
    lines: card.output ? card.output.split('\n') : [],
  }
}

function Step({ step }: { step: ActivityStep }) {
  const row = (
    <>
      <span className="act-ic"><Icon name={KIND_ICON[step.kind] ?? 'dots'} size={13} /></span>
      <span className="file">{step.label || step.kind}</span>
      {step.state === 'running' && <span className="lbl">running…</span>}
      {step.meta && <span className="meta" style={{ color: 'var(--red)' }}>{step.meta}</span>}
    </>
  )
  if (!step.lines || step.lines.length === 0) {
    return <div className={`act-row act-${step.state}`}>{row}</div>
  }
  return (
    <details className={`act-tool act-${step.state}`}>
      <summary className="act-row">{row}</summary>
      <div className="act-detail">
        <div className="act-code">{step.lines.map((line, i) => <div className="ln" key={i}>{line || ' '}</div>)}</div>
      </div>
    </details>
  )
}

export function ActivityTrail({ cards }: { cards: ToolCard[] }) {
  if (!cards.length) return null
  const running = cards.some((card) => card.state === 'running')
  const count = cards.length
  return (
    <details className="act-wrap" open={running || undefined} aria-label="Activity">
      <summary className="act-summary">
        <span className="act-chev"><Icon name="chevRight" size={11} /></span>
        <span className="act-worked">{running ? 'Working' : 'Ran'} · {count} {count === 1 ? 'step' : 'steps'}</span>
      </summary>
      <div className="act-spine">
        {groupSteps(cards.map(asStep)).map((item) => item.type === 'single'
          ? <Step key={item.step.id} step={item.step} />
          : <details className="act-groupwrap" key={item.id}>
              <summary className="act-group">
                <span className="act-chev"><Icon name="chevRight" size={11} /></span>
                <span className="lbl">{groupLabel(item.kind, item.steps.length)}</span>
              </summary>
              {item.steps.map((step) => <Step key={step.id} step={step} />)}
            </details>)}
      </div>
    </details>
  )
}
