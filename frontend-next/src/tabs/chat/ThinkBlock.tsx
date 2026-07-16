export function ThinkBlock({ text }: { text: string }) {
  if (!text) return null
  return (
    <details className="think-block">
      <summary>Thought process</summary>
      <div className="think-body">{text}</div>
    </details>
  )
}
