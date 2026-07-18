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
import { pushOutbox, resolveConflicts, type CardStateConflict, type ConflictChoice, type SyncProgress } from '@/lib/offline/sync'
import { SyncConflictModal } from '@/components/settings/SyncConflictModal'
import type { Deck, Folder } from '@/domain'
import type { Manifest, OfflineScope } from '@/lib/offline/types'

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
  const [wholeLibrary, setWholeLibrary] = useState(true)
  const [selPairs,   setSelPairs]   = useState<Set<string>>(new Set())
  const [selFolders, setSelFolders] = useState<Set<string>>(new Set())
  const [selDecks,   setSelDecks]   = useState<Set<string>>(new Set())
  const [windowDays, setWindowDays] = useState(7)
  const [includeAudio, setIncludeAudio] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null)
  const [result, setResult] = useState<{ cardCount: number; bytes: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [userId, setUserId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<CardStateConflict[]>([])
  const offline = useOfflineMode()

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      setUserId(session.user.id)
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

  function toggleIn(set: Set<string>, id: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(id)) next.delete(id); else next.add(id)
    setter(next)
  }

  function buildScopes(): OfflineScope[] {
    if (wholeLibrary) return [{ kind: 'library' }]
    const scopes: OfflineScope[] = []
    for (const key of selPairs) { const [source, t] = key.split('|'); if (source) scopes.push({ kind: 'language', source, target: t }) }
    for (const id of selFolders) scopes.push({ kind: 'folder', folderId: id })
    for (const id of selDecks)   scopes.push({ kind: 'deck', deckId: id })
    return scopes
  }

  async function run() {
    const scopes = buildScopes()
    if (scopes.length === 0) { setError('Pick at least one thing to download (or choose Whole library).'); return }
    setBusy(true); setError(null); setResult(null); setProgress(null)
    try {
      const { manifest: m, bytes } = await downloadForOffline({
        scopes, dueWindowDays: windowDays, includeAudio,
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
    setManifest(null); setResult(null); setPendingCount(0)
  }

  /** Toggling the switch: ON → go offline; OFF → go online and sync the outbox back. */
  async function handleToggle(on: boolean) {
    setSyncMsg(null)
    setOfflineMode(on)               // flips the flag first — repos must be online before we push
    if (on || !userId) return        // going offline: nothing to sync
    await runSync()
  }

  async function runSync() {
    if (!userId) return
    setSyncing(true); setSyncProgress(null); setError(null)
    try {
      const { pushed, conflicts: found } = await pushOutbox(userId, p => setSyncProgress(p))
      setPendingCount(await getLocalStore().outboxCount())
      if (found.length > 0) {
        setConflicts(found)
      } else {
        setSyncMsg(pushed > 0 ? `Synced ${pushed} change${pushed === 1 ? '' : 's'}.` : 'Everything was already up to date.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false); setSyncProgress(null)
    }
  }

  async function applyConflictChoices(choices: Map<string, ConflictChoice>) {
    if (!userId) return
    setSyncing(true)
    try {
      await resolveConflicts(userId, conflicts, choices)
      const remaining = await getLocalStore().outboxCount()
      setPendingCount(remaining)
      setConflicts([])
      setSyncMsg('Sync complete.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
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
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm text-ink">{offline ? 'Offline mode — studying locally' : 'Online'}</div>
              <div className="text-xs text-ink-faint mt-0.5">
                {offline
                  ? 'Reviews are saved on this device. Switch to Online when you have a connection to sync them back.'
                  : pendingCount > 0
                    ? `${pendingCount} local change${pendingCount === 1 ? '' : 's'} waiting to sync.`
                    : 'Study without a connection using your downloaded cards.'}
              </div>
            </div>
            {/* Online ⟷ Offline switch (Online is the default). */}
            <div className="shrink-0 inline-flex rounded-full border border-line/15 bg-surface-raised p-0.5 text-xs font-medium select-none">
              <button
                onClick={() => { if (!syncing && offline) void handleToggle(false) }}
                disabled={syncing}
                className={`px-3 py-1 rounded-full transition-colors disabled:opacity-60 ${!offline ? 'bg-accent text-white' : 'text-ink-muted'}`}
              >Online</button>
              <button
                onClick={() => { if (!syncing && !offline) void handleToggle(true) }}
                disabled={syncing}
                className={`px-3 py-1 rounded-full transition-colors disabled:opacity-60 ${offline ? 'bg-amber-500 text-black' : 'text-ink-muted'}`}
              >Offline</button>
            </div>
          </div>
          {(syncing || syncProgress || syncMsg) && (
            <div className="mt-2 text-xs">
              {syncing && <span className="text-ink-faint">{syncProgress ? `${syncProgress.phase} — ${syncProgress.done}/${syncProgress.total}` : 'Syncing…'}</span>}
              {!syncing && syncMsg && <span className="text-success">✓ {syncMsg}</span>}
            </div>
          )}
          {!offline && pendingCount > 0 && !syncing && conflicts.length === 0 && (
            <button onClick={() => void runSync()} className="mt-2 text-xs text-accent hover:underline">Sync now ({pendingCount})</button>
          )}
        </div>
      )}

      {conflicts.length > 0 && (
        <SyncConflictModal
          conflicts={conflicts}
          onResolve={choices => void applyConflictChoices(choices)}
          onDefer={() => setConflicts([])}
        />
      )}

      {/* Scope — multi-select: whole library, or any mix of languages / folders / decks */}
      <div className="space-y-2 text-sm">
        <div className="text-xs text-ink-muted">What to download</div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="accent-accent" checked={wholeLibrary} onChange={e => setWholeLibrary(e.target.checked)} />
          <span className="text-ink">Whole library</span>
        </label>
        {!wholeLibrary && (
          <div className="space-y-3 pl-1 pt-1">
            {pairs.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Languages</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {pairs.map(p => (
                    <label key={p.key} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" className="accent-accent" checked={selPairs.has(p.key)} onChange={() => toggleIn(selPairs, p.key, setSelPairs)} />
                      <span className="text-ink">{langFlag(p.source)} {langName(p.source)} → {langName(p.target)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {folders.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Folders</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {folders.map(f => (
                    <label key={f.id} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" className="accent-accent" checked={selFolders.has(f.id)} onChange={() => toggleIn(selFolders, f.id, setSelFolders)} />
                      <span className="text-ink truncate max-w-[220px]">{f.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {decks.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Decks</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {decks.map(d => (
                    <label key={d.id} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" className="accent-accent" checked={selDecks.has(d.id)} onChange={() => toggleIn(selDecks, d.id, setSelDecks)} />
                      <span className="text-ink truncate max-w-[220px]">{d.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
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
