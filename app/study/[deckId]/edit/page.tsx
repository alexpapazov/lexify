'use client'

/**
 * Deck editor — edit all cards inline, add new ones, validate before saving.
 *
 * Validation rules (enforced on save):
 *   - Neither front nor back may be empty
 *   - No two cards may have the same front (case-insensitive, trimmed)
 * Violations are highlighted in red; a banner explains the problem.
 *
 * Duplicate check (on save): newly-added cards ("+ New card") are checked
 * against the user's existing card library, same two-tier scheme as the
 * Upload flow (see lib/duplicates.ts). Tier-1 exact matches are reused (no
 * duplicate row is created) but flagged so the user can remove the card if
 * they don't want it in this deck. Tier-2 near matches are flagged — the
 * user chooses, per card, whether to keep it as a new card or use the
 * existing one instead — before the save completes.
 */

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseDismissedPairRepository } from '@/lib/data/dismissedPairs'
import { LanguageCombobox } from '@/components/LanguageCombobox'
import { analyzeDuplicate, type DuplicateAnalysis } from '@/lib/duplicates'
import type { Card } from '@/domain'

// ─── Types ────────────────────────────────────────────────────────────────────

interface EditableCard {
  id:        string | null   // null = new, unsaved card
  front:     string
  back:      string
  position:  number
  error:     'empty-front' | 'empty-back' | 'duplicate-front' | null
  duplicate: DuplicateAnalysis | null
  action:    'create' | 'merge' | 'keep-both'
  /** Names of decks the matched existing card (Tier-1 exact match) already belongs to. */
  existingCardDeckNames?: string[]
}

function newCard(position: number): EditableCard {
  return { id: null, front: '', back: '', position, error: null, duplicate: null, action: 'create' }
}

// ─── Single card row ──────────────────────────────────────────────────────────

function CardRow({ card, index, onChange, onDelete, onActionChange }: {
  card:           EditableCard
  index:          number
  onChange:       (index: number, field: 'front' | 'back', value: string) => void
  onDelete:       (index: number) => void
  onActionChange: (index: number, action: 'merge' | 'keep-both') => void
}) {
  const hasError  = card.error !== null
  const frontErr  = card.error === 'empty-front' || card.error === 'duplicate-front'
  const backErr   = card.error === 'empty-back'
  const showNear  = !card.id && card.duplicate?.tier === 'near'  && card.duplicate.existingCard
  const showExact = !card.id && card.duplicate?.tier === 'exact' && card.duplicate.existingCard

  return (
    <div className={`panel space-y-3 transition-colors ${hasError ? 'border-danger/50 bg-danger/5' : ''}`}>
      {/* Row header */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-faint font-mono">{index + 1}</span>
        {card.error === 'empty-front'   && <span className="text-xs text-danger">Front is empty</span>}
        {card.error === 'empty-back'    && <span className="text-xs text-danger">Back is empty</span>}
        {card.error === 'duplicate-front' && <span className="text-xs text-danger">Duplicate front — must be unique</span>}
        <button
          onClick={() => onDelete(index)}
          className="text-ink-faint hover:text-danger transition-colors text-sm ml-auto"
          title="Delete card"
        >
          ✕
        </button>
      </div>

      {/* Front / back side by side */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-xs text-ink-muted uppercase tracking-wider">Front</label>
          <textarea
            className={`input resize-none min-h-[72px] font-medium transition-colors ${frontErr ? 'border-danger/60 bg-danger/5' : ''}`}
            value={card.front}
            placeholder="Target language term…"
            onChange={e => onChange(index, 'front', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-muted uppercase tracking-wider">Back</label>
          <textarea
            className={`input resize-none min-h-[72px] transition-colors ${backErr ? 'border-danger/60 bg-danger/5' : ''}`}
            value={card.back}
            placeholder="Translation / definition…"
            onChange={e => onChange(index, 'back', e.target.value)}
          />
        </div>
      </div>

      {/* Exact-duplicate flag (new cards only) */}
      {showExact && card.duplicate?.existingCard && (
        <div className="pl-0 space-y-2 border-t border-white/10 pt-3">
          <p className="text-xs text-ink-muted">
            Already in {card.existingCardDeckNames && card.existingCardDeckNames.length > 0
              ? <span className="text-ink">{card.existingCardDeckNames.join(', ')}</span>
              : 'your library'}. Remove this card (✕ above) if you do not want to add this duplicate to this deck.
          </p>
        </div>
      )}

      {/* Near-duplicate flag (new cards only) */}
      {showNear && card.duplicate?.existingCard && (
        <div className="pl-0 space-y-2 border-t border-white/10 pt-3">
          <p className="text-xs text-ink-muted">
            Similar to existing card: <span className="text-ink">&quot;{card.duplicate.existingCard.front}&quot;</span> / <span className="text-ink">&quot;{card.duplicate.existingCard.back}&quot;</span>
          </p>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5 cursor-pointer text-ink">
              <input type="radio" name={`dup-${index}`} checked={card.action === 'keep-both'} onChange={() => onActionChange(index, 'keep-both')} className="accent-accent" />
              Keep as new card
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-ink">
              <input type="radio" name={`dup-${index}`} checked={card.action === 'merge'} onChange={() => onActionChange(index, 'merge')} className="accent-accent" />
              Use existing card instead
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Editor page ──────────────────────────────────────────────────────────────

export default function DeckEditPage() {
  const { deckId } = useParams<{ deckId: string }>()
  const router     = useRouter()
  const supabase   = createClient()

  const [ownerId,     setOwnerId]     = useState('')
  const [deckName,    setDeckName]    = useState('')
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting,        setDeleting]        = useState(false)
  const [deleteError,     setDeleteError]     = useState<string | null>(null)
  const [sourceLang,  setSourceLang]  = useState('es')
  const [targetLang,  setTargetLang]  = useState('en')
  const [cards,       setCards]       = useState<EditableCard[]>([])
  const [originalCards, setOriginalCards] = useState<Map<string, { front: string; back: string }>>(new Map())
  const [loading,     setLoading]     = useState(true)
  const [saving,      setSaving]      = useState(false)
  const [langSaving,  setLangSaving]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [saved,       setSaved]       = useState(false)
  const [dupChecked,  setDupChecked]  = useState(false)

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/auth'); return }
      setOwnerId(session.user.id)

      const deckRepo = new SupabaseDeckRepository()
      const cardRepo = new SupabaseCardRepository()
      const [deck, existing] = await Promise.all([
        deckRepo.get(deckId),
        cardRepo.listByDeck(deckId),
      ])
      if (!deck) { router.push('/study'); return }

      setDeckName(deck.name)
      setSourceLang(deck.sourceLanguage ?? 'es')
      setTargetLang(deck.targetLanguage ?? 'en')
      setCards(existing.map((c, i) => ({ id: c.id, front: c.front, back: c.back, position: i, error: null, duplicate: null, action: 'create' as const })))
      setOriginalCards(new Map(existing.map(c => [c.id, { front: c.front, back: c.back }])))
      setLoading(false)
    }
    load()
  }, [deckId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function saveLangs(src: string, tgt: string) {
    setLangSaving(true)
    try {
      const deckRepo = new SupabaseDeckRepository()
      await deckRepo.update(deckId, { sourceLanguage: src, targetLanguage: tgt })
    } finally {
      setLangSaving(false)
    }
  }

  async function swapLangs() {
    const [newSrc, newTgt] = [targetLang, sourceLang]
    setSourceLang(newSrc)
    setTargetLang(newTgt)
    await saveLangs(newSrc, newTgt)
  }

  const handleChange = useCallback((index: number, field: 'front' | 'back', value: string) => {
    setCards(prev => prev.map((c, i) => i === index ? { ...c, [field]: value, error: null, duplicate: null, action: 'create' as const } : c))
    setError(null)
    setDupChecked(false)
  }, [])

  const handleActionChange = useCallback((index: number, action: 'merge' | 'keep-both') => {
    setCards(prev => prev.map((c, i) => i === index ? { ...c, action } : c))
  }, [])

  const handleDelete = useCallback((index: number) => {
    setCards(prev => prev.filter((_, i) => i !== index).map((c, i) => ({ ...c, position: i })))
    setDupChecked(false)
  }, [])

  function addCard() {
    setCards(prev => [...prev, newCard(prev.length)])
    setDupChecked(false)
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  function validate(): boolean {
    const fronts = new Map<string, number>() // normalised front → first index
    let valid = true

    const validated = cards.map((card, i) => {
      const frontTrimmed = card.front.trim()
      const backTrimmed  = card.back.trim()

      if (!frontTrimmed) {
        valid = false
        return { ...card, error: 'empty-front' as const }
      }
      if (!backTrimmed) {
        valid = false
        return { ...card, error: 'empty-back' as const }
      }

      const key = frontTrimmed.toLowerCase()
      if (fronts.has(key)) {
        valid = false
        // Mark both the earlier and current as duplicates
        return { ...card, error: 'duplicate-front' as const }
      }
      fronts.set(key, i)
      return { ...card, error: null }
    })

    // Second pass: also mark the first occurrence of any duplicate
    const seen = new Map<string, number>()
    const doublePassed = validated.map((card, i) => {
      const key = card.front.trim().toLowerCase()
      if (seen.has(key) && card.error === null) {
        return { ...card, error: 'duplicate-front' as const }
      }
      if (!seen.has(key)) seen.set(key, i)
      return card
    })

    setCards(doublePassed)
    return valid
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    setError(null)
    const isValid = validate()
    if (!isValid) {
      setError('Some cards have errors — fix them before saving.')
      return
    }

    // Duplicate check for newly-added cards, run once per batch of changes.
    if (!dupChecked) {
      const newCount = cards.filter(c => !c.id).length
      if (newCount > 0) {
        try {
          const cardRepo = new SupabaseCardRepository()
          const existing = await cardRepo.listOwned(ownerId, sourceLang, targetLang)

          let hasFlag = false
          const withDup = cards.map(c => {
            if (c.id) return c
            const duplicate = analyzeDuplicate({ front: c.front.trim(), back: c.back.trim() }, existing, sourceLang, targetLang)
            if (duplicate.tier === 'near' || duplicate.tier === 'exact') hasFlag = true
            return { ...c, duplicate, action: duplicate.tier === 'near' ? 'keep-both' as const : 'create' as const }
          })

          // For exact (Tier-1) matches, look up which deck(s) the existing
          // card already lives in, so we can tell the user where it is.
          const exactCardIds = [...new Set(
            withDup
              .filter(c => c.duplicate?.tier === 'exact' && c.duplicate.existingCard)
              .map(c => c.duplicate!.existingCard!.id)
          )]
          const deckNamesByCard = await cardRepo.listDeckNamesForCards(exactCardIds)
          const withDeckNames = withDup.map(c =>
            c.duplicate?.tier === 'exact' && c.duplicate.existingCard
              ? { ...c, existingCardDeckNames: deckNamesByCard[c.duplicate.existingCard.id] ?? [] }
              : c
          )

          setCards(withDeckNames)
          setDupChecked(true)

          if (hasFlag) return
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : 'Failed to check for duplicates')
          return
        }
      } else {
        setDupChecked(true)
      }
    }

    setSaving(true)
    try {
      const cardRepo     = new SupabaseCardRepository()
      const dismissedRepo = new SupabaseDismissedPairRepository()

      // Only push updates for cards whose front/back actually changed —
      // for a large deck, re-saving every card on every save is what makes
      // this slow. Untouched cards are skipped entirely.
      const updatePromises = cards
        .filter(c => c.id)
        .map(c => {
          const front = c.front.trim()
          const back  = c.back.trim()
          const original = originalCards.get(c.id!)
          if (original && original.front === front && original.back === back) return null
          // Content changed — clear cached AI distractors, they no longer match.
          return cardRepo.update(c.id!, { front, back, choices: null })
        })
        .filter((p): p is Promise<Card> => p !== null)

      // New cards: split into "use existing card instead" (merge) vs. create.
      const newEntries = cards.map((c, i) => ({ c, i })).filter(({ c }) => !c.id)
      const toMerge  = newEntries.filter(({ c }) => c.action === 'merge' && c.duplicate?.existingCard)
      const toCreate = newEntries.filter(({ c }) => c.action !== 'merge')

      const mergePromises = toMerge.map(({ c, i }) =>
        cardRepo.addToDeck(deckId, c.duplicate!.existingCard!.id, i).then(() => ({ i, card: c.duplicate!.existingCard! }))
      )

      const createPromise = toCreate.length > 0
        ? cardRepo.bulkCreate(deckId, ownerId, sourceLang, targetLang, toCreate.map(({ c, i }) => ({
            front:    c.front.trim(),
            back:     c.back.trim(),
            position: i,
          })))
        : Promise.resolve([] as Card[])

      const [, mergedResults, created] = await Promise.all([
        Promise.all(updatePromises),
        Promise.all(mergePromises),
        createPromise,
      ])

      // Record "keep as new card" choices so this near-duplicate pair isn't
      // flagged again in the future.
      for (let j = 0; j < toCreate.length; j++) {
        const { c }       = toCreate[j]!
        const createdCard = created[j]
        if (c.action === 'keep-both' && c.duplicate?.existingCard && createdCard && createdCard.id !== c.duplicate.existingCard.id) {
          await dismissedRepo.create(ownerId, c.duplicate.existingCard.id, createdCard.id)
        }
      }

      if (created.length > 0 || mergedResults.length > 0) {
        setCards(prev => {
          const next = [...prev]
          toCreate.forEach(({ i }, j) => {
            const createdCard = created[j]
            if (createdCard) next[i] = { ...next[i]!, id: createdCard.id }
          })
          mergedResults.forEach(({ i, card }) => {
            next[i] = { ...next[i]!, id: card.id, front: card.front, back: card.back }
          })
          return next
        })
      }

      setSaved(true)
      setTimeout(() => { setSaved(false); router.push(`/study/${deckId}`) }, 800)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteDeck() {
    setDeleting(true)
    setDeleteError(null)
    try {
      const deckRepo = new SupabaseDeckRepository()
      await deckRepo.softDelete(deckId)
      router.push('/study')
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed')
      setDeleting(false)
    }
  }


  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  const errorCount  = cards.filter(c => c.error !== null).length
  const nearCount   = cards.filter(c => !c.id && c.duplicate?.tier === 'near').length
  const exactCount  = cards.filter(c => !c.id && c.duplicate?.tier === 'exact').length
  const flaggedCount = nearCount + exactCount
  const saveLabel  = saved ? 'Saved ✓' : saving ? 'Saving…' : (dupChecked && flaggedCount > 0) ? 'Confirm & save' : 'Save'

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={`/study/${deckId}`} className="text-ink-muted hover:text-ink text-sm shrink-0">← Back</Link>
          <h1 className="text-xl font-semibold text-ink truncate">{deckName}</h1>
          <span className="text-xs text-ink-faint shrink-0">{cards.length} cards</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => { setDeleteError(null); setShowDeleteModal(true) }}
            className="p-2.5 rounded-lg border border-white/10 hover:border-danger/40 text-ink-muted hover:text-danger transition-colors"
            title="Delete deck"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary"
          >
            {saveLabel}
          </button>
        </div>
      </div>

      {/* Language selector row */}
      <div className="panel flex items-center gap-3 py-2.5">
        <LanguageCombobox
          className="flex-1"
          value={sourceLang}
          onChange={code => { setSourceLang(code); saveLangs(code, targetLang) }}
        />

        <button
          onClick={swapLangs}
          disabled={langSaving}
          title="Swap languages"
          className="text-ink-muted hover:text-accent transition-colors text-lg shrink-0 px-1"
        >
          ⇄
        </button>

        <LanguageCombobox
          className="flex-1"
          value={targetLang}
          onChange={code => { setTargetLang(code); saveLangs(sourceLang, code) }}
        />

        {langSaving && <span className="text-xs text-ink-faint shrink-0">Saving…</span>}
      </div>

      {/* Error banner */}
      {error && (
        <div className="border border-danger/40 bg-danger/10 rounded-lg px-4 py-3 text-sm text-danger">
          ⚠ {error}{errorCount > 0 ? ` (${errorCount} card${errorCount !== 1 ? 's' : ''} highlighted below)` : ''}
        </div>
      )}

      {/* Duplicate banner */}
      {dupChecked && flaggedCount > 0 && (
        <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted">
          {nearCount > 0 && (
            <>{nearCount} new card{nearCount !== 1 ? 's' : ''} look similar to cards you already have — choose whether to keep {nearCount !== 1 ? 'them' : 'it'} as new card{nearCount !== 1 ? 's' : ''} or use the existing one{nearCount !== 1 ? 's' : ''} instead. </>
          )}
          {exactCount > 0 && (
            <>{exactCount} new card{exactCount !== 1 ? 's' : ''} {exactCount !== 1 ? 'are' : 'is'} already in your library and will be reused — remove {exactCount !== 1 ? 'them' : 'it'} below if you don&apos;t want {exactCount !== 1 ? 'them' : 'it'} in this deck. </>
          )}
          Then press &quot;Confirm &amp; save&quot;.
        </div>
      )}

      {/* Card list */}
      <div className="space-y-3">
        {cards.map((card, i) => (
          <CardRow
            key={card.id ?? `new-${i}`}
            card={card}
            index={i}
            onChange={handleChange}
            onDelete={handleDelete}
            onActionChange={handleActionChange}
          />
        ))}
      </div>

      {/* Add new card */}
      <button
        onClick={addCard}
        className="w-full panel border-dashed border-white/20 hover:border-accent/40 hover:bg-surface/50
                   text-ink-muted hover:text-ink transition-colors text-sm py-5 text-center"
      >
        + New card
      </button>

      {/* Bottom save */}
      <div className="flex gap-3 pb-8">
        <button onClick={handleSave} disabled={saving} className="btn-primary">
          {saveLabel}
        </button>
        <Link href={`/study/${deckId}`} className="btn-ghost">Cancel</Link>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="panel max-w-sm w-full space-y-4">
            <h2 className="text-lg font-semibold text-ink">Delete deck?</h2>
            <p className="text-sm text-ink-muted">
              This will permanently delete <span className="text-ink font-medium">{deckName}</span> and all {cards.length} card{cards.length !== 1 ? 's' : ''} in it. This can&apos;t be undone.
            </p>
            {deleteError && (
              <div className="border border-danger/40 bg-danger/10 rounded-lg px-4 py-3 text-sm text-danger">
                ⚠ {deleteError}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => { setShowDeleteModal(false); setDeleteError(null) }}
                disabled={deleting}
                className="btn-ghost"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteDeck}
                disabled={deleting}
                className="bg-danger hover:bg-danger/80 text-white font-medium px-5 py-2.5 rounded-lg transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
