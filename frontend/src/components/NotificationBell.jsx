import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'

const TYPE_ICONS = {
  clip_processing_complete: '🎬',
  review_requested:         '📋',
  review_started:           '👀',
  review_complete:          '✅',
  credits_received:         '⚡',
  challenge_posted:         '🏆',
}

const TYPE_ROUTES = {
  clip_processing_complete: (n) => n.reference_id ? `/clips/${n.reference_id}` : '/dashboard',
  review_requested:         ()  => '/reviews/queue',
  review_started:           (n) => n.reference_id ? `/clips/${n.reference_id}` : '/dashboard',
  review_complete:          (n) => n.reference_id ? `/clips/${n.reference_id}` : '/dashboard',
  credits_received:         ()  => '/dashboard',
  challenge_posted:         ()  => '/coaches',
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function NotificationBell() {
  const api = useApi()
  const navigate = useNavigate()
  const [notifications, setNotifications] = useState([])
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const unread = notifications.filter(n => !n.read).length

  async function fetchNotifications() {
    try {
      const data = await api.get('/notifications')
      setNotifications(data)
    } catch {}
  }

  useEffect(() => {
    fetchNotifications()
    const interval = setInterval(fetchNotifications, 30000)
    return () => clearInterval(interval)
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function handleOpen() {
    setOpen(v => !v)
    if (!open && unread > 0) {
      try {
        await api.patch('/notifications/read-all', {})
        setNotifications(prev => prev.map(n => ({ ...n, read: true })))
      } catch {}
    }
  }

  async function handleClick(notif) {
    setOpen(false)
    const route = TYPE_ROUTES[notif.type]?.(notif)
    if (route) navigate(route)
  }

  return (
    <div className="relative" ref={ref}>
      {/* Bell button */}
      <button
        onClick={handleOpen}
        className="relative p-2 text-gray-400 hover:text-white transition-colors"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-indigo-500 text-white text-xs rounded-full flex items-center justify-center font-medium">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-10 w-80 bg-gray-900 border border-gray-800 rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <h3 className="text-sm font-semibold text-white">Notifications</h3>
            {notifications.length > 0 && (
              <button
                onClick={async () => {
                  await api.patch('/notifications/read-all', {})
                  setNotifications(prev => prev.map(n => ({ ...n, read: true })))
                }}
                className="text-xs text-gray-500 hover:text-white transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-gray-500 text-sm">No notifications yet</p>
              </div>
            ) : (
              notifications.map(notif => (
                <button
                  key={notif.id}
                  onClick={() => handleClick(notif)}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-800 transition-colors border-b border-gray-800/50 last:border-0 ${
                    !notif.read ? 'bg-gray-800/40' : ''
                  }`}
                >
                  <span className="text-lg flex-shrink-0 mt-0.5">
                    {TYPE_ICONS[notif.type] || '🔔'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className={`text-sm font-medium ${notif.read ? 'text-gray-300' : 'text-white'}`}>
                        {notif.title}
                      </p>
                      {!notif.read && (
                        <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full flex-shrink-0 mt-1.5" />
                      )}
                    </div>
                    {notif.body && (
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{notif.body}</p>
                    )}
                    <p className="text-xs text-gray-600 mt-1">{timeAgo(notif.created_at)}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
