'use client'

/**
 * Add cards — AI-assisted card-intake pipeline (Milestone 1).
 *
 * Two input modes:
 *  - Word list: a single text field (words/phrases, optionally with
 *    translations), capped at INPUT_WORD_CAP words.
 *  - Extract from text: a passage of running text capped at
 *    INPUT_WORD_CAP words — any "instructions" inside it are ignored.
 *
 * Both modes share an optional formatting-instructions field (capped at
 * INSTRUCTIONS_CHAR_CAP characters) and an "improve translations" toggle.
 *
 * Flow: input -> pre-flight estimate confirmation -> AI generation ->
 * review (duplicate flags + language warnings, editable) -> commit.
 */

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseDismissedPairRepository } from '@/lib/data/dismissedPairs'
import { SupabaseSynonymGroupRepository } from '@/lib/data/synonymGroups'
import { langName } from '@/lib/languages'
import {
  INSTRUCTIONS_CHAR_CAP, INPUT_WORD_CAP,
  estimateCardCount, analyzeDuplicate, type DuplicateAnalysis,
} from '@/lib/duplicates'
import type { Deck, Card } from '@/domain'

type Mode = 'wordlist' | 'extraction'
type Stage = 'input' | 'confirm' | 'generating' | 'review' | 'saving'
type LanguageWarning = 'front' | 'back' | 'both' | null

interface CandidateCard {
  front:           string
  back:            string
  languageWarning: LanguageWarning
}

interface ReviewItem {
  front:           string
  back:            string
  languageWarning: LanguageWarning
  include:         boolean
  duplicate:       DuplicateAnalysis
  action:          'create' | 'merge' | 'keep-both'
  /** Detected comma-separated synonym segments, if applicable. */
  splitSegments?:  string[]
  /** Whether to split into separate synonym-linked cards (default true when splitSegments set). */
  splitIntoCards?: boolean
}

/** Returns comma-split segments if `back` looks like multiple short translations, null otherwise. */
function detectCommaSplit(back: string): string[] | null {
  const segments = back.split(',').map(s => s.trim()).filter(Boolean)
  if (segments.length < 2) return null
  const allShort = segments.every(s => s.split(/\s+/).filter(Boolean).length <= 5)
  if (!allShort) return null
  return segments
}

function wordCount(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).filter(Boolean).length
}

function reasonToMessage(reason: string): string {
  switch (reason) {
    case 'no-api-key':           return 'AI card generation is not configured for this app yet.'
    case 'content-too-long':     return `Content exceeds the ${INPUT_WORD_CAP}-word limit.`
    case 'text-too-long':        return `Text exceeds the ${INPUT_WORD_CAP}-word limit.`
    case 'instructions-too-long': return `Instructions exceed the ${INSTRUCTIONS_CHAR_CAP}-character limit.`
    case 'empty-content':        return 'Please enter some content first.'
    case 'parse-error':          return 'Could not understand the AI response. Please try again.'
    case 'api-error':            return 'AI service error. Please try again.'
    default:                      return 'Something went wrong. Please try again.'
  }
}

export default function AddCardsPage() {
  const { deckId } = useParams<{ deckId: string }>()
  const router   = useRouter()
  const supabase = createClient()

  const [deck,          setDeck]          = useState<Deck | null>(null)
  const [userId,        setUserId]        = useState('')
  const [existingCount, setExistingCount] = useState(0)
  const [existingCards, setExistingCards] = useState<Card[]>([])
  const [loading,       setLoading]       = useState(true)

  const [mode,                 setMode]                 = useState<Mode>('wordlist')
  const [content,              setContent]              = useState('')
  const [text,                 setText]                 = useState('')
  const [instructions,         setInstructions]         = useState('')
  const [improvedTranslations, setImprovedTranslations] = useState(false)

  const [stage, setStage] = useState<Stage>('input')
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<ReviewItem[]>([])

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/auth'); return }
      setUserId(session.user.id)

      const deckRepo = new SupabaseDeckRepository()
      const cardRepo = new SupabaseCardRepository()
      const d = await deckRepo.get(deckId)
      if (!d) { router.push('/study'); return }
      setDeck(d)

      const [deckCards, owned] = await Promise.all([
        cardRepo.listByDeck(deckId),
        cardRepo.listOwned(session.user.id, d.sourceLanguage, d.targetLanguage),
      ])
      setExistingCount(deckCards.length)
      setExistingCards(owned)
      setLoading(false)
    }
    load()
  }, [deckId]) // eslint-disable-line react-hooks/exhaustive-deps

  const contentWordCount = wordCount(content)
  const instrCount    = instructions.length
  const textWordCount = wordCount(text)

  const estimate = useMemo(() => {
    return mode === 'wordlist' ? estimateCardCount('wordlist', content) : estimateCardCount('extraction', text)
  }, [mode, content, text])

  const overCap = mode === 'wordlist' ? contentWordCount > INPUT_WORD_CAP : textWordCount > INPUT_WORD_CAP
  const instrOverCap = instrCount > INSTRUCTIONS_CHAR_CAP

  const canContinue = !overCap && !instrOverCap && estimate > 0
    && (mode === 'wordlist' ? content.trim().length > 0 : text.trim().length > 0)

  async function handleGenerate() {
    if (!deck) return
    setError(null)
    setStage('generating')
    try {
      const body = mode === 'wordlist'
        ? { mode, content, instructions, improvedTranslations, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage }
        : { mode, text, instructions, improvedTranslations, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage }

      const res  = await fetch('/api/cards/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()

      if (!data.ok) {
        setError(reasonToMessage(data.reason))
        setStage('input')
        return
      }

      const splitEnabled = deck.gradingSettings?.commaAlternativesMode === 'split_into_cards'
      const reviewItems: ReviewItem[] = (data.cards as CandidateCard[]).map(c => {
        const duplicate = analyzeDuplicate({ front: c.front, back: c.back }, existingCards, deck.sourceLanguage, deck.targetLanguage)
        const splitSegments = splitEnabled ? detectCommaSplit(c.back) ?? undefined : undefined
        return {
          front:           c.front,
          back:            c.back,
          languageWarning: c.languageWarning,
          include:         true,
          duplicate,
          action:          duplicate.tier === 'near' ? 'merge' : 'create',
          splitSegments,
          splitIntoCards:  splitSegments ? true : undefined,
        }
      })
      setItems(reviewItems)
      setStage('review')
    } catch {
      setError('Something went wrong generating cards. Please try again.')
      setStage('input')
    }
  }

  function updateItem(i: number, patch: Partial<ReviewItem>) {
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  }

  function removeItem(i: number) {
    setItems(prev => prev.filter((_, idx) => idx !== i))
  }

  async function handleCommit() {
    if (!deck) return
    setStage('saving')
    setError(null)
    try {
      const cardRepo      = new SupabaseCardRepository()
      const dismissedRepo = new SupabaseDismissedPairRepository()
      const synonymRepo   = new SupabaseSynonymGroupRepository()

      const includedItems = items.filter(it => it.include)
      const toMerge  = includedItems.filter(it => it.action === 'merge' && it.duplicate.existingCard)
      const toCreate = includedItems.filter(it => it.action !== 'merge')

      // Expand split items into individual synonym card specs.
      type CardSpec = { front: string; back: string; originalItem: ReviewItem }
      const specs: CardSpec[] = []
      for (const it of toCreate) {
        if (it.splitIntoCards && it.splitSegments && it.splitSegments.length >= 2) {
          for (const seg of it.splitSegments) {
            specs.push({ front: it.front, back: seg, originalItem: it })
          }
        } else {
          specs.push({ front: it.front, back: it.back, originalItem: it })
        }
      }

      let position = existingCount

      for (const it of toMerge) {
        await cardRepo.addToDeck(deckId, it.duplicate.existingCard!.id, position++)
      }

      if (specs.length > 0) {
        const created = await cardRepo.bulkCreate(
          deckId, userId, deck.sourceLanguage, deck.targetLanguage,
          specs.map(s => ({ front: s.front, back: s.back, position: position++ })),
        )

        // Persist dismissed-pair choices.
        for (let i = 0; i < specs.length; i++) {
          const s           = specs[i]!
          const createdCard = created[i]
          if (s.originalItem.action === 'keep-both' && s.originalItem.duplicate.existingCard && createdCard && createdCard.id !== s.originalItem.duplicate.existingCard.id) {
            await dismissedRepo.create(userId, s.originalItem.duplicate.existingCard.id, createdCard.id)
          }
        }

        // Link synonym groups for split items.
        const splitItems = toCreate.filter(it => it.splitIntoCards && it.splitSegments && it.splitSegments.length >= 2)
        let specIdx = 0
        for (const it of toCreate) {
          if (splitItems.includes(it) && it.splitSegments) {
            const groupCards = created.slice(specIdx, specIdx + it.splitSegments.length).filter(Boolean)
            specIdx += it.splitSegments.length
            if (groupCards.length >= 2) {
              const group = await synonymRepo.create({
                gloss: it.front,
                glossLanguage: deck.sourceLanguage,
                itemLanguage:  deck.targetLanguage,
              })
              for (const card of groupCards) {
                await synonymRepo.addMember(group.id, card.id)
              }
            }
          } else {
            specIdx++
          }
        }
      }

      router.push(`/study/${deckId}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save cards')
      setStage('review')
    }
  }

  if (loading || !deck) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  const srcLang = langName(deck.sourceLanguage)
  const tgtLang = langName(deck.targetLanguage)
  const includedCount = items.filter(it => it.include).reduce((sum, it) =>
    sum + (it.splitIntoCards && it.splitSegments ? it.splitSegments.length : 1), 0
  )
  const nearCount     = items.filter(it => it.duplicate.tier === 'near').length
  const exactCount    = items.filter(it => it.duplicate.tier === 'exact').length

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      <div className="flex items-center gap-3">
        <Link href={`/study/${deckId}`} className="text-ink-muted hover:text-ink text-sm shrink-0">← Back</Link>
        <h1 className="text-xl font-semibold text-ink">Add cards · {deck.name}</h1>
      </div>

      {error && (
        <div className="border border-danger/40 bg-danger/10 rounded-lg px-4 py-3 text-sm text-danger">
          ⚠ {error}
        </div>
      )}

      {/* ── Input stage ──────────────────────────────────────────────────── */}
      {(stage === 'input' || stage === 'confirm' || stage === 'generating') && (
        <div className="space-y-5">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <button
              onClick={() => setMode('wordlist')}
              className={`flex-1 rounded-lg border px-4 py-2.5 text-sm transition-colors
                ${mode === 'wordlist' ? 'border-accent/50 bg-accent/10 text-ink' : 'border-white/10 text-ink-muted hover:text-ink'}`}
            >
              Word list
            </button>
            <button
              onClick={() => setMode('extraction')}
              className={`flex-1 rounded-lg border px-4 py-2.5 text-sm transition-colors
                ${mode === 'extraction' ? 'border-accent/50 bg-accent/10 text-ink' : 'border-white/10 text-ink-muted hover:text-ink'}`}
            >
              Extract from text
            </button>
          </div>

          {mode === 'wordlist' ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm text-ink-muted">
                  Words / phrases — one per line, optionally with a translation ({srcLang} ↔ {tgtLang})
                </label>
                <span className={`text-xs ${overCap ? 'text-danger' : 'text-ink-faint'}`}>{contentWordCount} / {INPUT_WORD_CAP} words</span>
              </div>
              <textarea
                className={`input min-h-[200px] resize-y font-mono text-sm leading-relaxed ${overCap ? 'border-danger/60 bg-danger/5' : ''}`}
                placeholder={`la manzana\nel agua – water\nlibro`}
                value={content}
                onChange={e => setContent(e.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm text-ink-muted">
                  Passage to extract vocabulary from ({srcLang}) — do not put instructions here, they&apos;ll be ignored
                </label>
                <span className={`text-xs ${overCap ? 'text-danger' : 'text-ink-faint'}`}>{textWordCount} / {INPUT_WORD_CAP} words</span>
              </div>
              <textarea
                className={`input min-h-[220px] resize-y text-sm leading-relaxed ${overCap ? 'border-danger/60 bg-danger/5' : ''}`}
                placeholder="Paste a paragraph or article in the target language…"
                value={text}
                onChange={e => setText(e.target.value)}
              />
            </div>
          )}

          {/* Shared formatting instructions */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm text-ink-muted">Formatting instructions (optional)</label>
              <span className={`text-xs ${instrOverCap ? 'text-danger' : 'text-ink-faint'}`}>{instrCount} / {INSTRUCTIONS_CHAR_CAP}</span>
            </div>
            <textarea
              className={`input min-h-[80px] resize-y text-sm ${instrOverCap ? 'border-danger/60 bg-danger/5' : ''}`}
              placeholder={mode === 'wordlist'
                ? 'e.g. "Translations are informal register" or "Use Mexican Spanish"'
                : 'e.g. "Only extract nouns and verbs" or "Use formal register translations"'}
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={improvedTranslations} onChange={e => setImprovedTranslations(e.target.checked)} className="accent-accent w-4 h-4" />
            <span className="text-sm text-ink">Let AI improve / verify translations</span>
          </label>

          {/* Pre-flight estimate + confirm */}
          {stage === 'input' && (
            <div className="flex items-center gap-3">
              <button
                className="btn-primary"
                disabled={!canContinue}
                onClick={() => setStage('confirm')}
              >
                Continue
              </button>
              {estimate > 0 && (
                <span className="text-sm text-ink-muted">~{estimate} card{estimate !== 1 ? 's' : ''} estimated</span>
              )}
            </div>
          )}

          {stage === 'confirm' && (
            <div className="panel space-y-3">
              <p className="text-sm text-ink">
                This will use AI to generate approximately <span className="font-medium">{estimate} card{estimate !== 1 ? 's' : ''}</span>.
                You&apos;ll be able to review, edit, and remove cards before anything is saved.
              </p>
              <div className="flex gap-3">
                <button className="btn-primary" onClick={handleGenerate}>Generate cards</button>
                <button className="btn-ghost" onClick={() => setStage('input')}>Back</button>
              </div>
            </div>
          )}

          {stage === 'generating' && (
            <div className="text-ink-muted text-sm py-6 text-center">Generating cards…</div>
          )}
        </div>
      )}

      {/* ── Review stage ─────────────────────────────────────────────────── */}
      {(stage === 'review' || stage === 'saving') && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">
              Review — {includedCount} of {items.length} card{items.length !== 1 ? 's' : ''} selected
            </h2>
          </div>

          {(nearCount > 0 || exactCount > 0) && (
            <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted space-y-1">
              {exactCount > 0 && <p>{exactCount} card{exactCount !== 1 ? 's' : ''} already exist{exactCount === 1 ? 's' : ''} in your library and will just be added to this deck.</p>}
              {nearCount > 0 && <p>{nearCount} card{nearCount !== 1 ? 's' : ''} look similar to cards you already have — choose Merge or Keep both for each.</p>}
            </div>
          )}

          <div className="space-y-3">
            {items.map((item, i) => (
              <div key={i} className={`panel space-y-3 ${!item.include ? 'opacity-50' : ''}`}>
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={item.include}
                    onChange={e => updateItem(i, { include: e.target.checked })}
                    className="accent-accent w-4 h-4 mt-2.5"
                  />
                  <div className="flex-1 grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-ink-muted uppercase tracking-wider">Front ({srcLang})</label>
                      <textarea
                        className="input resize-none min-h-[56px] text-sm font-medium"
                        value={item.front}
                        onChange={e => updateItem(i, { front: e.target.value })}
                      />
                      {(item.languageWarning === 'front' || item.languageWarning === 'both') && (
                        <p className="text-xs text-warning">⚠ may not be {srcLang}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-ink-muted uppercase tracking-wider">Back ({tgtLang})</label>
                      <textarea
                        className="input resize-none min-h-[56px] text-sm"
                        value={item.back}
                        onChange={e => updateItem(i, { back: e.target.value })}
                      />
                      {(item.languageWarning === 'back' || item.languageWarning === 'both') && (
                        <p className="text-xs text-warning">⚠ may not be {tgtLang}</p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => removeItem(i)}
                    className="text-ink-faint hover:text-danger transition-colors text-sm shrink-0 mt-2"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>

                {item.duplicate.tier === 'exact' && (
                  <p className="text-xs text-ink-faint pl-7">
                    Matches an existing card — &quot;{item.duplicate.existingCard?.front}&quot; / &quot;{item.duplicate.existingCard?.back}&quot;. Will be reused, not duplicated.
                  </p>
                )}

                {item.duplicate.tier === 'near' && item.duplicate.existingCard && (
                  <div className="pl-7 space-y-2 border-t border-white/10 pt-3">
                    <p className="text-xs text-ink-muted">
                      Similar to existing card: <span className="text-ink">&quot;{item.duplicate.existingCard.front}&quot;</span> / <span className="text-ink">&quot;{item.duplicate.existingCard.back}&quot;</span>
                    </p>
                    <div className="flex gap-4 text-sm">
                      <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                        <input type="radio" name={`dup-${i}`} checked={item.action === 'merge'} onChange={() => updateItem(i, { action: 'merge' })} className="accent-accent" />
                        Merge (reuse existing card)
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                        <input type="radio" name={`dup-${i}`} checked={item.action === 'keep-both'} onChange={() => updateItem(i, { action: 'keep-both' })} className="accent-accent" />
                        Keep both
                      </label>
                    </div>
                  </div>
                )}

                {item.splitSegments && item.splitSegments.length >= 2 && (
                  <div className="pl-7 space-y-2 border-t border-white/10 pt-3">
                    <p className="text-xs text-ink-muted">
                      Looks like multiple translations — create as separate synonym-linked cards?
                    </p>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {item.splitSegments.map((seg, si) => (
                        <span key={si} className="rounded bg-surface-raised px-2 py-0.5 text-xs text-ink font-mono">{seg}</span>
                      ))}
                    </div>
                    <div className="flex gap-4 text-sm">
                      <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                        <input type="radio" name={`split-${i}`} checked={item.splitIntoCards !== false} onChange={() => updateItem(i, { splitIntoCards: true })} className="accent-accent" />
                        Split into {item.splitSegments.length} cards
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer text-ink-muted">
                        <input type="radio" name={`split-${i}`} checked={item.splitIntoCards === false} onChange={() => updateItem(i, { splitIntoCards: false })} className="accent-accent" />
                        Keep as one card
                      </label>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {items.length === 0 && (
              <div className="panel text-center text-ink-muted text-sm py-8">
                No cards left to add. <button className="text-accent hover:text-accent-soft" onClick={() => setStage('input')}>Start over</button>
              </div>
            )}
          </div>

          {items.length > 0 && (
            <div className="flex gap-3">
              <button className="btn-primary" disabled={includedCount === 0 || stage === 'saving'} onClick={handleCommit}>
                {stage === 'saving' ? 'Saving…' : `Add ${includedCount} card${includedCount !== 1 ? 's' : ''}`}
              </button>
              <button className="btn-ghost" disabled={stage === 'saving'} onClick={() => { setItems([]); setStage('input') }}>
                Start over
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
