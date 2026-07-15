import './styles/tokens.css'
import './styles/app.css'
import './styles/kit.css'
import './styles/shell.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './shell/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
