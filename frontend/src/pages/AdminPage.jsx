import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import Tag from '../components/Tag'
import { CoachCardSkeleton } from '../components/Skeleton'

const STATUS_TABS = ['pending', 'approved', 'rejected']

const STATUS_TONES = {
  pending:  'warning',
  approved: 'success',
  rejected: 'danger',
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
    <AppLayout active="dashboard">
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="mb-2 font-medium text-danger">Access denied</p>
          <button onClick={() => navigate('/dashboard')} className="text-sm text-muted hover:text-text">
            ← Dashboard
          </button>
        </div>
      </div>
    </AppLayout>
  )

  return (
    <AppLayout active="dashboard">
      {/* Reject modal */}
      {rejectModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
          <div className="bg-surface border border-line rounded-2xl w-full max-w-md p-6 space-y-4">
            <h2 className="font-display font-extrabold uppercase tracking-wide text-text">Reject profile</h2>
            <p className="text-sm text-text3">
              The coach will be notified with your reason so they can update and resubmit.
            </p>
            <div>
              <label className="text-xs text-muted mb-1 block">Reason (recommended)</label>
              <textarea
                value={rejectNotes}
                onChange={e => setRejectNotes(e.target.value)}
                placeholder="e.g. Bio is too brief, please add more detail about your coaching background and specializations..."
                rows={3}
                autoFocus
                className="input resize-none"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" size="sm" onClick={() => { setRejectModal(null); setRejectNotes('') }}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={handleRejectConfirm} disabled={!!actionLoading}>Reject & notify</Button>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-4xl mx-auto px-8 py-10">
        <div className="mb-8">
          <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">Admin</p>
          <h1 className="mt-1 font-display text-[32px] font-extrabold leading-none text-text">Coach moderation</h1>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-8">
          {STATUS_TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`chip ${tab === t ? 'active' : ''}`}
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
          <p className="text-muted text-sm">No {tab} coach profiles.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {coaches.map(coach => (
              <div key={coach.id} className="bg-surface border border-line rounded-2xl p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-display font-extrabold text-text">{coach.display_name || 'No display name'}</h3>
                      <Tag tone={STATUS_TONES[coach.moderation_status]}>{coach.moderation_status}</Tag>
                      {coach.is_featured && <Tag tone="gold">Featured</Tag>}
                    </div>

                    {coach.bio && (
                      <p className="text-sm text-text3 mb-2 line-clamp-2">{coach.bio}</p>
                    )}

                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {coach.specializations.map(s => (
                        <Tag key={s} tone="spar">{s}</Tag>
                      ))}
                    </div>

                    <div className="flex items-center gap-4 text-xs text-muted">
                      {coach.credit_rate && <span>{coach.credit_rate} credits/review</span>}
                      <span>{coach.review_count} reviews</span>
                      <span>Joined {new Date(coach.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    </div>

                    {coach.moderation_notes && (
                      <p className="text-xs text-warning mt-2">Notes: {coach.moderation_notes}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    {coach.moderation_status === 'pending' && (
                      <>
                        <Button size="sm" onClick={() => handleApprove(coach.id)} disabled={actionLoading === coach.id}>
                          Approve
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => setRejectModal(coach)} disabled={actionLoading === coach.id}>
                          Reject
                        </Button>
                      </>
                    )}
                    {coach.moderation_status === 'rejected' && (
                      <Button size="sm" onClick={() => handleApprove(coach.id)} disabled={actionLoading === coach.id}>
                        Approve
                      </Button>
                    )}
                    {coach.moderation_status === 'approved' && (
                      <>
                        <Button variant="outline" size="sm" onClick={() => handleToggleFeatured(coach.id)} disabled={actionLoading === coach.id}>
                          {coach.is_featured ? 'Unfeature' : 'Feature'}
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setRejectModal(coach)} disabled={actionLoading === coach.id}>
                          Suspend
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </AppLayout>
  )
}
