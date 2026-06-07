import { SignInButton, SignUpButton, useAuth } from '@clerk/react'
import { Navigate } from 'react-router-dom'

const FEATURES = [
  ['⚡', 'Frame-accurate strike detection & pose tracking'],
  ['🛡️', 'Guard discipline, arm extension & fatigue metrics'],
  ['🎯', 'AI coaching feedback on every clip and session'],
]

export default function HomePage() {
  const { isSignedIn, isLoaded } = useAuth()

  if (!isLoaded) return null
  if (isSignedIn) return <Navigate to="/dashboard" replace />

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-ink px-4">
      {/* lime glow */}
      <div className="pointer-events-none absolute -top-40 right-[-10%] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle,rgba(204,255,0,0.10),transparent_70%)]" />

      <div className="relative z-10 w-full max-w-md">
        <p className="font-display text-2xl font-black uppercase tracking-tighter text-kiwi">Southpaw</p>

        <h1 className="mt-8 font-display text-[52px] font-black uppercase leading-[0.95] tracking-tighter text-text">
          Train. Analyse.<br /><span className="text-kiwi">Dominate.</span>
        </h1>
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-text3">
          AI-powered martial arts analysis. Upload your footage, get frame-accurate strike data
          and coaching feedback that makes you sharper.
        </p>

        <ul className="mt-8 flex flex-col gap-3">
          {FEATURES.map(([icon, text]) => (
            <li key={text} className="flex items-center gap-3">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] bg-kiwi/8 text-kiwi">{icon}</span>
              <span className="text-sm text-text2">{text}</span>
            </li>
          ))}
        </ul>

        <div className="mt-10 flex gap-3">
          <SignUpButton mode="modal">
            <button className="btn btn-primary text-[15px] px-5 py-2.5">Get started</button>
          </SignUpButton>
          <SignInButton mode="modal">
            <button className="btn btn-outline text-[15px] px-5 py-2.5">Sign in</button>
          </SignInButton>
        </div>
      </div>
    </div>
  )
}
