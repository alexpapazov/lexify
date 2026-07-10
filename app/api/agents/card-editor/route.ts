/**
 * POST /api/agents/card-editor
 *
 * Structured, batched analyzer for the card-editor. Given up to ~20 cards, asks
 * Claude which ones have a back (gloss) holding TWO OR MORE DISTINCT MEANINGS
 * that should become separate cards, and returns them as JSON — no tool-use loop,
 * so it's deterministic and can't "narrate instead of acting".
 *
 * Returns `{ ok: true, splits: [{ cardId, primaryBack, extraBacks[], reason }] }`.
 * Fails soft with `{ ok: false, error }`.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

interface InCard { cardId: string; front: string; back: string }
interface Split { cardId: string; primaryBack: string; extraBacks: string[]; reason: string }

const SYSTEM = `You clean up language flashcards. Each card has a "front" (the word in the
language being learned) and a "back" (its English gloss). Some backs cram TWO OR MORE
DISTINCT MEANINGS into one card; those should be split into separate cards.

SPLIT a card only when the back lists genuinely DIFFERENT meanings of the word — e.g.
"camel / drug dealer", "nerve / cheek / snout", "to charge; to earn", "closet vs. cupboard vs. wardrobe" only if truly distinct senses.

DO NOT split when the parts are just SYNONYMS or near-synonyms of ONE meaning — e.g.
"cloak, cape", "closet / wardrobe", "horrible, awful", "hallway, corridor",
"dove / pigeon", "turtle / tortoise". Leave those alone.

For each card that should be split: pick the single best gloss as "primaryBack",
put each OTHER distinct meaning in "extraBacks", and give a one-line "reason".
Return ONLY JSON, no prose: {"splits":[{"cardId":"...","primaryBack":"...","extraBacks":["..."],"reason":"..."}]}.
Include ONLY cards that need splitting. If none do, return {"splits":[]}.`

function extractJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  let cards: InCard[]
  try { cards = (await req.json()).cards } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }) }
  if (!Array.isArray(cards) || cards.length === 0) return NextResponse.json({ ok: true, splits: [] })

  const list = cards.map(c => `- cardId=${c.cardId} | front="${c.front}" | back="${c.back}"`).join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2048, system: SYSTEM,
      messages: [{ role: 'user', content: `Cards:\n${list}` }],
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return NextResponse.json({ ok: false, error: `anthropic ${res.status}`, detail }, { status: 502 })
  }

  const data = await res.json()
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
  const parsed = extractJson(text) as { splits?: Split[] } | null
  const valid = new Set(cards.map(c => c.cardId))
  const splits = (parsed?.splits ?? []).filter(s =>
    s && valid.has(s.cardId) && typeof s.primaryBack === 'string' && Array.isArray(s.extraBacks) && s.extraBacks.length > 0,
  )
  return NextResponse.json({ ok: true, splits })
}
