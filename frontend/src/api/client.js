import { useAuth } from '@clerk/react'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// Returns an api object with get/post/delete methods
// Usage: const api = useApi()  then  api.post('/uploads/init', body)
export function useApi() {
  const { getToken } = useAuth()

  async function request(method, path, body) {
    const token = await getToken()
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const error = await res.json().catch(() => ({ detail: 'Request failed' }))
      throw new Error(error.detail || 'Request failed')
    }

    return res.json()
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    delete: (path) => request('DELETE', path),
  }
}