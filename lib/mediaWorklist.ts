/**
 * lib/mediaWorklist.ts — turning a processed entry's stored page results into the page-by-page
 * rating WORKLIST (Extraction Engine Stage B). Pure; the media page renders it and lib/mediaRate
 * saves it.
 *
 * Rules (all user decisions, see the design draft):
 *  - A lemma appears ONCE per entry, on the EARLIEST page it occurs; its mark state is the OR
 *    across the upload's pages (marked on p.1 + unmarked on p.3 = marked).
 *  - Marked + not in lexicon → chip pre-painted "I don't know".
 *  - Marked + in lexicon, GRADUATED → recognition failure (penalty: Again + due today).
 *  - Marked + in lexicon, still learning → no penalty (nothing scheduled to punish); saving
 *    links the card into the book's deck and attaches the sentences.
 *  - Unmarked + not in lexicon → chip pre-painted "Long term".
 *  - Unmarked + in lexicon, graduated LONG-term → implicit credit (automatic, no rating).
 *  - Unmarked + in lexicon, short-term or learning → nothing (counted, never shown).
 *  - An item whose key is in `ratings` is settled and leaves the worklist.
 */

import type { Card, CardState, MediaPage } from '@/domain'
import { parseOccurrences, parseAllLemmas, compareWithLexicon, type IntakeCandidate } from '@/lib/mediaIntake'
import { cardMaturity } from '@/lib/folderStats'

export type ItemClass = 'dontknow' | 'rate' | 'penalty' | 'credit' | 'quiet'

/** FULLY SERIALIZABLE (user decision 2026-11-08: match against the lexicon ONCE, snapshot the
 *  result onto the entry, reopen instantly). The matched card is carried as id + display
 *  strings; save-time operations re-resolve the live Card by id. */
export interface WorklistItem {
  /** Dedupe + ratings key: normalized lemma (phrases: their printed text). */
  key:       string
  /** What the chip shows and what a created card's front becomes. */
  display:   string
  lemma:     string
  kind:      'word' | 'phrase'
  /** In-context gloss (marked items only — unmarked chips gloss at save time). */
  gloss:     string | null
  sentences: { sentence: string; answer: string }[]
  marked:    boolean
  /** Index into the worklist's page sections (earliest occurrence). */
  pageIdx:   number
  /** The matched lexicon card, as snapshot-safe fields. */
  existingId:    string | null
  existingFront: string | null
  existingBack:  string | null
  cls:       ItemClass
  /** The rating already recorded for this key, if any — settled items leave the list. */
  rated:     string | null
}

/** A page section's identity in the snapshot. */
export interface WorklistPageMeta { label: string; failed: boolean }

export interface WorklistPageSection {
  label:     string
  /** Still-unrated items of every visible class (dontknow / rate / penalty). */
  items:     WorklistItem[]
  /** Already-settled counts for the header line. */
  credited:  number
  settled:   number
  failed:    boolean
}

export interface Worklist {
  pages:         WorklistPageSection[]
  /** EVERY item (rated ones included) — what the entry snapshot stores. */
  allItems:      WorklistItem[]
  /** Page labels + failed flags, index-aligned with items' pageIdx — snapshot metadata. */
  pageMeta:      WorklistPageMeta[]
  /** Unrated credit targets (unmarked + graduated long-term) — applied automatically. */
  creditTargets: WorklistItem[]
  /** Unmarked known words below the long-term line — seen, nothing happens (summary only). */
  quietCount:    number
  /** Majority detected page language, lowercased — null when none reported. */
  detectedLang:  string | null
  /** Items left to rate across every page. */
  remaining:     number
}

export const normKey = (s: string) => s.trim().toLowerCase()

/** Reading order for the worklist's page sections: printed page number, then upload order. */
export function orderDonePages(pages: MediaPage[]): MediaPage[] {
  const known = pages.filter(p => p.pageNumber != null).sort((a, b) => (a.pageNumber! - b.pageNumber!) || (a.pageIndex - b.pageIndex))
  const unknown = pages.filter(p => p.pageNumber == null).sort((a, b) => a.pageIndex - b.pageIndex)
  return [...known, ...unknown]
}

export function buildWorklist(
  pagesIn:   MediaPage[],
  ratings:   Record<string, string>,
  cards:     Card[],
  forward:   Map<string, CardState>,
  sourceLanguage: string,
  targetLanguage: string,
): Worklist {
  const ordered = orderDonePages(pagesIn)

  // ── Gather items: earliest page wins, mark state ORs, sentences merge (≤3) ──
  interface Partial0 { key: string; display: string; lemma: string; kind: 'word' | 'phrase'; gloss: string | null; sentences: { sentence: string; answer: string }[]; marked: boolean; pageIdx: number }
  const byKey = new Map<string, Partial0>()
  const langTally = new Map<string, number>()

  ordered.forEach((pg, pageIdx) => {
    if (!pg.result) return
    const pl = (pg.result as { pageLanguage?: unknown }).pageLanguage
    if (typeof pl === 'string' && pl) langTally.set(pl.toLowerCase(), (langTally.get(pl.toLowerCase()) ?? 0) + 1)

    for (const o of parseOccurrences(pg.result)) {
      const key = normKey(o.kind === 'phrase' ? o.text : o.lemma)
      const got = byKey.get(key)
      if (!got) {
        byKey.set(key, {
          key, display: o.display ?? o.text, lemma: o.lemma, kind: o.kind, gloss: o.gloss || null,
          sentences: o.sentence ? [{ sentence: o.sentence, answer: o.text }] : [],
          marked: true, pageIdx,
        })
      } else {
        got.marked = true                                   // OR across the upload
        if (!got.gloss && o.gloss) got.gloss = o.gloss
        if (got.display === got.lemma && o.display) got.display = o.display
        if (o.sentence && got.sentences.length < 3 && !got.sentences.some(s => normKey(s.sentence) === normKey(o.sentence))) {
          got.sentences.push({ sentence: o.sentence, answer: o.text })
        }
      }
    }
    for (const lemma of parseAllLemmas(pg.result)) {
      const key = normKey(lemma)
      if (byKey.has(key)) continue                          // earliest page (or a mark) wins
      byKey.set(key, { key, display: lemma, lemma, kind: 'word', gloss: null, sentences: [], marked: false, pageIdx })
    }
  })

  // ── Match against the lexicon (same lemma-primary + bare-front index as everywhere) ──
  const partials = [...byKey.values()]
  const matches = compareWithLexicon(
    partials.map(p => ({ text: p.display, lemma: p.lemma, kind: p.kind, gloss: p.gloss ?? '', sentences: p.sentences, count: 1, markers: [] } as IntakeCandidate)),
    cards, sourceLanguage, targetLanguage,
  )

  const items: WorklistItem[] = partials.map((p, i) => {
    const existing = matches[i]!.existing
    const st = existing ? forward.get(existing.id) : undefined
    const existingFields = {
      existingId:    existing?.id ?? null,
      existingFront: existing?.front ?? null,
      existingBack:  existing?.back ?? null,
    }
    let cls: ItemClass
    if (p.marked) {
      // Graduated + marked = recognition failure. A card still in the pipeline has nothing to
      // punish — saving just links it into the book's deck with its sentences ('dontknow').
      cls = st?.graduated && !st.dormant ? 'penalty' : 'dontknow'
    } else if (!existing) {
      cls = 'rate'
    } else if (st?.graduated && !st.dormant) {
      cls = cardMaturity(st) === 'long_term' ? 'credit' : 'quiet'   // short-term earns reviews in sessions
    } else if (st && (st.reps > 0 || st.currentStepOrder > 0)) {
      cls = 'quiet'                                                  // mid-pipeline: leave it be
    } else {
      cls = 'rate'                                                   // in the library, never studied — painting graduates THAT card
    }
    return { ...p, ...existingFields, cls, rated: ratings[p.key] ?? null }
  })

  const pageMeta: WorklistPageMeta[] = ordered.map((pg, i) => ({
    label: pg.pageNumber != null ? `p. ${pg.pageNumber}` : `Page ${i + 1}`,
    failed: pg.status === 'failed',
  }))
  const detected = [...langTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return assembleWorklist(items, pageMeta, detected)
}

/** Sections + counts from items — shared by the fresh build and the snapshot path. */
function assembleWorklist(items: WorklistItem[], pageMeta: WorklistPageMeta[], detectedLang: string | null): Worklist {
  const sections: WorklistPageSection[] = pageMeta.map((meta, i) => ({
    label: meta.label,
    items: items.filter(it => it.pageIdx === i && it.rated == null && (it.cls === 'dontknow' || it.cls === 'rate' || it.cls === 'penalty')),
    credited: items.filter(it => it.pageIdx === i && it.rated === 'credited').length,
    settled: items.filter(it => it.pageIdx === i && it.rated != null && it.rated !== 'credited').length,
    failed: meta.failed,
  }))
  return {
    pages: sections,
    allItems: items,
    pageMeta,
    creditTargets: items.filter(it => it.cls === 'credit' && it.rated == null),
    quietCount: items.filter(it => it.cls === 'quiet').length,
    detectedLang,
    remaining: sections.reduce((n, s) => n + s.items.length, 0),
  }
}

/**
 * Rebuilds the worklist from the snapshot stored on the entry at first open — NO library load,
 * NO page fetch, instant. `ratings` re-applies on top so rated items stay settled.
 */
export function worklistFromSnapshot(
  snapshot: unknown[],
  pageMeta: WorklistPageMeta[],
  ratings:  Record<string, string>,
  detectedLang: string | null,
): Worklist {
  const items = (snapshot as WorklistItem[]).map(it => ({ ...it, rated: ratings[it.key] ?? null }))
  return assembleWorklist(items, pageMeta, detectedLang)
}
