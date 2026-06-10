import { useState, useEffect, Fragment } from 'react'
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

const JOB_STATUS_TABS = ['all', 'failed', 'processing', 'queued', 'complete']

const JOB_STATUS_TONES = {
  queued:     'muted',
  processing: 'warning',
  complete:   'success',
  failed:     'danger',
}

function fmtDt(s) {
  if (!s) return '—'
  return new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Read-only ops view: recent processing jobs with pipeline diagnostics.
// This is the first stop for "my video is stuck / the numbers look wrong".
function JobsPanel() {
  const api = useApi()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState([])
  const [statusTab, setStatusTab] = useState('all')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)

  async function load(status) {
    setLoading(true)
    try {
      const qs = status && status !== 'all' ? `?status_filter=${status}` : ''
      setJobs(await api.get(`/admin/jobs${qs}`))
    } catch (err) {
      console.error('Failed to load jobs', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(statusTab) }, [statusTab])

  return (
    <>
      <div className="mb-6 flex items-center gap-2">
        {JOB_STATUS_TABS.map(t => (
          <button key={t} onClick={() => setStatusTab(t)} className={`chip ${statusTab === t ? 'active' : ''}`}>{t}</button>
        ))}
        <button onClick={() => load(statusTab)} className="ml-auto text-xs text-muted hover:text-kiwi">↻ refresh</button>
      </div>

      {loading ? (
        <p className="py-8 text-sm text-muted">Loading jobs…</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted">No {statusTab === 'all' ? '' : statusTab + ' '}jobs.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line bg-surface2 text-[10px] font-bold uppercase tracking-wider text-muted">
                <th className="px-3 py-2.5">Created</th>
                <th className="px-3 py-2.5">Clip</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 text-right">Quality</th>
                <th className="px-3 py-2.5 text-right">Subj conf</th>
                <th className="px-3 py-2.5 text-right">Strikes</th>
                <th className="px-3 py-2.5 text-right">Attempt</th>
                <th className="px-3 py-2.5">Version</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => (
                <Fragment key={j.job_id}>
                  <tr
                    onClick={() => setExpanded(expanded === j.job_id ? null : j.job_id)}
                    className="cursor-pointer border-b border-line last:border-0 hover:bg-surface2">
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted">{fmtDt(j.created_at)}</td>
                    <td className="max-w-[180px] truncate px-3 py-2.5 text-text" title={`${j.filename} · ${j.clerk_user_id}`}>{j.filename}</td>
                    <td className="px-3 py-2.5">
                      <Tag tone={JOB_STATUS_TONES[j.status] || 'muted'}>{j.status}</Tag>
                      {j.error_code && <span className="ml-1.5 text-danger">{j.error_code}</span>}
                      {j.status === 'processing' && <span className="ml-1.5 tabular-nums text-muted">{j.progress}%</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {j.pose_quality_score != null
                        ? <span className={j.pose_quality_score >= 0.7 ? 'text-kiwi' : j.pose_quality_score >= 0.5 ? 'text-warning' : 'text-danger'}>{j.pose_quality_score.toFixed(2)}</span>
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text3">{j.subject_confidence != null ? j.subject_confidence.toFixed(2) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text3">
                      {j.strikes_persisted != null ? j.strikes_persisted : '—'}
                      {j.strikes_low_confidence ? <span className="text-muted"> (+{j.strikes_low_confidence} low)</span> : null}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text3">{j.attempt ?? '—'}</td>
                    <td className="max-w-[140px] truncate px-3 py-2.5 text-muted" title={j.pipeline_version}>{j.pipeline_version || 'pre-v3'}</td>
                    <td className="px-3 py-2.5">
                      {j.status === 'complete' && (
                        <button onClick={e => { e.stopPropagation(); navigate(`/clips/${j.clip_id}`) }}
                          className="text-kiwi hover:underline">view</button>
                      )}
                    </td>
                  </tr>
                  {expanded === j.job_id && (
                    <tr className="border-b border-line bg-surface2/50 last:border-0">
                      <td colSpan={9} className="px-4 py-3 text-[11px] leading-relaxed text-text3">
                        <div className="flex flex-wrap gap-x-6 gap-y-1">
                          <span>user: <span className="text-text">{j.clerk_user_id}</span></span>
                          <span>model: <span className="text-text">{j.model || '—'}</span></span>
                          <span>fps: <span className="tabular-nums text-text">{j.fps ?? '—'}</span></span>
                          <span>frames: <span className="tabular-nums text-text">{j.frames_processed ?? '—'}</span></span>
                          <span>subjects: <span className="tabular-nums text-text">{j.subjects_detected ?? '—'}</span></span>
                          <span>started: <span className="text-text">{fmtDt(j.started_at)}</span></span>
                          <span>heartbeat: <span className="text-text">{fmtDt(j.heartbeat_at)}</span></span>
                          {j.stage_timings && (
                            <span>timings: <span className="tabular-nums text-text">
                              {Object.entries(j.stage_timings).map(([k, v]) => `${k} ${v}s`).join(' · ')}
                            </span></span>
                          )}
                        </div>
                        {j.error && <p className="mt-1.5 text-danger">{j.error}</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
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
  const [section, setSection] = useState('coaches')   // 'coaches' | 'jobs'

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

      <main className="max-w-5xl mx-auto px-8 py-10">
        <div className="mb-8">
          <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">Admin</p>
          <h1 className="mt-1 font-display text-[32px] font-extrabold leading-none text-text">
            {section === 'coaches' ? 'Coach moderation' : 'Processing jobs'}
          </h1>
          <div className="mt-4 flex gap-1 border-b border-line">
            {[['coaches', 'Coaches'], ['jobs', 'Jobs']].map(([key, label]) => (
              <button key={key} onClick={() => setSection(key)}
                className={`border-b-2 px-4 py-2 font-display text-[13px] font-bold uppercase tracking-wide transition-colors ${
                  section === key ? 'border-kiwi text-kiwi' : 'border-transparent text-muted hover:text-text'
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {section === 'jobs' && <JobsPanel />}

        {section === 'coaches' && (<>
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
        </>)}
      </main>
    </AppLayout>
  )
}
