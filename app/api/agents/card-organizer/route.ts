/**
 * POST /api/agents/card-organizer
 *
 * Given a batch of cards, the folders/decks that already exist, and a free-form INSTRUCTION, asks
 * Claude WHERE each card belongs. One structured JSON answer — no tool-use loop, so it's
 * deterministic and cheap.
 *
 * The model only ever returns a DESTINATION PATH per card. It cannot edit, split or delete anything,
 * and the client validates every `cardId` against its own copy of the batch, so an invented id or an
 * out-of-scope card is dropped rather than trusted.
 *
 * Returns `{ ok: true, assignments: [{cardId, path, reason}] }`. Fails soft with `{ ok: false, error }`.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

interface InCard { cardId: string; front: string; back: string; currentPath?: string }
interface Assignment { cardId: string; path: string[]; reason?: string }

const SYSTEM = `You organize a language learner's flashcards into folders and decks.

Each card has a "front" (the word in the language being learned) and a "back" (its gloss in the
learner's native language). You are given the cards, the folder/deck paths that already exist, and an
INSTRUCTION describing how the learner wants them organized.

Return ONLY JSON, no prose:
{"assignments":[{"cardId":"...","path":["Folder","Subfolder","Deck name"],"reason":"..."}]}

"path" is the destination read from the library root down: every element except the last is a folder,
and the LAST element is the deck the card goes in. A single-element path means a deck at the library
root.

Rules:
- Include ONLY cards that should MOVE. Leave a card out entirely if it is already in the right place
  or the instruction doesn't cover it. Never emit an empty path.
- PREFER PATHS THAT ALREADY EXIST. Reuse an existing folder or deck name exactly as written rather
  than inventing a near-duplicate ("Food" vs "Foods"). Only invent a new path when the instruction
  clearly calls for a grouping that doesn't exist yet.
- Keep the tree shallow and the names short — a learner has to navigate this.
- Put every card that belongs to one grouping in the SAME deck; don't scatter near-identical cards
  across singular/plural variants of a name.
- You may NOT change any card's text. You only choose where it lives.
- Give a short "reason" for each assignment.`

function extractJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  let body: { cards: InCard[]; task: string; existingPaths?: string[]; leftovers?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }) }
  const { cards, task } = body
  if (!Array.isArray(cards) || cards.length === 0) return NextResponse.json({ ok: true, assignments: [] })
  if (!task?.trim()) return NextResponse.json({ ok: false, error: 'no instruction given' }, { status: 400 })

  const list = cards.map(c =>
    `- cardId=${c.cardId} | front="${c.front}" | back="${c.back}"${c.currentPath ? ` | currently in: ${c.currentPath}` : ''}`
  ).join('\n')
  const existing = (body.existingPaths ?? []).slice(0, 200)
  const existingBlock = existing.length > 0
    ? `\n\nFolders and decks that already exist (reuse these names exactly where they fit):\n${existing.map(p => `- ${p}`).join('\n')}`
    : ''
  // When documents were also given, these cards are the ones the documents did NOT list. Saying so
  // matters: without it the model assumes it is organizing the whole library and proposes a tree
  // that competes with the structure the document just established.
  const leftoverBlock = body.leftovers
    ? `\n\nThese are the cards a Word document did NOT place. The document's structure is listed above and is already decided — fit these cards into it where the instruction calls for it, rather than inventing a parallel structure.`
    : ''

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4096, system: SYSTEM,
      messages: [{ role: 'user', content: `INSTRUCTION: ${task.trim()}${existingBlock}${leftoverBlock}\n\nCards:\n${list}` }],
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return NextResponse.json({ ok: false, error: `anthropic ${res.status}`, detail }, { status: 502 })
  }

  const data = await res.json()
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
  const parsed = extractJson(text) as { assignments?: Assignment[] } | null
  const known = new Set(cards.map(c => c.cardId))

  const assignments = (parsed?.assignments ?? []).flatMap(a => {
    if (!a || !known.has(a.cardId) || !Array.isArray(a.path)) return []
    // Trim and drop blanks: a path of empty strings would create folders named "" .
    const path = a.path.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).slice(0, 6)
    if (path.length === 0) return []
    return [{ cardId: a.cardId, path, reason: typeof a.reason === 'string' ? a.reason : '' }]
  })

  return NextResponse.json({ ok: true, assignments })
}
