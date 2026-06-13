import { useState } from 'react'
import { useApi } from '../api/client'
import Button from './Button'

/**
 * One-time biometric-consent opt-in (BIPA/App Store: affirmative, informed,
 * before any identity data is stored). Shown to users who haven't decided.
 * Declining stores nothing; the same control lives in Profile → Privacy.
 *
 * Props: onDecided() — called after enable or dismiss (parent persists the
 * "don't ask again" flag and refetches the user).
 */
export default function ConsentPrompt({ onDecided }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)

  async function enable() {
    setBusy(true)
    try {
      await api.post('/users/me/consent', { granted: true })
    } finally {
      setBusy(false)
      onDecided?.()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="border-b border-line p-5">
          <h2 className="font-display text-lg font-extrabold uppercase tracking-wide text-text">
            Recognize you automatically?
          </h2>
        </div>

        <div className="space-y-4 p-5">
          <p className="text-sm leading-relaxed text-text2">
            When other people are in frame — sparring, pad work — Southpaw can pick you out
            automatically so your stats and coaching stay about <em>you</em>, not your partner.
          </p>

          <div className="rounded-xl border border-line bg-surface2 p-4">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-kiwi">What this stores</p>
            <ul className="space-y-1.5 text-xs leading-relaxed text-text3">
              <li>• A numeric fingerprint of <strong className="text-text2">your</strong> body proportions and appearance — never an image, never for anyone else in your videos.</li>
              <li>• Never shared or sold. Used only to recognize you in your own clips.</li>
              <li>• Permanently deleted the moment you turn it off, in Profile → Privacy.</li>
            </ul>
          </div>

          <p className="text-[11px] leading-relaxed text-muted">
            Optional. If you skip this, you'll just tap your fighter manually when there's more
            than one person in a clip — everything else works the same.
          </p>

          <div className="flex gap-2 pt-1">
            <Button onClick={enable} disabled={busy} className="flex-1">
              {busy ? 'Enabling…' : 'Enable'}
            </Button>
            <Button variant="secondary" onClick={() => onDecided?.()} disabled={busy} className="flex-1">
              Not now
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
