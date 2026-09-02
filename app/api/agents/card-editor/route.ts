/**
 * POST /api/agents/card-editor
 *
 * Structured, batched editor. Given up to ~20 cards plus a free-form INSTRUCTION,
 * asks Claude which cards to change and how, and returns the edits as JSON — no
 * tool-use loop, so it's deterministic. Supports rewriting text, splitting a
 * multi-meaning card into siblings, and deleting.
 *
 * **Sides.** The caller chooses which side of each card the model may SEE (`sides`). Hiding a side
 * keeps the model from being distracted by it — "find cards with the same front" shouldn't be swayed
 * by the gloss. A hidden side is omitted from the payload entirely, and the model is then forbidden
 * from editing it: it cannot know the current text, so any value it produced would be invented.
 * The REVIEW UI still shows the user the whole card — it reads the local copy, not this response.
 *
 * Returns `{ ok: true, edits: [...] }`. Fails soft with `{ ok: false, error }`.
 */

import { NextRequest, NextResponse } from 'next/server'
import type { AgentSides } from '@/lib/agents/cardEditor'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

/** Which side(s) of a card the model is shown — and, consequently, allowed to change. */

/** A hidden side arrives `undefined`; never assume both are present. */
interface InCard { cardId: string; front?: string; back?: string }
interface Edit { cardId: string; action: 'edit' | 'split' | 'delete'; front?: string; back?: string; primaryBack?: string; extraBacks?: string[]; reason: string }

function toSides(v: unknown): AgentSides {
  return v === 'front' || v === 'back' ? v : 'both'
}

/**
 * The system prompt, built for the visible sides. `split` is defined purely in terms of backs
 * (primaryBack / extraBacks), so it is only offered when backs are visible.
 */
function systemPrompt(sides: AgentSides): string {
  const seesFront = sides !== 'back'
  const seesBack  = sides !== 'front'

  const whatYouSee = sides === 'both'
    ? `Each card has a "front" (the word in the language being learned) and a "back" (its gloss in the learner's native language).`
    : seesFront
      ? `Each card shows ONLY its "front" — the word in the language being learned. The gloss is deliberately hidden from you; do not guess at it, reason about it, or refer to it.`
      : `Each card shows ONLY its "back" — the gloss in the learner's native language. The word being learned is deliberately hidden from you; do not guess at it, reason about it, or refer to it.`

  const rewrite = sides === 'both'
    ? `- Rewrite: {"cardId":"...","action":"edit","front":"<new front, omit if unchanged>","back":"<new back, omit if unchanged>","reason":"..."}`
    : seesFront
      ? `- Rewrite: {"cardId":"...","action":"edit","front":"<new front>","reason":"..."}   ← you may ONLY change "front"`
      : `- Rewrite: {"cardId":"...","action":"edit","back":"<new back>","reason":"..."}   ← you may ONLY change "back"`

  const split = seesBack
    ? `\n- Split into siblings: {"cardId":"...","action":"split","primaryBack":"<gloss the original keeps>","extraBacks":["<one new sibling per extra distinct meaning>"],"reason":"..."}`
    : ''

  const sideRule = sides === 'both'
    ? `- Keep the language correct for each side (front = learned language, back = native gloss).`
    : seesFront
      ? `- NEVER emit a "back" field. You cannot see the gloss, so any value you wrote would be invented.`
      : `- NEVER emit a "front" field. You cannot see the word, so any value you wrote would be invented.`

  return `You edit language flashcards. ${whatYouSee} You are given a
batch of cards and an INSTRUCTION from the user. Apply the instruction to the cards and
return the specific changes.

Return ONLY JSON, no prose: {"edits":[ ... ]}. Each edit is exactly one of:
${rewrite}${split}
- Delete: {"cardId":"...","action":"delete","reason":"..."}

Rules:
- Include ONLY cards you actually change. If none apply, return {"edits":[]}.
- Follow the instruction precisely and conservatively; don't invent changes it didn't ask for.
${sideRule}
- Give a short "reason" for each edit.`
}

function extractJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  let body: { cards: InCard[]; task: string; sides?: AgentSides }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }) }
  const { cards, task } = body
  const sides = toSides(body.sides)
  if (!Array.isArray(cards) || cards.length === 0) return NextResponse.json({ ok: true, edits: [] })
  if (!task?.trim()) return NextResponse.json({ ok: false, error: 'no instruction given' }, { status: 400 })

  // Only serialize the sides that are actually present — interpolating a missing one would put the
  // literal string "undefined" in front of the model.
  const list = cards.map(c => {
    const parts = [`cardId=${c.cardId}`]
    if (typeof c.front === 'string') parts.push(`front="${c.front}"`)
    if (typeof c.back  === 'string') parts.push(`back="${c.back}"`)
    return `- ${parts.join(' | ')}`
  }).join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4096, system: systemPrompt(sides),
      messages: [{ role: 'user', content: `INSTRUCTION: ${task.trim()}\n\nCards:\n${list}` }],
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return NextResponse.json({ ok: false, error: `anthropic ${res.status}`, detail }, { status: 502 })
  }

  const data = await res.json()
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
  const parsed = extractJson(text) as { edits?: Edit[] } | null
  const byId = new Map(cards.map(c => [c.cardId, c]))
  const edits = (parsed?.edits ?? []).filter(e => {
    const src = byId.get(e?.cardId)
    if (!e || !src) return false
    // A split rewrites backs, so it needs them visible.
    if (e.action === 'split') return sides !== 'front'
      && typeof e.primaryBack === 'string' && Array.isArray(e.extraBacks) && e.extraBacks.length > 0
    if (e.action === 'delete') return true
    if (e.action === 'edit') {
      // Drop no-ops AND anything touching a hidden side. `src.front`/`src.back` may be undefined, so
      // the comparison must be guarded — an unguarded .trim() here threw inside .filter() and
      // surfaced as an unhandled 500.
      const frontChg = sides !== 'back'  && typeof e.front === 'string' && typeof src.front === 'string' && e.front.trim() !== src.front.trim()
      const backChg  = sides !== 'front' && typeof e.back  === 'string' && typeof src.back  === 'string' && e.back.trim()  !== src.back.trim()
      return frontChg || backChg
    }
    return false
  }).map(e => {
    // Belt and braces: strip any hidden-side value the model emitted anyway, so it can never reach
    // the gateway as a real edit.
    if (e.action !== 'edit') return e
    if (sides === 'front') return { ...e, back: undefined }
    if (sides === 'back')  return { ...e, front: undefined }
    return e
  })
  return NextResponse.json({ ok: true, edits })
}
