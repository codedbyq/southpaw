import { useState, useEffect } from 'react'
import { useAuth } from '@clerk/react'
import { useApi } from '../api/client'

/**
 * Fetches the current user's domain profile from GET /users/me.
 * Returns { user, loading, refetch }
 * user.user_type === null means onboarding is not complete.
 */
export function useCurrentUser() {
  const { isSignedIn, isLoaded } = useAuth()
  const api = useApi()
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  async function fetchUser() {
    try {
      const data = await api.get('/users/me')
      setUser(data)
    } catch (err) {
      console.error('Failed to fetch current user', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      fetchUser()
    } else if (isLoaded && !isSignedIn) {
      setLoading(false)
    }
  }, [isLoaded, isSignedIn])

  return { user, loading, refetch: fetchUser }
}
