'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseChangeSetRepository } from '@/lib/data/changeSets'
import { applyProposal } from '@/lib/agents/runClient'
import type { ChangeSet, ChangeSetItem, ChangeItemStatus } from '@/domain'

function ProposalView({ item }: { item: ChangeSetItem }) {
  const p = item.proposal
  if (p.field === 'create') {
    const a = p.after as { front: string; back: string }
    return <div className="text-sm"><span className="text-success font-medium">New card</span> · <span className="font-mono text-ink">{a.front}</span> <span className="text-ink-faint">=</span> <span className="font-mono text-ink">{a.back}</span></div>
  }
  if (p.field === 'delete') {
    const b = p.before as { front: string; back: string }
    return <div className="text-sm"><span className="text-danger font-medium">Delete</span> · <span className="font-mono text-ink line-through">{b.front} = {b.back}</span></div>
  }
  return (
    <div className="text-sm">
      <span className="text-warning font-medium capitalize">{p.field}</span> ·{' '}
      <span className="font-mono text-ink-muted line-through">{String(p.before)}</span>{' '}
      <span className="text-ink-faint">→</span>{' '}
      <span className="font-mono text-ink">{String(p.after)}</span>
    </div>
  )
}

function ReviewInner() {
  const changeSetId = useSearchParams().get('cs') ?? ''
  const [userId, setUserId] = useState<string | null>(null)
  const [cs, setCs] = useState<ChangeSet | null>(null)
  const [statuses, setStatuses] = useState<Record<string, ChangeItemStatus>>({})
  const [applying, setApplying] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (session) setUserId(session.user.id)
      const set = await new SupabaseChangeSetRepository().get(changeSetId)
      setCs(set)
      if (set) setStatuses(Object.fromEntries(set.items.map(i => [i.id, i.status])))
      setLoading(false)
    })()
  }, [changeSetId])

  const repo = new SupabaseChangeSetRepository()

  async function setItem(item: ChangeSetItem, status: ChangeItemStatus) {
    setStatuses(prev => ({ ...prev, [item.id]: status }))
    await repo.setItemStatus(item.id, status).catch(() => {})
  }

  async function applyApproved() {
    if (!cs || !userId || applying) return
    setApplying(true)
    for (const item of cs.items) {
      if (statuses[item.id] !== 'approved') continue
      try {
        await applyProposal(userId, item)
        await repo.setItemStatus(item.id, 'applied')
        setStatuses(prev => ({ ...prev, [item.id]: 'applied' }))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await repo.setItemStatus(item.id, 'failed', msg)
        setStatuses(prev => ({ ...prev, [item.id]: 'failed' }))
      }
    }
    await repo.setStatus(cs.id, 'applied')
    setApplying(false)
  }

  if (loading) return <p className="p-6 text-sm text-ink-faint">Loading…</p>
  if (!cs) return <p className="p-6 text-sm text-danger">Change set not found.</p>

  const approvedCount = cs.items.filter(i => statuses[i.id] === 'approved').length

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div>
        <a href="/agents" className="text-xs text-ink-faint hover:text-ink">← Agents</a>
        <h1 className="text-xl font-semibold text-ink mt-1">Review proposed changes</h1>
        <p className="text-sm text-ink-muted mt-1">{cs.summary || cs.task}</p>
      </div>

      {cs.items.length === 0 ? (
        <p className="text-sm text-ink-muted">The agent proposed no changes.</p>
      ) : (
        <div className="space-y-2">
          {cs.items.map(item => {
            const st = statuses[item.id] ?? 'pending'
            const applied = st === 'applied' || st === 'failed'
            return (
              <div key={item.id} className={`panel py-3 space-y-2 ${st === 'rejected' ? 'opacity-40' : ''}`}>
                <ProposalView item={item} />
                <p className="text-xs text-ink-faint">{item.proposal.reason}</p>
                <div className="flex items-center gap-2">
                  {applied ? (
                    <span className={`chip ${st === 'applied' ? 'text-success' : 'text-danger'}`}>{st}{item.error ? `: ${item.error}` : ''}</span>
                  ) : (
                    <>
                      <button onClick={() => setItem(item, 'approved')} className={`text-xs px-3 py-1 rounded ${st === 'approved' ? 'bg-success/20 text-success' : 'text-ink-faint hover:text-success'}`}>Approve</button>
                      <button onClick={() => setItem(item, 'rejected')} className={`text-xs px-3 py-1 rounded ${st === 'rejected' ? 'bg-danger/20 text-danger' : 'text-ink-faint hover:text-danger'}`}>Reject</button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {cs.items.length > 0 && cs.status !== 'applied' && (
        <button className="btn-primary w-full" disabled={approvedCount === 0 || applying} onClick={applyApproved}>
          {applying ? 'Applying…' : `Apply ${approvedCount} approved change${approvedCount === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  )
}

export default function ReviewPage() {
  return <Suspense fallback={<p className="text-sm text-ink-faint">Loading…</p>}><ReviewInner /></Suspense>
}
