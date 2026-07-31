'use client'

/**
 * components/create/BatchDeckImport.tsx — build a whole folder/deck tree from one Word document.
 *
 * For mass intake: have an assistant write a structured vocabulary document, drop it in, and get the
 * folders and decks its headings describe. **No AI is used anywhere in this flow** — the document is
 * parsed locally (`lib/docx.ts`) and nothing is uploaded. Distractor pre-generation and language
 * syncing (both AI) are deliberately skipped; distractors are generated lazily at study time anyway.
 *
 * Decks are saved ONE AT A TIME, and each save is a two-step gate: the first press checks and flags,
 * the second confirms. That's the whole point of not saving them in a single batch — you get to
 * decide what happens to each collision, with "Remove all duplicates" / "Add all anyway" to move fast
 * when the answer is the same for all of them.
 *
 * **Duplicates here are FRONT-ONLY** (`analyzeFrontDuplicate`): the same word twice is a duplicate
 * whatever the gloss says, because two cards for one word means two competing schedules. A mass
 * import leaked duplicates precisely because front+back matching can't see "cielo = sky" vs
 * "cielo = heaven". Genuine homographs are handled by choosing "Add anyway" per card.
 *
 * Checked against the library AND against lines earlier in the same deck and earlier decks of the
 * same import, since a word easily appears under two headings of one document.
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabasePipelineRepository } from '@/lib/data/pipelines'
import { SupabaseDismissedPairRepository } from '@/lib/data/dismissedPairs'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseSynonymGroupRepository } from '@/lib/data/synonymGroups'
import { readDeckPlanFromFile, type DeckPlan, type PlannedDeck } from '@/lib/docx'
import { analyzeFrontDuplicate, normalizeFrontKey, type DuplicateAnalysis } from '@/lib/duplicates'
import { langFlag, langName } from '@/lib/languages'
import { routes } from '@/lib/routes'
import type { Card, Folder, LanguagePair } from '@/domain'

type Phase = 'setup' | 'review' | 'done'

/**
 * What to do with one imported line.
 *   create          — no collision; make a new card.
 *   merge           — the word already exists; link that card into this deck instead of duplicating.
 *   keep-both       — make a second card anyway. The homograph escape hatch (vino = wine / he came).
 *   delete-existing — replace the library's card with this one.
 *   skip            — drop this line entirely (an earlier line in this same deck has the same word,
 *                     so there is no saved card to merge with).
 */
type ImportAction = 'create' | 'merge' | 'keep-both' | 'delete-existing' | 'skip'

interface ImportItem {
  front:     string
  back:      string
  duplicate: DuplicateAnalysis | null
  action:    ImportAction
  /** Index of an earlier item in THIS deck that this one duplicates (neither is saved yet). */
  batchDuplicateOf?: number
  existingCardDeckNames?: string[]
}

export function BatchDeckImport() {
  const router   = useRouter()
  const supabase = createClient()

  const [userId,   setUserId]   = useState<string | null>(null)
  const [pairs,    setPairs]    = useState<LanguagePair[]>([])
  const [pairKey,  setPairKey]  = useState('')
  const [separator, setSeparator] = useState('=')

  const [fileName, setFileName] = useState('')
  const [plan,     setPlan]     = useState<DeckPlan | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  const [phase,     setPhase]     = useState<Phase>('setup')
  const [deckIndex, setDeckIndex] = useState(0)
  const [items,     setItems]     = useState<ImportItem[]>([])
  const [dupChecked, setDupChecked] = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [savedDecks, setSavedDecks] = useState<{ id: string; name: string; count: number }[]>([])
  const [skipped,    setSkipped]    = useState(0)

  /** The pair's whole card library, kept current as decks are saved so later decks see earlier ones. */
  const [library, setLibrary] = useState<Card[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  /** Resolved folder ids by path key, so a shared parent folder is created once. */
  const [folderIds] = useState(() => new Map<string, string>())

  useEffect(() => {
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      setUserId(session.user.id)
      const [ps, fs] = await Promise.all([
        new SupabaseLanguagePairRepository().list(session.user.id),
        new SupabaseFolderRepository().list(session.user.id),
      ])
      setPairs(ps)
      setFolders(fs)
      if (ps.length === 1) setPairKey(`${ps[0]!.sourceLanguage}|${ps[0]!.targetLanguage}`)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [sourceLanguage, targetLanguage] = useMemo(
    () => (pairKey ? pairKey.split('|') : ['', '']) as [string, string],
    [pairKey],
  )

  async function handleFile(file: File | undefined) {
    if (!file) return
    setParseError(null)
    setFileName(file.name)
    setPlan(null)
    try {
      const parsed = await readDeckPlanFromFile(file, { separator })
      if (parsed.decks.length === 0) {
        setParseError('No word lines found. Each vocabulary line needs a separator, e.g. "el = the".')
        return
      }
      setPlan(parsed)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Could not read that file.')
    }
  }

  function startImport() {
    if (!plan || !pairKey) return
    void (async () => {
      setError(null)
      try {
        const cards = await new SupabaseCardRepository().listOwned(userId!, sourceLanguage, targetLanguage)
        setLibrary(cards)
        setDeckIndex(0)
        loadDeck(plan.decks[0]!)
        setPhase('review')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load your library.')
      }
    })()
  }

  function loadDeck(deck: PlannedDeck) {
    setItems(deck.cards.map(c => ({ front: c.front, back: c.back, duplicate: null, action: 'create' as const })))
    setDupChecked(false)
    setError(null)
  }

  function advance(saved?: { id: string; name: string; count: number }) {
    if (saved) setSavedDecks(prev => [...prev, saved])
    const next = deckIndex + 1
    if (!plan || next >= plan.decks.length) { setPhase('done'); return }
    setDeckIndex(next)
    loadDeck(plan.decks[next]!)
  }

  /** Creates (or reuses) every folder on a deck's path and returns the deepest folder's id. */
  async function ensureFolderPath(path: string[]): Promise<string | null> {
    let parentId: string | null = null
    let known = folders
    for (let depth = 0; depth < path.length; depth++) {
      const name = path[depth]!
      const key = path.slice(0, depth + 1).join('/')
      const cached = folderIds.get(key)
      if (cached) { parentId = cached; continue }
      // Reuse a same-named folder at this level — re-importing a document must not fork the tree.
      // A folder with no pair of its own is shared, so it matches too.
      const existing = known.find(f =>
        f.parentId === parentId &&
        f.name.trim().toLowerCase() === name.trim().toLowerCase() &&
        (!f.sourceLanguage || (f.sourceLanguage === sourceLanguage && f.targetLanguage === targetLanguage)))
      if (existing) {
        folderIds.set(key, existing.id)
        parentId = existing.id
        continue
      }
      const created: Folder = await new SupabaseFolderRepository()
        .create(userId!, name, parentId, { sourceLanguage, targetLanguage })
      known = [...known, created]
      setFolders(known)
      folderIds.set(key, created.id)
      parentId = created.id
    }
    return parentId
  }

  /** First press checks for duplicates; second press (or a no-collision check) saves. */
  async function saveDeck() {
    if (!plan || !userId || saving) return
    const planned = plan.decks[deckIndex]!
    setError(null)

    if (!dupChecked) {
      // FRONT-ONLY, deliberately: the same word twice is a duplicate whatever the gloss says. Mass
      // imports leaked duplicates for exactly the case front+back matching can't see — the library
      // already had "cielo = sky" and the document brought "cielo = heaven".
      const withDup: ImportItem[] = items.map((it, idx) => {
        const duplicate = analyzeFrontDuplicate({ front: it.front, back: it.back }, library, sourceLanguage)
        if (duplicate.tier !== 'none') {
          // Reuse the card that already exists rather than adding a second one for the same word.
          return { ...it, duplicate, action: 'merge' }
        }
        // Same word twice inside THIS deck. Neither copy is saved, so there's nothing to merge with —
        // the only resolution is dropping the later one, which is what 'skip' means.
        for (let j = 0; j < idx; j++) {
          if (normalizeFrontKey(it.front, sourceLanguage) === normalizeFrontKey(items[j]!.front, sourceLanguage)
              && normalizeFrontKey(it.front, sourceLanguage)) {
            return { ...it, duplicate: { tier: 'front', existingCard: null }, action: 'skip', batchDuplicateOf: j }
          }
        }
        return { ...it, duplicate, action: 'create' }
      })

      const hitIds = [...new Set(withDup
        .filter(it => it.duplicate?.existingCard)
        .map(it => it.duplicate!.existingCard!.id))]
      const deckNames = hitIds.length
        ? await new SupabaseCardRepository().listDeckNamesForCards(hitIds).catch(() => ({} as Record<string, string[]>))
        : {}
      const resolved = withDup.map(it =>
        it.duplicate?.existingCard
          ? { ...it, existingCardDeckNames: deckNames[it.duplicate.existingCard.id] ?? [] }
          : it)

      setItems(resolved)
      setDupChecked(true)
      if (resolved.some(it => it.duplicate && it.duplicate.tier !== 'none')) return
      await commit(resolved, planned)
      return
    }

    await commit(items, planned)
  }

  /** Writes one deck: folders, the deck, merged + new cards, then deterministic gloss grouping. */
  async function commit(list: ImportItem[], planned: PlannedDeck) {
    if (!userId) return
    setSaving(true)
    try {
      const folderId = await ensureFolderPath(planned.path)
      const pipeline = await new SupabasePipelineRepository().getDefault()
      const deckRepo = new SupabaseDeckRepository()
      const cardRepo = new SupabaseCardRepository()

      const deck = await deckRepo.create(userId, {
        name: planned.name, sourceLanguage, targetLanguage, pipelineId: pipeline.id,
      })
      if (folderId) await deckRepo.update(deck.id, { folderId })

      const toMerge  = list.filter(it => it.action === 'merge' && it.duplicate?.existingCard)
      const toCreate = list.filter(it => it.action !== 'merge' && it.action !== 'skip')

      let position = 0
      for (const it of toMerge) await cardRepo.addToDeck(deck.id, it.duplicate!.existingCard!.id, position++)

      let created: Card[] = []
      if (toCreate.length > 0) {
        created = await cardRepo.bulkCreate(deck.id, userId, sourceLanguage, targetLanguage,
          toCreate.map(it => ({ front: it.front, back: it.back, position: position++ })))
        const dismissedRepo = new SupabaseDismissedPairRepository()
        for (let i = 0; i < toCreate.length; i++) {
          const it = toCreate[i]!
          const card = created[i]
          if (!card || !it.duplicate?.existingCard || card.id === it.duplicate.existingCard.id) continue
          if (it.action === 'keep-both')       await dismissedRepo.create(userId, it.duplicate.existingCard.id, card.id)
          if (it.action === 'delete-existing') await cardRepo.softDelete(it.duplicate.existingCard.id)
        }
      }

      // Deterministic (non-AI) grouping of cards that share a gloss — same as the single-deck save.
      if (created.length > 0) {
        try {
          await new SupabaseSynonymGroupRepository()
            .autoGroupByGloss(userId, created, library, sourceLanguage, targetLanguage)
        } catch (err) { console.error('Auto synonym grouping failed (non-fatal):', err) }
      }

      // Keep the in-memory library current so the NEXT deck's duplicate check sees these cards.
      setLibrary(prev => [...prev, ...created])
      advance({ id: deck.id, name: planned.name, count: toMerge.length + created.length })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save this deck.')
    } finally {
      setSaving(false)
    }
  }

  /** Drop every flagged line from this deck. The existing cards stay exactly as they are. */
  function removeAllDuplicates() {
    setItems(prev => prev.filter(it => !it.duplicate || it.duplicate.tier === 'none'))
  }
  /**
   * Add every flagged line as a NEW card anyway — the homograph escape hatch. Clears the flags so the
   * banner and the two-step gate don't keep re-asserting a decision that's already been made.
   */
  function ignoreAll() {
    setItems(prev => prev.map(it =>
      it.duplicate && it.duplicate.tier !== 'none'
        ? { ...it, action: 'keep-both' as const, duplicate: null, batchDuplicateOf: undefined }
        : it))
  }
  function updateItem(i: number, patch: Partial<ImportItem>) {
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  }
  function removeItem(i: number) {
    setItems(prev => prev.filter((_, idx) => idx !== i))
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  if (phase === 'setup') {
    const totalCards = plan?.decks.reduce((n, d) => n + d.cards.length, 0) ?? 0
    return (
      <div className="space-y-6">
        <p className="text-ink-muted">
          Import a Word document whose headings describe your folders and decks. Nothing is sent to an AI —
          the file is read on this device.
        </p>

        <div className="space-y-1.5 max-w-sm">
          <label className="text-sm text-ink-muted">Library</label>
          {pairs.length === 0 ? (
            <p className="text-sm text-ink-faint">
              You don&apos;t have a language pairing yet — create one deck the normal way first.
            </p>
          ) : (
            <select className="input text-sm" value={pairKey} onChange={e => setPairKey(e.target.value)}>
              <option value="">Choose a library…</option>
              {pairs.map(p => {
                const key = `${p.sourceLanguage}|${p.targetLanguage}`
                return (
                  <option key={p.id} value={key}>
                    {p.flag ?? langFlag(p.sourceLanguage)} {langName(p.sourceLanguage)} → {langName(p.targetLanguage)}
                  </option>
                )
              })}
            </select>
          )}
        </div>

        <div className="space-y-1.5 max-w-sm">
          <label className="text-sm text-ink-muted">Front / back separator</label>
          <input className="input text-sm" value={separator} onChange={e => setSeparator(e.target.value)} placeholder="=" />
          <p className="text-xs text-ink-faint">A tab is always accepted too.</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Word document</label>
          <input type="file" accept=".docx" className="block text-sm text-ink-muted file:mr-3 file:rounded-lg file:border-0 file:bg-surface file:px-3 file:py-1.5 file:text-ink hover:file:bg-surface/70"
            onChange={e => void handleFile(e.target.files?.[0])} />
          {fileName && <p className="text-xs text-ink-faint">{fileName}</p>}
        </div>

        {parseError && <p className="text-danger text-sm">{parseError}</p>}
        {error && <p className="text-danger text-sm">{error}</p>}

        {plan && (
          <div className="panel space-y-2">
            <p className="text-sm text-ink">
              {`${plan.decks.length} deck${plan.decks.length !== 1 ? 's' : ''}, ${totalCards} card${totalCards !== 1 ? 's' : ''}`}
            </p>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {plan.decks.map((d, i) => (
                <div key={i} className="flex gap-3 text-xs">
                  <span className="text-ink-faint truncate flex-1">
                    {d.path.length > 0 ? `${d.path.join(' / ')} / ` : ''}<span className="text-ink">{d.name}</span>
                  </span>
                  <span className="text-ink-faint tabular-nums">{d.cards.length}</span>
                </div>
              ))}
            </div>
            {plan.unparsed.length > 0 && (
              <p className="text-xs text-warning">
                {`${plan.unparsed.length} line${plan.unparsed.length !== 1 ? 's' : ''} had no separator and will be skipped — e.g. “${plan.unparsed[0]}”`}
              </p>
            )}
          </div>
        )}

        <button className="btn-primary" disabled={!plan || !pairKey || !userId} onClick={startImport}>
          {plan ? `Review ${plan.decks.length} deck${plan.decks.length !== 1 ? 's' : ''}` : 'Choose a document'}
        </button>
      </div>
    )
  }

  // ── Done ─────────────────────────────────────────────────────────────────

  if (phase === 'done') {
    const total = savedDecks.reduce((n, d) => n + d.count, 0)
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-xl font-semibold text-ink">Import complete</h2>
          <p className="text-ink-muted text-sm mt-1">
            {`${savedDecks.length} deck${savedDecks.length !== 1 ? 's' : ''} saved, ${total} card${total !== 1 ? 's' : ''} in total${skipped > 0 ? `, ${skipped} deck${skipped !== 1 ? 's' : ''} skipped` : ''}.`}
          </p>
        </div>
        <div className="panel max-h-72 overflow-y-auto space-y-1">
          {savedDecks.map(d => (
            <button key={d.id} onClick={() => router.push(routes.deck(d.id))}
              className="flex w-full gap-3 text-xs text-left hover:bg-surface/40 rounded px-1 py-0.5">
              <span className="text-ink truncate flex-1">{d.name}</span>
              <span className="text-ink-faint tabular-nums">{d.count}</span>
            </button>
          ))}
        </div>
        <button className="btn-ghost" onClick={() => { setPhase('setup'); setPlan(null); setFileName(''); setSavedDecks([]); setSkipped(0); folderIds.clear() }}>
          Import another document
        </button>
      </div>
    )
  }

  // ── Review one deck ──────────────────────────────────────────────────────

  const planned    = plan!.decks[deckIndex]!
  const inLibrary  = items.filter(it => it.duplicate && it.duplicate.tier !== 'none' && it.duplicate.existingCard).length
  const inThisDeck = items.filter(it => it.batchDuplicateOf !== undefined).length
  const flagged    = inLibrary + inThisDeck

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-ink truncate">{planned.name}</h2>
          <p className="text-ink-muted text-sm mt-0.5 truncate">
            {planned.path.length > 0 ? `${planned.path.join(' / ')} · ` : ''}
            {`${items.length} card${items.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <span className="text-sm text-ink-muted tabular-nums shrink-0">{deckIndex + 1} / {plan!.decks.length}</span>
      </div>

      <div className="h-1 rounded-full bg-surface overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${(deckIndex / plan!.decks.length) * 100}%` }} />
      </div>

      {dupChecked && flagged > 0 && (
        <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted">
          {`${flagged} word${flagged !== 1 ? 's' : ''} you already have${
            inLibrary > 0 && inThisDeck > 0 ? ` — ${inLibrary} in your library, ${inThisDeck} repeated in this deck`
            : inThisDeck > 0 ? ' — repeated within this deck' : ' in this library'
          }. Matched on the ${langName(sourceLanguage)} word alone, so the meanings may differ.`}
        </div>
      )}
      {error && <p className="text-danger text-sm">{error}</p>}

      <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
        {items.map((item, i) => (
          <div key={i} className="panel space-y-2 py-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 grid grid-cols-2 gap-2">
                <input className="input text-sm font-medium py-1.5" value={item.front}
                  onChange={e => updateItem(i, { front: e.target.value })} />
                <input className="input text-sm py-1.5" value={item.back}
                  onChange={e => updateItem(i, { back: e.target.value })} />
              </div>
              <button onClick={() => removeItem(i)} title="Remove"
                className="text-ink-faint hover:text-danger transition-colors text-sm shrink-0 mt-1.5">✕</button>
            </div>

            {dupChecked && item.duplicate && item.duplicate.tier !== 'none' && (
              <div className="border-t border-line/10 pt-2 space-y-1.5">
                {item.duplicate.existingCard ? (
                  <>
                    <p className="text-xs text-ink-muted">
                      {`You already have “${item.duplicate.existingCard.front}” = “${item.duplicate.existingCard.back}”${
                        item.existingCardDeckNames?.length ? ` in ${item.existingCardDeckNames.join(', ')}` : ''
                      }.`}
                    </p>
                    <div className="flex flex-wrap gap-3 text-xs">
                      {([
                        ['merge',           'Use the existing card'],
                        ['skip',            'Leave it out'],
                        ['keep-both',       'Add anyway (different word)'],
                        ['delete-existing', 'Replace the existing card'],
                      ] as const).map(([val, label]) => (
                        <label key={val} className="flex items-center gap-1.5 cursor-pointer text-ink">
                          <input type="radio" name={`dup-${deckIndex}-${i}`} checked={item.action === val}
                            onChange={() => updateItem(i, { action: val })} className="accent-accent" />
                          {label}
                        </label>
                      ))}
                    </div>
                    {item.action === 'keep-both' && (
                      <p className="text-xs text-warning">
                        Two cards will share this word — right for a genuine homograph, otherwise they compete for the same review slot.
                      </p>
                    )}
                    {item.action === 'delete-existing' && (
                      <p className="text-xs text-warning">
                        {`Permanently deletes “${item.duplicate.existingCard.front}” = “${item.duplicate.existingCard.back}” everywhere it appears.`}
                      </p>
                    )}
                  </>
                ) : item.batchDuplicateOf !== undefined ? (
                  <p className="text-xs text-ink-muted">
                    {`Same word as #${item.batchDuplicateOf + 1} in this deck — this line will be left out.`}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && <p className="panel text-center text-sm text-ink-muted py-6">No cards left in this deck.</p>}
      </div>

      {dupChecked && flagged > 0 && (
        <div className="flex flex-wrap gap-3 text-xs">
          <button className="btn-ghost px-3 py-1.5" onClick={removeAllDuplicates}>Remove all duplicates ({flagged})</button>
          <button className="btn-ghost px-3 py-1.5" onClick={ignoreAll} title="Add every flagged word as a new card anyway">
            Add all anyway
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button className="btn-primary" disabled={saving || items.length === 0} onClick={() => void saveDeck()}>
          {saving ? 'Saving…' : !dupChecked ? 'Save deck' : flagged > 0 ? 'Confirm & save deck' : 'Save deck'}
        </button>
        <button className="btn-ghost" disabled={saving} onClick={() => { setSkipped(s => s + 1); advance() }}>
          Skip this deck
        </button>
      </div>
    </div>
  )
}
