'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { langFlag, langName } from '@/lib/languages'
import { downloadForOffline } from '@/lib/offline/download'
import { getLocalStore } from '@/lib/offline/localStore'
import { setOfflineMode } from '@/lib/offline/mode'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import type { Deck, Folder } from '@/domain'
import type { Manifest, OfflineScope, OfflineScopeKind } from '@/lib/offline/types'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function OfflinePanel() {
  const [decks, setDecks] = useState<Deck[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [kind, setKind] = useState<OfflineScopeKind>('library')
  const [target, setTarget] = useState('')
  const [windowDays, setWindowDays] = useState(7)
  const [includeAudio, setIncludeAudio] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null)
  const [result, setResult] = useState<{ cardCount: number; bytes: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const offline = useOfflineMode()

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      const [ds, fs] = await Promise.all([
        new SupabaseDeckRepository().list(session.user.id),
        new SupabaseFolderRepository().list(session.user.id),
      ])
      setDecks(ds); setFolders(fs)
      setManifest((await getLocalStore().getManifest()) ?? null)
      setPendingCount(await getLocalStore().outboxCount())
    })()
  }, [offline])

  const pairs = useMemo(() => {
    const seen = new Set<string>()
    return decks.filter(d => { const k = `${d.sourceLanguage}|${d.targetLanguage}`; if (seen.has(k)) return false; seen.add(k); return true })
      .map(d => ({ key: `${d.sourceLanguage}|${d.targetLanguage}`, source: d.sourceLanguage, target: d.targetLanguage }))
  }, [decks])

  // Reset the target when the scope kind changes.
  useEffect(() => { setTarget(kind === 'language' ? (pairs[0]?.key ?? '') : kind === 'folder' ? (folders[0]?.id ?? '') : kind === 'deck' ? (decks[0]?.id ?? '') : '') }, [kind, pairs, folders, decks])

  function buildScope(): OfflineScope | null {
    if (kind === 'library') return { kind: 'library' }
    if (kind === 'language') { const [source, t] = target.split('|'); return source ? { kind: 'language', source, target: t } : null }
    if (kind === 'folder') return target ? { kind: 'folder', folderId: target } : null
    return target ? { kind: 'deck', deckId: target } : null
  }

  async function run() {
    const scope = buildScope()
    if (!scope) { setError('Pick what to download.'); return }
    setBusy(true); setError(null); setResult(null); setProgress(null)
    try {
      const { manifest: m, bytes } = await downloadForOffline({
        scope, dueWindowDays: windowDays, includeAudio,
        onProgress: (phase, done, total) => setProgress({ phase, done, total }),
      })
      setResult({ cardCount: m.cardCount, bytes })
      setManifest(m)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false); setProgress(null)
    }
  }

  async function clear() {
    await getLocalStore().clearAll()
    setManifest(null); setResult(null)
  }

  return (
    <div className="panel space-y-4">
      <div>
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Offline</h2>
        <p className="text-xs text-ink-faint mt-1">Download cards to study without a connection. Reviews sync back when you&apos;re online. (Card editing, the agent, language sync, and audio generation need a connection.)</p>
      </div>

      {manifest && (
        <div className="rounded-lg border border-line/10 px-3 py-2 flex items-center justify-between gap-3 text-sm">
          <div>
            <div className="text-ink">Downloaded — {manifest.cardCount} cards</div>
            <div className="text-xs text-ink-faint">{fmtWhen(manifest.downloadedAt)} · {manifest.includeAudio ? 'with audio' : 'no audio'} · {manifest.dueWindowDays}-day window</div>
          </div>
          <button onClick={clear} disabled={offline} className="text-xs text-danger hover:underline shrink-0 disabled:opacity-40 disabled:no-underline">Clear</button>
        </div>
      )}

      {/* Offline toggle — only meaningful once a bundle is downloaded */}
      {manifest && (
        <div className={`rounded-lg border px-3 py-2 ${offline ? 'border-accent/40 bg-accent/5' : 'border-line/10'}`}>
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div>
              <div className="text-sm text-ink">{offline ? 'Offline mode — studying locally' : 'Go offline'}</div>
              <div className="text-xs text-ink-faint mt-0.5">
                {offline
                  ? 'Reviews are saved on this device. Toggle off when you have a connection to sync them back.'
                  : pendingCount > 0
                    ? `${pendingCount} local change${pendingCount === 1 ? '' : 's'} waiting to sync.`
                    : 'Study without a connection using your downloaded cards.'}
              </div>
            </div>
            <input
              type="checkbox"
              className="h-5 w-9 shrink-0 accent-accent cursor-pointer"
              checked={offline}
              onChange={e => setOfflineMode(e.target.checked)}
            />
          </label>
        </div>
      )}

      {/* Scope */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-ink-muted">Download</span>
        <select className="input py-1 w-auto" value={kind} onChange={e => setKind(e.target.value as OfflineScopeKind)}>
          <option value="library">Whole library</option>
          <option value="language">A language</option>
          <option value="folder">A folder</option>
          <option value="deck">A deck</option>
        </select>
        {kind === 'language' && (
          <select className="input py-1 w-auto" value={target} onChange={e => setTarget(e.target.value)}>
            {pairs.map(p => <option key={p.key} value={p.key}>{langFlag(p.source)} {langName(p.source)} → {langName(p.target)}</option>)}
          </select>
        )}
        {kind === 'folder' && (
          <select className="input py-1 w-auto" value={target} onChange={e => setTarget(e.target.value)}>
            {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        {kind === 'deck' && (
          <select className="input py-1 w-auto max-w-[200px]" value={target} onChange={e => setTarget(e.target.value)}>
            {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
      </div>

      {/* Options */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-xs text-ink-muted">Due within</span>
          <input type="number" min={1} max={60} className="input text-center py-1 w-16" value={windowDays} onChange={e => setWindowDays(Math.max(1, Math.min(60, Number(e.target.value) || 7)))} />
          <span className="text-xs text-ink-muted">days</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="accent-accent" checked={includeAudio} onChange={e => setIncludeAudio(e.target.checked)} />
          <span className="text-xs text-ink-muted">Include cached audio clips (larger)</span>
        </label>
      </div>

      {progress && (
        <p className="text-xs text-ink-faint">{progress.phase}{progress.total > 1 ? ` — ${progress.done}/${progress.total}` : '…'}</p>
      )}
      {result && <p className="text-xs text-success">✓ Downloaded {result.cardCount} cards · {fmtBytes(result.bytes)}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}

      <button onClick={run} disabled={busy} className="btn-primary text-sm disabled:opacity-50">
        {busy ? 'Downloading…' : manifest ? 'Re-download' : 'Download for offline'}
      </button>
    </div>
  )
}
