import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles/index.css'
import { App } from './app/App'

const container = document.getElementById('root')
if (!container) throw new Error('TermForge root container is missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
