import { ClerkProvider } from '@clerk/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
      afterSignOutUrl="/"
      appearance={{
        variables: {
          colorPrimary: '#ccff00',
          colorText: '#f0f0f0',
          colorTextOnPrimaryBackground: '#000000',
          colorBackground: '#0f0f0f',
          colorInputBackground: '#1a1a1a',
          colorInputText: '#f0f0f0',
          colorNeutral: '#f0f0f0',
          borderRadius: '10px',
          fontFamily: "'Barlow', system-ui, sans-serif",
        },
        elements: {
          card: { backgroundColor: '#0f0f0f', border: '1px solid #1f1f1f' },
          formButtonPrimary: {
            backgroundColor: '#ccff00',
            color: '#000000',
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.03em',
            '&:hover': { backgroundColor: '#dfff00' },
          },
        },
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ClerkProvider>
  </StrictMode>
)