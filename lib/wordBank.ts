/**
 * lib/wordBank.ts — generation for the WORD BANK practice mode (2026-10-19): the chosen words
 * become a bank of chips; each generated sentence has ONE blank and no gloss or translation — the
 * learner places the right chip purely from context (the Duolingo drag, as tap-to-place).
 *
 * Two styles: 'sentences' (independent) and 'story' (the sentences read IN ORDER as one continuous
 * narrative — the route's `narrative` flag). Generation bypasses the practice sentence bank on
 * purpose: bank mode needs exactly ONE fresh sentence per chosen word, and a story must be written
 * in one piece. Pools over `GENERATE_CAP` are chunked (a story chunk is its own mini-story; chunks
 * run in order so the narrative still reads top to bottom). Targets the model misses are simply
 * absent — the caller reports the count. Schedule-neutral, like all practice.
 */

import { apiUrl } from '@/lib/apiBase'
import type { PracticeTarget } from '@/engine/practice'
import { GENERATE_CAP, type PracticeExercise } from '@/lib/practiceSchema'
import { prepareExercise, type PreparedExercise } from '@/lib/practiceGenerate'

export type WordBankStyle = 'sentences' | 'story'

export interface WordBankRun {
  /** One exercise per chosen word, in generation order (story order for 'story'). */
  items:   PreparedExercise[]
  missing: number
}

export async function generateWordBank(opts: {
  targets:        PracticeTarget[]
  sourceLanguage: string
  targetLanguage: string
  style:          WordBankStyle
}): Promise<WordBankRun> {
  const chunks: PracticeTarget[][] = []
  for (let i = 0; i < opts.targets.length; i += GENERATE_CAP) chunks.push(opts.targets.slice(i, i + GENERATE_CAP))

  const items: PreparedExercise[] = []
  for (const chunk of chunks) {
    const res = await fetch(apiUrl('/api/practice/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targets: chunk.map(t => ({ front: t.front, back: t.back, lemma: t.lemma, pos: t.pos })),
        sourceLanguage: opts.sourceLanguage,
        targetLanguage: opts.targetLanguage,
        count: chunk.length,
        mode: 'target',
        narrative: opts.style === 'story',
      }),
    })
    const data = await res.json() as { ok?: boolean; exercises?: PracticeExercise[] }
    if (!data?.ok || !Array.isArray(data.exercises)) continue
    // Exactly one sentence per target: first per lemma wins, model order preserved.
    const seen = new Set<string>()
    for (const e of data.exercises) {
      if (seen.has(e.targetLemma)) continue
      seen.add(e.targetLemma)
      items.push(prepareExercise(e, chunk))
    }
  }
  return { items, missing: Math.max(0, opts.targets.length - items.length) }
}
