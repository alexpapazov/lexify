'use client'

/**
 * Deck editor — edit all cards inline, add new ones, validate before saving.
 *
 * Validation rules (enforced on save):
 *   - Neither front nor back may be empty
 *   - No two cards may have the same front (case-insensitive, trimmed)
 * Violations are highlighted in red; a banner explains the problem.
 */

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { LANGUAGES } from '@/lib/languages'

// ─── Types ────────────────────────────────────────────────────────────────────

interface EditableCard {
  id:       string | null   // null = new, unsaved card
  front:    string
  back:     string
  position: number
  error:    'empty-front' | 'empty-back' | 'duplicate-front' | null
}

function newCard(position: number): EditableCard {
  return { id: null, front: '', back: '', position, error: null }
}

// ─── Single card row ──────────────────────────────────────────────────────────

function CardRow({ card, index, onChange, onDelete }: {
  card:     EditableCard
  index:    number
  onChange: (index: number, field: 'front' | 'back', value: string) => void
  onDelete: (index: number) => void
}) {
  const hasError = card.error !== null
  const frontErr = card.error === 'empty-front' || card.error === 'duplicate-front'
  const backErr  = card.error === 'empty-back'

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
    </div>
  )
}

// ─── Editor page ──────────────────────────────────────────────────────────────

export default function DeckEditPage() {
  const { deckId } = useParams<{ deckId: string }>()
  const router     = useRouter()
  const supabase   = createClient()

  const [deckName,    setDeckName]    = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting,      setDeleting]      = useState(false)
  const [sourceLang,  setSourceLang]  = useState('es')
  const [targetLang,  setTargetLang]  = useState('en')
  const [cards,       setCards]       = useState<EditableCard[]>([])
  const [loading,     setLoading]     = useState(true)
  const [saving,      setSaving]      = useState(false)
  const [langSaving,  setLangSaving]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [saved,       setSaved]       = useState(false)

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/auth'); return }

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
      setCards(existing.map((c, i) => ({ id: c.id, front: c.front, back: c.back, position: i, error: null })))
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
    setCards(prev => prev.map((c, i) => i === index ? { ...c, [field]: value, error: null } : c))
    setError(null)
  }, [])

  const handleDelete = useCallback((index: number) => {
    setCards(prev => prev.filter((_, i) => i !== index).map((c, i) => ({ ...c, position: i })))
  }, [])

  function addCard() {
    setCards(prev => [...prev, newCard(prev.length)])
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

    setSaving(true)
    try {
      const cardRepo = new SupabaseCardRepository()

      // Update existing cards, create new ones
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i]!
        if (card.id) {
          await cardRepo.update(card.id, { front: card.front.trim(), back: card.back.trim() })
        } else {
          const created = await cardRepo.bulkCreate(deckId, [{
            front:    card.front.trim(),
            back:     card.back.trim(),
            position: i,
          }])
          // Update local state with the new id
          setCards(prev => prev.map((c, idx) => idx === i ? { ...c, id: created[0]?.id ?? null } : c))
        }
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
    try {
      const deckRepo = new SupabaseDeckRepository()
      await deckRepo.softDelete(deckId)
      router.push('/study')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  const errorCount = cards.filter(c => c.error !== null).length

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={`/study/${deckId}`} className="text-ink-muted hover:text-ink text-sm shrink-0">← Back</Link>
          <h1 className="text-xl font-semibold text-ink truncate">{deckName}</h1>
          <span className="text-xs text-ink-faint shrink-0">{cards.length} cards</span>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary shrink-0"
        >
          {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save all'}
        </button>
      </div>

      {/* Language selector row */}
      <div className="panel flex items-center gap-3 py-2.5">
        <select
          className="input text-sm flex-1"
          value={sourceLang}
          onChange={e => { setSourceLang(e.target.value); saveLangs(e.target.value, targetLang) }}
        >
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>

        <button
          onClick={swapLangs}
          disabled={langSaving}
          title="Swap languages"
          className="text-ink-muted hover:text-accent transition-colors text-lg shrink-0 px-1"
        >
          ⇄
        </button>

        <select
          className="input text-sm flex-1"
          value={targetLang}
          onChange={e => { setTargetLang(e.target.value); saveLangs(sourceLang, e.target.value) }}
        >
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>

        {langSaving && <span className="text-xs text-ink-faint shrink-0">Saving…</span>}
      </div>

      {/* Error banner */}
      {error && (
        <div className="border border-danger/40 bg-danger/10 rounded-lg px-4 py-3 text-sm text-danger">
          ⚠ {error}{errorCount > 0 ? ` (${errorCount} card${errorCount !== 1 ? 's' : ''} highlighted below)` : ''}
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

      {/* Bottom save + delete */}
      <div className="flex items-center justify-between gap-3 pb-8">
        <div className="flex gap-3">
          <button onClick={handleSave} disabled={saving} className="btn-primary">
            {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save all'}
          </button>
          <Link href={`/study/${deckId}`} className="btn-ghost">Cancel</Link>
        </div>

        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-sm text-ink-faint hover:text-danger transition-colors"
          >
            Delete deck
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-muted">Are you sure?</span>
            <button
              onClick={handleDeleteDeck}
              disabled={deleting}
              className="text-sm font-medium text-danger hover:text-danger/80 transition-colors"
            >
              {deleting ? 'Deleting…' : 'Yes, delete'}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-sm text-ink-faint hover:text-ink transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
