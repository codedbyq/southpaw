import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@clerk/react'
import HomePage from './pages/HomePage'
import DashboardPage from './pages/DashboardPage'
import PlayerPage from './pages/PlayerPage'

function ProtectedRoute({ children }) {
  const { isSignedIn, isLoaded } = useAuth()
  if (!isLoaded) return null
  if (!isSignedIn) return <Navigate to="/" replace />
  return children
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/clips/:clipId"
        element={
          <ProtectedRoute>
            <PlayerPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default App