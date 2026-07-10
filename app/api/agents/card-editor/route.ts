/**
 * POST /api/agents/card-editor
 *
 * Structured, batched editor. Given up to ~20 cards plus a free-form INSTRUCTION,
 * asks Claude which cards to change and how, and returns the edits as JSON — no
 * tool-use loop, so it's deterministic. Supports rewriting text, splitting a
 * multi-meaning card into siblings, and deleting.
 *
 * Returns `{ ok: true, edits: [...] }`. Fails soft with `{ ok: false, error }`.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

interface InCard { cardId: string; front: string; back: string }
interface Edit { cardId: string; action: 'edit' | 'split' | 'delete'; front?: string; back?: string; primaryBack?: string; extraBacks?: string[]; reason: string }

const SYSTEM = `You edit language flashcards. Each card has a "front" (the word in the language
being learned) and a "back" (its gloss in the learner's native language). You are given a
batch of cards and an INSTRUCTION from the user. Apply the instruction to the cards and
return the specific changes.

Return ONLY JSON, no prose: {"edits":[ ... ]}. Each edit is exactly one of:
- Rewrite: {"cardId":"...","action":"edit","front":"<new front, omit if unchanged>","back":"<new back, omit if unchanged>","reason":"..."}
- Split into siblings: {"cardId":"...","action":"split","primaryBack":"<gloss the original keeps>","extraBacks":["<one new sibling per extra distinct meaning>"],"reason":"..."}
- Delete: {"cardId":"...","action":"delete","reason":"..."}

Rules:
- Include ONLY cards you actually change. If none apply, return {"edits":[]}.
- Follow the instruction precisely and conservatively; don't invent changes it didn't ask for.
- Keep the language correct for each side (front = learned language, back = native gloss).
- Give a short "reason" for each edit.`

function extractJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  let body: { cards: InCard[]; task: string }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }) }
  const { cards, task } = body
  if (!Array.isArray(cards) || cards.length === 0) return NextResponse.json({ ok: true, edits: [] })
  if (!task?.trim()) return NextResponse.json({ ok: false, error: 'no instruction given' }, { status: 400 })

  const list = cards.map(c => `- cardId=${c.cardId} | front="${c.front}" | back="${c.back}"`).join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4096, system: SYSTEM,
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
  const valid = new Set(cards.map(c => c.cardId))
  const edits = (parsed?.edits ?? []).filter(e => {
    if (!e || !valid.has(e.cardId)) return false
    if (e.action === 'split') return typeof e.primaryBack === 'string' && Array.isArray(e.extraBacks) && e.extraBacks.length > 0
    if (e.action === 'edit')   return typeof e.front === 'string' || typeof e.back === 'string'
    if (e.action === 'delete') return true
    return false
  })
  return NextResponse.json({ ok: true, edits })
}
