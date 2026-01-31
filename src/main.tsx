import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Amplify } from 'aws-amplify' // Add this
import outputs from '../amplify_outputs.json' // Add this
import './index.css'
import App from './App.tsx'

// Configure Amplify with the generated outputs
Amplify.configure(outputs)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)