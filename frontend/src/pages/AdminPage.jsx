import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import { CoachCardSkeleton } from '../components/Skeleton'

const STATUS_TABS = ['pending', 'approved', 'rejected']

const STATUS_STYLES = {
  pending:  'bg-yellow-900 text-yellow-400',
  approved: 'bg-green-900 text-green-400',
  rejected: 'bg-red-900 text-red-400',
}

export default function AdminPage() {
  const api = useApi()
  const navigate = useNavigate()
  const [coaches, setCoaches] = useState([])
  const [tab, setTab] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(null)
  const [rejectModal, setRejectModal] = useState(null)
  const [rejectNotes, setRejectNotes] = useState('')
  const [forbidden, setForbidden] = useState(false)

  async function load(status) {
    setLoading(true)
    try {
      const data = await api.get(`/admin/coaches?moderation_status=${status}`)
      setCoaches(data)
    } catch (err) {
      if (err.message?.includes('403') || err.message === 'Admin access required') {
        setForbidden(true)
      }
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(tab) }, [tab])

  async function handleApprove(profileId) {
    setActionLoading(profileId)
    try {
      await api.patch(`/admin/coaches/${profileId}/approve`, {})
      setCoaches(prev => prev.filter(c => c.id !== profileId))
    } catch (err) {
      console.error('Failed to approve', err)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleRejectConfirm() {
    if (!rejectModal) return
    setActionLoading(rejectModal.id)
    try {
      await api.patch(`/admin/coaches/${rejectModal.id}/reject`, { notes: rejectNotes || null })
      setCoaches(prev => prev.filter(c => c.id !== rejectModal.id))
      setRejectModal(null)
      setRejectNotes('')
    } catch (err) {
      console.error('Failed to reject', err)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleToggleFeatured(profileId) {
    setActionLoading(profileId)
    try {
      const updated = await api.patch(`/admin/coaches/${profileId}/feature`, {})
      setCoaches(prev => prev.map(c => c.id === profileId ? updated : c))
    } catch (err) {
      console.error('Failed to toggle featured', err)
    } finally {
      setActionLoading(null)
    }
  }

  if (forbidden) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <p className="text-red-400 font-medium mb-2">Access denied</p>
        <button onClick={() => navigate('/dashboard')} className="text-sm text-gray-500 hover:text-white">
          ← Dashboard
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-950 text-white">

      {/* Reject modal */}
      {rejectModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 space-y-4">
            <h2 className="font-semibold text-white">Reject profile</h2>
            <p className="text-sm text-gray-400">
              The coach will be notified with your reason so they can update and resubmit.
            </p>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Reason (recommended)</label>
              <textarea
                value={rejectNotes}
                onChange={e => setRejectNotes(e.target.value)}
                placeholder="e.g. Bio is too brief, please add more detail about your coaching background and specializations..."
                rows={3}
                autoFocus
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setRejectModal(null); setRejectNotes('') }}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors">
                Cancel
              </button>
              <button onClick={handleRejectConfirm} disabled={!!actionLoading}
                className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
                Reject & notify
              </button>
            </div>
          </div>
        </div>
      )}

      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <button onClick={() => navigate('/dashboard')} className="text-sm text-gray-400 hover:text-white transition-colors">
          ← Dashboard
        </button>
        <span className="font-bold text-lg tracking-tight">Admin — Coach moderation</span>
        <div />
      </nav>

      <main className="max-w-4xl mx-auto px-6 py-10">

        {/* Tabs */}
        <div className="flex gap-2 mb-8">
          {STATUS_TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-colors ${
                tab === t
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex flex-col gap-4">
            {[...Array(3)].map((_, i) => <CoachCardSkeleton key={i} />)}
          </div>
        ) : coaches.length === 0 ? (
          <p className="text-gray-500 text-sm">No {tab} coach profiles.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {coaches.map(coach => (
              <div key={coach.id} className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-semibold text-white">{coach.display_name || 'No display name'}</h3>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[coach.moderation_status]}`}>
                        {coach.moderation_status}
                      </span>
                      {coach.is_featured && (
                        <span className="text-xs px-2 py-0.5 bg-yellow-900 text-yellow-400 rounded-full">Featured</span>
                      )}
                    </div>

                    {coach.bio && (
                      <p className="text-sm text-gray-400 mb-2 line-clamp-2">{coach.bio}</p>
                    )}

                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {coach.specializations.map(s => (
                        <span key={s} className="text-xs px-2 py-0.5 bg-gray-800 text-gray-400 rounded-full">{s}</span>
                      ))}
                    </div>

                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      {coach.credit_rate && <span>{coach.credit_rate} credits/review</span>}
                      <span>{coach.review_count} reviews</span>
                      <span>Joined {new Date(coach.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    </div>

                    {coach.moderation_notes && (
                      <p className="text-xs text-amber-500 mt-2">Notes: {coach.moderation_notes}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    {coach.moderation_status === 'pending' && (
                      <>
                        <button
                          onClick={() => handleApprove(coach.id)}
                          disabled={actionLoading === coach.id}
                          className="px-4 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => setRejectModal(coach)}
                          disabled={actionLoading === coach.id}
                          className="px-4 py-1.5 bg-red-900 hover:bg-red-800 disabled:opacity-50 text-red-300 text-xs font-medium rounded-lg transition-colors"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {coach.moderation_status === 'rejected' && (
                      <button
                        onClick={() => handleApprove(coach.id)}
                        disabled={actionLoading === coach.id}
                        className="px-4 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        Approve
                      </button>
                    )}
                    {coach.moderation_status === 'approved' && (
                      <>
                        <button
                          onClick={() => handleToggleFeatured(coach.id)}
                          disabled={actionLoading === coach.id}
                          className="px-4 py-1.5 bg-yellow-900 hover:bg-yellow-800 disabled:opacity-50 text-yellow-300 text-xs font-medium rounded-lg transition-colors"
                        >
                          {coach.is_featured ? 'Unfeature' : 'Feature'}
                        </button>
                        <button
                          onClick={() => setRejectModal(coach)}
                          disabled={actionLoading === coach.id}
                          className="px-4 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-400 text-xs rounded-lg transition-colors"
                        >
                          Suspend
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
