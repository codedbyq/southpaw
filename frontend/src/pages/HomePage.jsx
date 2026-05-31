import { SignInButton, SignUpButton, useAuth } from '@clerk/react'
import { Navigate } from 'react-router-dom'

export default function HomePage() {
  const { isSignedIn, isLoaded } = useAuth()

  if (!isLoaded) return null
  if (isSignedIn) return <Navigate to="/dashboard" replace />

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-6">
      <h1 className="text-5xl font-bold text-white tracking-tight">Southpaw</h1>
      <p className="text-gray-400 text-lg">AI-powered martial arts analysis</p>
      <div className="flex gap-3 mt-4">
        <SignInButton mode="modal">
          <button className="px-6 py-2 bg-white text-gray-950 font-medium rounded-lg hover:bg-gray-100 transition-colors">
            Sign in
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button className="px-6 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-500 transition-colors">
            Get started
          </button>
        </SignUpButton>
      </div>
    </div>
  )
}