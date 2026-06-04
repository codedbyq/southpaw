import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@clerk/react'
import { useCurrentUser } from './hooks/useCurrentUser'
import HomePage from './pages/HomePage'
import OnboardingPage from './pages/OnboardingPage'
import DashboardPage from './pages/DashboardPage'
import PlayerPage from './pages/PlayerPage'
import SessionPage from './pages/SessionPage'
import CoachProfilePage from './pages/CoachProfilePage'
import MarketplacePage from './pages/MarketplacePage'
import CoachPublicProfilePage from './pages/CoachPublicProfilePage'
import AdminPage from './pages/AdminPage'
import PricingPage from './pages/PricingPage'
import CoachReviewQueuePage from './pages/CoachReviewQueuePage'
import CoachReviewPlayerPage from './pages/CoachReviewPlayerPage'

function ProtectedRoute({ children }) {
  const { isSignedIn, isLoaded } = useAuth()
  const { user, loading } = useCurrentUser()

  if (!isLoaded || loading) return null
  if (!isSignedIn) return <Navigate to="/" replace />

  // Onboarding not complete — redirect to onboarding
  if (user?.user_type === null) return <Navigate to="/onboarding" replace />

  return children
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route
        path="/coach/profile"
        element={
          <ProtectedRoute>
            <CoachProfilePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/coaches"
        element={
          <ProtectedRoute>
            <MarketplacePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/coaches/:coachId"
        element={
          <ProtectedRoute>
            <CoachPublicProfilePage />
          </ProtectedRoute>
        }
      />
      <Route path="/pricing" element={<PricingPage />} />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reviews/queue"
        element={
          <ProtectedRoute>
            <CoachReviewQueuePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reviews/:reviewId/player"
        element={
          <ProtectedRoute>
            <CoachReviewPlayerPage />
          </ProtectedRoute>
        }
      />
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
      <Route
        path="/sessions/:sessionId"
        element={
          <ProtectedRoute>
            <SessionPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default App
