import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import outputs from '../amplify_outputs.json'
import './index.css'
import App from './App.tsx'

async function bootstrap() {
  const { Amplify } = await import('aws-amplify')
  Amplify.configure(outputs)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
