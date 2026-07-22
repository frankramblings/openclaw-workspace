import './styles/tokens.css'
import './styles/app.css'
import './styles/kit.css'
import './styles/shell.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './shell/App'
import { initTheme } from './lib/theme'

// Classic-parity runtime theming: cached theme applies synchronously inside,
// server prefs land async — never blocks first paint.
void initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
