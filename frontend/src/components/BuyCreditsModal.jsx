import { useState, useEffect } from 'react'
import { useApi } from '../api/client'

export default function BuyCreditsModal({ onClose }) {
  const api = useApi()
  const [packs, setPacks] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState('pro')
  const [redirecting, setRedirecting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.get('/payments/packs')
      .then(setPacks)
      .catch(() => setError('Failed to load credit packs'))
      .finally(() => setLoading(false))
  }, [])

  async function handleCheckout() {
    setRedirecting(true)
    setError(null)
    try {
      const { checkout_url } = await api.post('/payments/checkout', { pack: selected })
      window.location.href = checkout_url
    } catch (err) {
      setError(err.message)
      setRedirecting(false)
    }
  }

  const selectedPack = packs.find(p => p.id === selected)

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white">Buy credits</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <p className="text-gray-500 text-sm text-center py-4">Loading...</p>
          ) : (
            <>
              {/* Pack options */}
              <div className="space-y-2">
                {packs.map(pack => (
                  <button
                    key={pack.id}
                    onClick={() => setSelected(pack.id)}
                    className={`w-full flex items-center justify-between p-4 rounded-xl border transition-all ${
                      selected === pack.id
                        ? 'border-indigo-500 bg-indigo-950'
                        : 'border-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <div className="text-left">
                      <p className="font-semibold text-white">{pack.label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{pack.description}</p>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <p className="font-bold text-white">${(pack.price_cents / 100).toFixed(2)}</p>
                      <p className="text-xs text-gray-500">
                        ${(pack.price_cents / pack.credits / 100).toFixed(2)}/credit
                      </p>
                    </div>
                  </button>
                ))}
              </div>

              {/* Info */}
              <div className="text-xs text-gray-500 text-center">
                Credits never expire · Secure payment via Stripe
              </div>

              {error && <p className="text-red-400 text-sm text-center">{error}</p>}

              {/* CTA */}
              <button
                onClick={handleCheckout}
                disabled={redirecting || !selectedPack}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors"
              >
                {redirecting
                  ? 'Redirecting to Stripe...'
                  : selectedPack
                    ? `Buy ${selectedPack.label} — $${(selectedPack.price_cents / 100).toFixed(2)}`
                    : 'Select a pack'
                }
              </button>
            </>
          )}
        </div>

      </div>
    </div>
  )
}
