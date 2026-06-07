import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { LayoutDashboard, LayoutGrid, Film, Users, ClipboardList, User } from 'lucide-react'
import { useCurrentUser } from '../hooks/useCurrentUser'
import NotificationBell from './NotificationBell'
import BuyCreditsModal from './BuyCreditsModal'
import BottomNav from './BottomNav'

/**
 * Shared app shell — Electric Kiwi icon rail (desktop) with credits +
 * notifications + avatar at the bottom, and a slim mobile header + bottom tab
 * bar on small screens. No top utility bar. Wrap signed-in page content in
 * <AppLayout active="dashboard">.
 */
const NAV = [
  { key: 'dashboard',   to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { key: 'sessions',    to: '/sessions',  icon: LayoutGrid,      label: 'Sessions' },
  { key: 'clips',       to: '/clips',     icon: Film,            label: 'Clips' },
  { key: 'marketplace', to: '/coaches',   icon: Users,           label: 'Coaches' },
]

function RailItem({ to, icon: Icon, label, active }) {
  return (
    <Link
      to={to}
      title={label}
      className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-all ${
        active ? 'bg-kiwi text-black' : 'text-text3 hover:bg-surface2 hover:text-text'
      }`}
    >
      <Icon size={20} strokeWidth={2} />
    </Link>
  )
}

export default function AppLayout({ active, children }) {
  const { user } = useCurrentUser()
  const location = useLocation()
  const [showBuyCredits, setShowBuyCredits] = useState(false)

  const current = active || (
    location.pathname.startsWith('/sessions') ? 'sessions' :
    location.pathname.startsWith('/clips') ? 'clips' :
    location.pathname.startsWith('/coaches') ? 'marketplace' :
    location.pathname.startsWith('/reviews') ? 'reviews' :
    location.pathname.startsWith('/profile') || location.pathname.startsWith('/coach/profile') ? 'profile' :
    'dashboard'
  )

  const nav = [...NAV]
  if (user?.user_type === 'coach') {
    nav.push({ key: 'reviews', to: '/reviews/queue', icon: ClipboardList, label: 'Review queue' })
  }
  nav.push({ key: 'profile', to: '/profile', icon: User, label: 'Profile' })

  const credits = user?.credits_balance

  return (
    <div className="flex h-screen overflow-hidden bg-ink text-text">
      {/* ── Icon rail (desktop) ── */}
      <aside className="hidden w-[72px] flex-shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-line bg-surface py-5 md:flex">
        <Link to="/dashboard" title="Southpaw" className="mb-3 font-display text-2xl font-black tracking-tighter text-kiwi">
          SP
        </Link>
        {nav.map(n => (
          <RailItem key={n.key} {...n} active={current === n.key} />
        ))}

        <div className="flex-1" />

        {/* Credits */}
        {user && (
          <button
            onClick={() => setShowBuyCredits(true)}
            title="Credits — tap to buy more"
            className="flex h-11 w-11 flex-col items-center justify-center rounded-xl text-text3 transition-colors hover:bg-surface2 hover:text-text"
          >
            <span className="text-base leading-none text-kiwi">⚡</span>
            <span className="mt-0.5 font-display text-[11px] font-bold leading-none tabular-nums text-text2">{credits ?? '—'}</span>
          </button>
        )}
        {/* Notifications */}
        <NotificationBell placement="right" />
        {/* Avatar / account */}
        <div className="mt-1 flex items-center justify-center">
          <UserButton />
        </div>
      </aside>

      {/* ── Main column ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header (rail is hidden on small screens) */}
        <header className="flex h-14 flex-shrink-0 items-center justify-between gap-3 border-b border-line bg-surface/60 px-4 md:hidden">
          <Link to="/dashboard" className="font-display text-xl font-black tracking-tighter text-kiwi">SP</Link>
          <div className="flex items-center gap-3">
            {user && (
              <button
                onClick={() => setShowBuyCredits(true)}
                className="flex items-center gap-1.5 rounded-lg bg-surface2 px-3 py-1.5 text-sm text-text2 transition-colors hover:bg-surface3"
              >
                <span className="text-kiwi">⚡</span>
                <span className="font-display font-bold tabular-nums">{credits ?? '—'}</span>
              </button>
            )}
            <NotificationBell placement="below" />
            <UserButton />
          </div>
        </header>

        {/* Scrollable page content — extra bottom padding on mobile for the BottomNav */}
        <main className="flex-1 overflow-y-auto pb-20 md:pb-0">{children}</main>
      </div>

      {/* ── Mobile bottom tab bar ── */}
      <BottomNav />

      {showBuyCredits && <BuyCreditsModal onClose={() => setShowBuyCredits(false)} />}
    </div>
  )
}
