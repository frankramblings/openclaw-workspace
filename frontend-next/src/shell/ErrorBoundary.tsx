import { Component, type ReactNode } from 'react'

interface State { error: Error | null }

/** Last-resort boundary: a crashed tab shows an honest error card instead of a
 *  blank screen, and never takes the rail down with it. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    // Navigating to another tab clears a previous tab's crash.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="next-error" role="alert">
          <p className="next-error-title">This tab crashed</p>
          <p className="next-error-detail">{this.state.error.message}</p>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
