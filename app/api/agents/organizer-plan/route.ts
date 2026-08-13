/**
 * POST /api/agents/organizer-plan
 *
 * Writes a MIGRATION PLAN for the card organizer: given a hierarchical export of the selected scope,
 * the user's instruction, and the contents of any Word documents, returns an ordered list of moves
 * that ends with the library exactly as described.
 *
 * **Sonnet, not Haiku.** This reads a whole library export and plans globally over it; the per-batch
 * "where does this card go" call this replaced was a much smaller job. A weaker model here produces
 * plausible-looking plans that are wrong in the middle, which is the worst outcome for something the
 * user approves in one click.
 *
 * The model never audits: duplicates, missing words and out-of-scope cards are computed client-side
 * and handed in as facts. It never sees ids it may invent either — every id it returns is
 * re-validated against the client's own copy of the library before anything runs.
 *
 * Returns `{ ok: true, plan: { summary, steps } }`. Fails soft with `{ ok: false, error }`.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

// Planning over a full library export is a reasoning job — see the header note.
const MODEL = 'claude-sonnet-5'
const MAX_TOKENS = 16000

const SYSTEM = `You plan a reorganization of a language learner's flashcard library.

You are given:
1. INSTRUCTION — what the learner wants. This is the GROUND TRUTH and overrides everything else.
2. DOCUMENTS — optional Word-document contents. These are SUPPORTING EVIDENCE. The instruction tells
   you how to read them (follow them literally, use them only as a grouping hint, ignore parts, …).
   If the instruction and a document disagree, the instruction wins.
3. LIBRARY — a hierarchical export of the decks and folders in scope, with their cards.
4. NOTES — facts already computed for you: duplicated words, words the documents mention that aren't
   in scope, and cards that live outside the scope but could be pulled in. Treat these as true. Do
   not re-derive them and do not invent new ones.

Return ONLY JSON, no prose:
{"summary":"one paragraph describing the reorganization","steps":[ ... ]}

Each step is one of:
{"kind":"createFolder","path":["Food","Ingredients"],"reason":"..."}
{"kind":"moveFolder","folderId":"<id from LIBRARY>","folderName":"Verbs","toParent":["Grammar"],"reason":"..."}
{"kind":"moveDeck","deckId":"<id from LIBRARY>","deckName":"Fruit","toFolder":["Food"],"reason":"..."}
{"kind":"moveCard","cardId":"<id from LIBRARY>","front":"la mela","back":"apple","fromDeckId":"<id>","fromDeckName":"Misc","toDeck":["Food","Fruit"],"reason":"..."}

Rules:
- Use ONLY ids that appear in LIBRARY or in the pull-in list. Never invent an id. If you cannot find
  an id for something you want to move, leave it out and mention it in the summary.
- "path"/"toFolder"/"toParent" are folder names from the library root. "toDeck" is folders THEN the
  deck name as the last element.
- PREFER MOVING A WHOLE DECK OR FOLDER over moving its cards one by one. A single moveDeck is clearer
  to review and faster to run than fifty moveCard steps that add up to the same thing.
- Omit cards that are already where they belong. A plan of no steps is a valid answer.
- Only set "pullIn": true on a moveCard whose card came from the pull-in list.
- You may create folders and decks that don't exist yet; naming a new deck in "toDeck" creates it.
- You cannot rename or delete anything. Do not try.
- Give every step a short, specific "reason" — it is shown to the learner beside the step.`

interface Body {
  instruction: string
  documents:   { name: string; text: string }[]
  library:     string
  notes:       string
}

function extractJson(text: string): unknown {
  // The model is told to return bare JSON; a fenced block is the common deviation.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const raw = fenced ? fenced[1]! : text
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  let body: Body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }) }
  if (!body.instruction?.trim() && (body.documents ?? []).length === 0) {
    return NextResponse.json({ ok: false, error: 'Give an instruction or at least one document.' }, { status: 400 })
  }

  const docs = (body.documents ?? [])
    .map(d => `--- DOCUMENT: ${d.name} ---\n${d.text}`)
    .join('\n\n') || '(none)'

  const content = [
    `INSTRUCTION:\n${body.instruction?.trim() || '(none given — follow the documents as literally as you can)'}`,
    `DOCUMENTS:\n${docs}`,
    `LIBRARY (current state, in scope):\n${body.library}`,
    `NOTES:\n${body.notes || '(none)'}`,
  ].join('\n\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: 'user', content }] }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return NextResponse.json({ ok: false, error: `anthropic ${res.status}`, detail }, { status: 502 })
  }

  const data = await res.json()
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
  const parsed = extractJson(text) as { summary?: string; steps?: unknown[] } | null
  if (!parsed || !Array.isArray(parsed.steps)) {
    return NextResponse.json({ ok: false, error: 'The planner did not return a usable plan. Try rephrasing the instruction.' }, { status: 502 })
  }

  // Shape-check only — ids and destinations are re-validated on the client against the real library.
  const steps = parsed.steps.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
  return NextResponse.json({
    ok: true,
    plan: { summary: typeof parsed.summary === 'string' ? parsed.summary : '', steps },
    /** Surfaced so a truncated plan can be reported rather than silently applied in part. */
    stopReason: data.stop_reason ?? null,
  })
}
