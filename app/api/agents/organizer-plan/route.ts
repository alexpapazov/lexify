/**
 * POST /api/agents/organizer-plan
 *
 * The card organizer's model calls, in three modes:
 *   - `plan`      — the single-shot planner for scopes that fit one prompt: full library export in,
 *                   ordered step list out.
 *   - `structure` — stage one of the BIG-LOAD path: the library TREE (no card lines) + document
 *                   OUTLINES in; folder/deck steps, a section→destination routing, and a leftover
 *                   policy out. Card-level moves for routed sections are then computed on the
 *                   CLIENT, deterministically — a model assigning thousands of doc-listed cards one
 *                   by one is how the single call blew past every ceiling.
 *   - `assign`    — stage two, only when the structure stage says leftovers need judgment: one small
 *                   batch of unclaimed cards + a numbered destination menu in, index pairs out.
 *
 * **Sonnet, not Haiku.** Planning over a library export is a reasoning job; a weak plan approved in
 * one click is the worst failure mode.
 *
 * All ids in and out are the client's SHORT ids (`17`, `d3`, `f1`) — the client translates them back
 * and re-validates everything against its own copy of the library. The model never audits either:
 * duplicates/missing/out-of-scope are computed client-side and handed in as facts.
 *
 * The upstream call STREAMS and the function declares a long `maxDuration`: a non-streamed
 * long generation is exactly what produced the "Failed to fetch" connection drops on big loads.
 *
 * Returns `{ ok: true, ... }` per mode. Fails soft with `{ ok: false, error }`.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 300

// Planning over a full library export is a reasoning job — see the header note.
const MODEL = 'claude-sonnet-5'
// Per-mode output ceilings. `plan` is large (one step per moved card); the staged modes are small by
// design, which is what keeps each call comfortably inside every timeout.
const MAX_TOKENS = { plan: 32000, structure: 8000, assign: 8000 } as const

const SHARED_RULES = `
- Use ONLY ids that appear in the input ([f1] folders, [d2] decks, numeric card ids). Never invent an
  id. If you cannot find an id for something you want to move, leave it out and mention it in the summary.
- "path"/"toFolder"/"toParent" are folder names from the library root. "toDeck" is folders THEN the
  deck name as the last element.
- You may name folders and decks that don't exist yet; naming them creates them.
- You cannot rename or delete anything. Do not try.
- Return ONLY JSON, no prose.`

const SYSTEM_PLAN = `You plan a reorganization of a language learner's flashcard library.

You are given:
1. INSTRUCTION — what the learner wants. This is the GROUND TRUTH and overrides everything else.
2. DOCUMENTS — optional Word-document contents. These are SUPPORTING EVIDENCE. The instruction tells
   you how to read them (follow them literally, use them only as a grouping hint, ignore parts, …).
   If the instruction and a document disagree, the instruction wins.
3. LIBRARY — a hierarchical export of the decks and folders in scope. Folders are "Name/ [f1]",
   decks "Name [d2] (N cards)", cards "17: front = back".
4. NOTES — facts already computed for you: duplicated words, words the documents mention that aren't
   in scope, and cards that live outside the scope but could be pulled in. Treat these as true. Do
   not re-derive them and do not invent new ones.

Return: {"summary":"one paragraph","steps":[ ... ]}

Each step is one of:
{"kind":"createFolder","path":["Food","Ingredients"],"reason":"..."}
{"kind":"moveFolder","folderId":"f1","toParent":["Grammar"],"reason":"..."}
{"kind":"moveDeck","deckId":"d2","toFolder":["Food"],"reason":"..."}
{"kind":"moveCard","cardId":"17","toDeck":["Food","Fruit"],"reason":"..."}

Rules:
- PREFER MOVING A WHOLE DECK OR FOLDER over moving its cards one by one. A single moveDeck is clearer
  to review and faster to run than fifty moveCard steps that add up to the same thing.
- Omit cards that are already where they belong. A plan of no steps is a valid answer.
- Cards listed in NOTES as outside the scope may be moved only if NOTES says the learner allowed it.
- Give every step a short, specific "reason" — it is shown to the learner beside the step.
${SHARED_RULES}`

const SYSTEM_STRUCTURE = `You plan the STRUCTURE of a reorganization of a language learner's flashcard
library. The library is large, so you will NOT see individual cards — you decide the folder/deck
skeleton and where each document section's words should land; exact card moves are computed
mechanically from your routing afterwards.

You are given:
1. INSTRUCTION — the GROUND TRUTH. It says how literally to read the documents.
2. DOCUMENTS — an OUTLINE of each Word document: every section's path, its word count, and a few
   sample words.
3. LIBRARY — the folder/deck tree in scope (no cards). Folders are "Name/ [f1]", decks
   "Name [d2] (N cards)".
4. NOTES — precomputed facts. Treat as true.

Return:
{"summary":"one paragraph describing the reorganization",
 "steps":[ {"kind":"createFolder","path":[...],"reason":"..."} | {"kind":"moveFolder","folderId":"f1","toParent":[...],"reason":"..."} | {"kind":"moveDeck","deckId":"d2","toFolder":[...],"reason":"..."} ],
 "sectionRoutes":[{"section":"<the section path exactly as given>","toDeck":["Food","Fruit"]}],
 "leftovers":{"action":"leave"} | {"action":"route","toDeck":["Unsorted"]} | {"action":"judge"}}

Rules:
- EVERY document section must appear in sectionRoutes. Route it where the instruction says its words
  belong — often simply its own path.
- "leftovers" is what happens to scope cards NO document mentions: "leave" (don't touch them — the
  default when the instruction doesn't say), "route" (all to one deck), or "judge" (you will be shown
  them in small batches next and asked to place each one — only choose this when the instruction
  requires per-card judgment).
- steps may only be createFolder/moveFolder/moveDeck — card moves are derived from sectionRoutes.
${SHARED_RULES}`

const SYSTEM_ASSIGN = `You are sorting a language learner's flashcards into an already-decided set of
destination decks, one small batch at a time.

You are given:
1. INSTRUCTION — the learner's ground-truth description of how things should be organized.
2. DESTINATIONS — a numbered list of destination deck paths.
3. CARDS — numbered lines "id: front = back  (in: current deck)".

Return: {"moves":[{"id":0,"to":2}, ...]} — "id" is the card's number, "to" is the destination's
number. OMIT any card that should stay where it is; omitting is always safe. Return ONLY JSON.`

interface Body {
  mode?: 'plan' | 'structure' | 'assign'
  instruction: string
  documents?: { name: string; text: string }[]
  library?: string
  notes?: string
  /** assign mode */
  destinations?: string[]
  cards?: string
}

function extractJson(text: string): unknown {
  // The model is told to return bare JSON. The two deviations seen in practice: a ```json fence
  // (possibly unterminated when the output was cut), and a response truncated at max_tokens.
  const cleaned = text.replace(/```(?:json)?/g, '')
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  const raw = cleaned.slice(start, cleaned.lastIndexOf('}') + 1 || undefined)
  try { return JSON.parse(raw) } catch { /* fall through to the truncation salvage */ }

  // Truncated mid-plan: keep every COMPLETE item and drop the cut-off tail. The shapes here are
  // {"...": "...", "steps"/"moves": [ {...}, {...} — so a `}` closing back to depth 2 marks the end
  // of a whole item (they are the only objects at that depth).
  const body = cleaned.slice(start)
  let depth = 0, inStr = false, esc = false, lastItemEnd = -1
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') { depth--; if (ch === '}' && depth === 2) lastItemEnd = i }
  }
  if (lastItemEnd < 0) return null
  try { return JSON.parse(body.slice(0, lastItemEnd + 1) + ']}') } catch { return null }
}

/**
 * One streamed model call, accumulated server-side. Streaming is not cosmetic: a long non-streamed
 * generation holds a silent connection until something between here and the API gives up on it.
 */
async function callModel(apiKey: string, system: string, content: string, maxTokens: number):
  Promise<{ text: string; stopReason: string | null }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, system, stream: true,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`anthropic ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = '', text = '', stopReason: string | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        const ev = JSON.parse(payload) as { type?: string; delta?: { type?: string; text?: string; stop_reason?: string } }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text ?? ''
        if (ev.type === 'message_delta' && ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
      } catch { /* keep-alives and unknown events are fine to skip */ }
    }
  }
  return { text, stopReason }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  let body: Body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }) }
  const mode = body.mode ?? 'plan'

  try {
    if (mode === 'assign') {
      const destinations = (body.destinations ?? []).map((d, i) => `${i}: ${d}`).join('\n')
      if (!destinations || !body.cards) return NextResponse.json({ ok: false, error: 'assign needs destinations and cards' }, { status: 400 })
      const content = [
        `INSTRUCTION:\n${body.instruction?.trim() || '(none)'}`,
        `DESTINATIONS:\n${destinations}`,
        `CARDS:\n${body.cards}`,
      ].join('\n\n')
      const { text, stopReason } = await callModel(apiKey, SYSTEM_ASSIGN, content, MAX_TOKENS.assign)
      const parsed = extractJson(text) as { moves?: unknown[] } | null
      if (!parsed || !Array.isArray(parsed.moves)) {
        console.error('organizer-plan assign: unusable response', { stopReason, tail: text.slice(-300) })
        return NextResponse.json({ ok: false, error: 'The assignment batch did not return usable moves.' }, { status: 502 })
      }
      return NextResponse.json({ ok: true, moves: parsed.moves, stopReason })
    }

    if (!body.instruction?.trim() && (body.documents ?? []).length === 0) {
      return NextResponse.json({ ok: false, error: 'Give an instruction or at least one document.' }, { status: 400 })
    }
    const docs = (body.documents ?? [])
      .map(d => `--- DOCUMENT: ${d.name} ---\n${d.text}`)
      .join('\n\n') || '(none)'
    const content = [
      `INSTRUCTION:\n${body.instruction?.trim() || '(none given — follow the documents as literally as you can)'}`,
      `DOCUMENTS:\n${docs}`,
      `LIBRARY (current state, in scope):\n${body.library ?? ''}`,
      `NOTES:\n${body.notes || '(none)'}`,
    ].join('\n\n')

    const system = mode === 'structure' ? SYSTEM_STRUCTURE : SYSTEM_PLAN
    const { text, stopReason } = await callModel(apiKey, system, content, MAX_TOKENS[mode])
    const parsed = extractJson(text) as {
      summary?: string; steps?: unknown[]
      sectionRoutes?: unknown[]; leftovers?: { action?: string; toDeck?: unknown[] }
    } | null
    if (!parsed || !Array.isArray(parsed.steps)) {
      // Keep the model's raw output in the server log — "not usable" is undiagnosable without it.
      console.error('organizer-plan: unusable response', { mode, stopReason, head: text.slice(0, 400), tail: text.slice(-400) })
      const error = stopReason === 'max_tokens'
        ? 'The plan was too large to finish. Narrow the scope (fewer decks) or split the reorganization into smaller instructions.'
        : 'The planner did not return a usable plan. Try rephrasing the instruction.'
      return NextResponse.json({ ok: false, error }, { status: 502 })
    }

    // Shape-check only — ids and destinations are re-validated on the client against the real library.
    const steps = parsed.steps.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    return NextResponse.json({
      ok: true,
      plan: { summary: typeof parsed.summary === 'string' ? parsed.summary : '', steps },
      sectionRoutes: Array.isArray(parsed.sectionRoutes) ? parsed.sectionRoutes : [],
      leftovers: parsed.leftovers && typeof parsed.leftovers === 'object' ? parsed.leftovers : { action: 'leave' },
      /** Surfaced so a truncated plan can be reported rather than silently applied in part. */
      stopReason,
    })
  } catch (e) {
    console.error('organizer-plan: request failed', { mode, error: e instanceof Error ? e.message : String(e) })
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'planner request failed' }, { status: 502 })
  }
}
