import { Link, useLocation } from 'react-router-dom'
import { Home, LayoutGrid, Users, ClipboardList, User, Plus } from 'lucide-react'
import { useCurrentUser } from '../hooks/useCurrentUser'

/**
 * Mobile bottom tab bar (hidden on md+ where the sidebar rail takes over).
 * Two tabs on each side of a raised center Upload FAB. Role-aware.
 */
function TabItem({ to, icon: Icon, label, active }) {
  return (
    <Link to={to} className="flex flex-1 flex-col items-center gap-1 pt-0.5">
      <span className={`flex h-7 w-7 items-center justify-center rounded-lg transition-all ${
        active ? 'bg-kiwi/12 text-kiwi' : 'text-muted'
      }`}>
        <Icon size={18} strokeWidth={2} />
      </span>
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${active ? 'text-kiwi' : 'text-muted'}`}>
        {label}
      </span>
    </Link>
  )
}

export default function BottomNav() {
  const { user } = useCurrentUser()
  const { pathname } = useLocation()
  const isCoach = user?.user_type === 'coach'

  const left = [
    { to: '/dashboard', icon: Home, label: 'Home', match: p => p === '/' || p.startsWith('/dashboard') },
    { to: '/sessions', icon: LayoutGrid, label: 'Sessions', match: p => p.startsWith('/sessions') },
  ]
  const right = [
    isCoach
      ? { to: '/reviews/queue', icon: ClipboardList, label: 'Reviews', match: p => p.startsWith('/reviews') }
      : { to: '/coaches', icon: Users, label: 'Coaches', match: p => p.startsWith('/coaches') },
    { to: '/profile', icon: User, label: 'Profile', match: p => p.startsWith('/profile') || p.startsWith('/coach/profile') },
  ]

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex h-20 items-start border-t border-line bg-surface/95 px-2 pt-2.5 backdrop-blur-xl md:hidden">
      {left.map(i => <TabItem key={i.to} {...i} active={i.match(pathname)} />)}

      <div className="flex-1" />

      {right.map(i => <TabItem key={i.to} {...i} active={i.match(pathname)} />)}

      {/* Upload FAB — raised above the bar */}
      <Link
        to="/clips"
        aria-label="Upload clip"
        className="absolute left-1/2 top-0 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-kiwi text-black shadow-[0_4px_20px_rgba(204,255,0,0.4),0_0_0_4px_rgba(204,255,0,0.08)] transition-transform active:scale-95"
      >
        <Plus size={26} strokeWidth={2.5} />
      </Link>
    </nav>
  )
}
