import { useState, useEffect } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { LayoutDashboard, Users, Gem, ClipboardList } from 'lucide-react'
import { useCurrentUser } from '../hooks/useCurrentUser'
import { useApi } from '../api/client'
import NotificationBell from './NotificationBell'
import BuyCreditsModal from './BuyCreditsModal'

/**
 * Shared app shell — 72px Electric Kiwi icon rail + a slim top utility bar
 * (experience level, admin, plan badge, credits, notifications). Wrap the
 * scrollable content of any signed-in page in <AppLayout active="dashboard">.
 *
 * `active` is the nav key; if omitted it's derived from the current path.
 */
const NAV = [
  { key: 'dashboard',   to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { key: 'marketplace', to: '/coaches',   icon: Users,           label: 'Find a coach' },
  { key: 'pricing',     to: '/pricing',   icon: Gem,             label: 'Pricing' },
]

function RailItem({ to, icon: Icon, label, active }) {
  return (
    <Link
      to={to}
      title={label}
      className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-all ${
        active
          ? 'bg-kiwi text-black'
          : 'text-text3 hover:bg-surface2 hover:text-text'
      }`}
    >
      <Icon size={20} strokeWidth={2} />
    </Link>
  )
}

export default function AppLayout({ active, children }) {
  const { user, refetch } = useCurrentUser()
  const api = useApi()
  const navigate = useNavigate()
  const location = useLocation()
  const [showBuyCredits, setShowBuyCredits] = useState(false)
  const [experience, setExperience] = useState('intermediate')

  useEffect(() => {
    if (user?.experience_level) setExperience(user.experience_level)
  }, [user?.experience_level])

  const current = active || (
    location.pathname.startsWith('/coaches') ? 'marketplace' :
    location.pathname.startsWith('/pricing') ? 'pricing' :
    location.pathname.startsWith('/reviews') ? 'reviews' :
    'dashboard'
  )

  const nav = [...NAV]
  if (user?.user_type === 'coach') {
    nav.splice(1, 0, { key: 'reviews', to: '/reviews/queue', icon: ClipboardList, label: 'Review queue' })
  }

  async function handleExperience(e) {
    const value = e.target.value
    setExperience(value)
    try {
      await api.patch('/users/me', { experience_level: value })
      refetch()
    } catch {}
  }

  return (
    <div className="flex h-screen overflow-hidden bg-ink text-text">
      {/* ── Icon rail ── */}
      <aside className="flex w-[72px] flex-shrink-0 flex-col items-center gap-2 border-r border-line bg-surface py-5">
        <Link to="/dashboard" title="Southpaw" className="mb-3 font-display text-2xl font-black tracking-tighter text-kiwi">
          SP
        </Link>
        {nav.map(n => (
          <RailItem key={n.key} {...n} active={current === n.key} />
        ))}
        <div className="flex-1" />
        <div className="flex items-center justify-center">
          <UserButton />
        </div>
      </aside>

      {/* ── Main column ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top utility bar */}
        <header className="flex h-14 flex-shrink-0 items-center justify-end gap-3 border-b border-line bg-surface/60 px-6">
          {user?.is_admin && (
            <button
              onClick={() => navigate('/admin')}
              className="font-display text-xs font-bold uppercase tracking-wide text-warning transition-colors hover:text-kiwi"
            >
              Admin
            </button>
          )}
          {user && (
            <select
              value={experience}
              onChange={handleExperience}
              title="Your experience level affects AI feedback tone and standards"
              className="rounded-lg border border-line2 bg-surface2 px-2.5 py-1.5 text-xs text-text3 focus:border-kiwi focus:outline-none"
            >
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
              <option value="pro">Pro</option>
            </select>
          )}
          {user && user.subscription_tier !== 'free' && (
            <span className={`tag ${user.subscription_tier === 'elite' ? 'tag-gold' : 'tag-success'}`}>
              {user.subscription_tier === 'elite' ? 'Elite' : 'Pro'}
            </span>
          )}
          {user && (
            <button
              onClick={() => setShowBuyCredits(true)}
              className="flex items-center gap-1.5 rounded-lg bg-surface2 px-3 py-1.5 text-sm text-text2 transition-colors hover:bg-surface3"
            >
              <span className="text-kiwi">⚡</span>
              <span className="font-display font-bold tabular-nums">{user.credits_balance}</span>
              <span className="text-text3">credits</span>
            </button>
          )}
          <NotificationBell />
        </header>

        {/* Scrollable page content */}
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>

      {showBuyCredits && <BuyCreditsModal onClose={() => setShowBuyCredits(false)} />}
    </div>
  )
}
