/**
 * lib/syncProcessor.ts
 *
 * Server-side language sync processor.
 * Called from app/api/sync/route.ts — NOT from client components.
 *
 * Processes one "hop" of the sync chain (e.g. Spanish→Korean).
 * Returns NextHop descriptors for every cascade language that should follow.
 * The API route triggers those hops as independent server invocations,
 * so the chain survives browser-tab switching, sleeping devices, etc.
 *
 * Rate-limit safety: cards are translated BATCH_SIZE at a time with a pause
 * between batches. Failed cards are retried up to MAX_RETRIES times using
 * exponential back-off, capped at RETRY_CAP_MS.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { langName }          from '@/lib/languages'

// ── Tuning constants ──────────────────────────────────────────────────────────

const BATCH_SIZE     = 5
const BATCH_DELAY_MS = 1200
const RETRY_BASE_MS  = 10_000
const RETRY_CAP_MS   = 300_000  // 5-minute cap per retry sleep
const MAX_RETRIES    = 25

const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'
const ANTHROPIC_MODEL     = 'claude-haiku-4-5-20251001'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SimpleCard {
  id:    string
  front: string
  back:  string
}

export interface NextHop {
  userId:         string
  sourceLanguage: string
  targetLanguage: string
  cards:          SimpleCard[]
  visited:        string[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normFront(s: string): string { return s.trim().toLowerCase() }

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function buildPrompt(
  sourceFront: string, sourceBack: string,
  fromLang: string,
  toLearnedLang: string, toBasisLang: string,
): string {
  const from      = langName(fromLang)
  const toLearned = langName(toLearnedLang)
  const toBasis   = langName(toBasisLang)
  return `You are a translation assistant for a language learning app.

A flashcard in ${from} reads:
  Front (word being learned): "${sourceFront}"
  Back (basis-language gloss): "${sourceBack}"

Translate this into a new language pair:
  New front: the equivalent word/phrase in ${toLearned} (the language being learned)
  New back:  the equivalent word/phrase in ${toBasis}  (the basis/native language)

IMPORTANT: derive the translation from the SOURCE FRONT ("${sourceFront}"), not the back gloss.

Return ONLY a JSON object, no other text:
{
  "front": "translated word/phrase in ${toLearned}",
  "back": "translated word/phrase in ${toBasis}",
  "confidence": 0.0-1.0,
  "warning": "optional note if uncertain, or null"
}`
}

async function runInBatchesWithRetry(
  cards: SimpleCard[],
  processOne: (card: SimpleCard) => Promise<SimpleCard | null>,
): Promise<SimpleCard[]> {
  const results: SimpleCard[] = []
  let pending = [...cards]

  for (let attempt = 0; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_CAP_MS))
    }
    const failed: SimpleCard[] = []

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(batch.map(processOne))
      for (let j = 0; j < batch.length; j++) {
        const r = batchResults[j] ?? null
        if (r !== null) results.push(r)
        else failed.push(batch[j]!)
      }
      if (i + BATCH_SIZE < pending.length) await sleep(BATCH_DELAY_MS)
    }

    pending = failed
  }

  if (pending.length > 0) {
    console.warn(`syncProcessor: ${pending.length} card(s) permanently failed after ${MAX_RETRIES} retries`)
  }
  return results
}

// ── Infra (folder + deck) ─────────────────────────────────────────────────────

interface PairRow {
  id:              string
  source_language: string
  target_language: string
}

async function ensureInfra(
  db:       ReturnType<typeof createAdminClient>,
  userId:   string,
  srcPair:  PairRow,
  destPair: PairRow,
): Promise<{ deckId: string }> {
  const { data: existing } = await db
    .from('language_sync_state')
    .select('deck_id')
    .eq('user_id', userId)
    .eq('source_pair_id', srcPair.id)
    .eq('destination_pair_id', destPair.id)
    .maybeSingle()
  if (existing) return { deckId: existing.deck_id as string }

  // Reuse "Synced" root folder if another direction already created it for this dest pair
  const { data: sibling } = await db
    .from('language_sync_state')
    .select('root_folder_id')
    .eq('user_id', userId)
    .eq('destination_pair_id', destPair.id)
    .limit(1)
    .maybeSingle()

  let rootFolderId: string
  if (sibling) {
    rootFolderId = sibling.root_folder_id as string
  } else {
    const { data: folder, error: folderErr } = await db
      .from('folders')
      .insert({ owner_id: userId, name: 'Synced', parent_id: null })
      .select()
      .single()
    if (folderErr) throw new Error(folderErr.message)
    rootFolderId = folder.id as string
  }

  const { data: deck, error: deckErr } = await db
    .from('decks')
    .insert({
      owner_id:        userId,
      name:            langName(srcPair.source_language),
      source_language: destPair.source_language,
      target_language: destPair.target_language,
      pipeline_id:     DEFAULT_PIPELINE_ID,
    })
    .select()
    .single()
  if (deckErr) throw new Error(deckErr.message)

  await db.from('decks').update({ folder_id: rootFolderId }).eq('id', deck.id)

  await db.from('language_sync_state').upsert({
    user_id:             userId,
    source_pair_id:      srcPair.id,
    destination_pair_id: destPair.id,
    root_folder_id:      rootFolderId,
    sub_folder_id:       rootFolderId,
    deck_id:             deck.id,
  }, { onConflict: 'user_id,source_pair_id,destination_pair_id' })

  return { deckId: deck.id as string }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function processSyncHop(
  userId:         string,
  sourceLanguage: string,
  targetLanguage: string,
  cards:          SimpleCard[],
  visited:        string[],
): Promise<{ nextHops: NextHop[] }> {
  if (cards.length === 0) return { nextHops: [] }

  const pairKey    = `${sourceLanguage}:${targetLanguage}`
  const visitedSet = new Set(visited)
  if (visitedSet.has(pairKey)) return { nextHops: [] }
  visitedSet.add(pairKey)

  const db     = createAdminClient()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('syncProcessor: ANTHROPIC_API_KEY not set')
    return { nextHops: [] }
  }

  // Load pairs + rules
  const { data: pairsData } = await db
    .from('language_pairs')
    .select('id, source_language, target_language')
    .eq('owner_id', userId)

  const pairs = (pairsData ?? []) as PairRow[]
  const src   = pairs.find(p => p.source_language === sourceLanguage && p.target_language === targetLanguage)
  if (!src) return { nextHops: [] }

  const { data: rulesData } = await db
    .from('language_sync_rules')
    .select('id, destination_pair_id, mode, enabled')
    .eq('user_id', userId)
    .eq('source_pair_id', src.id)
    .eq('enabled', true)

  const rules = (rulesData ?? []) as Array<{ id: string; destination_pair_id: string; mode: string; enabled: boolean }>
  if (rules.length === 0) return { nextHops: [] }

  const nextHops: NextHop[] = []

  for (const rule of rules) {
    const dest = pairs.find(p => p.id === rule.destination_pair_id)
    if (!dest) continue

    const destKey = `${dest.source_language}:${dest.target_language}`
    if (visitedSet.has(destKey)) continue

    const infra = await ensureInfra(db, userId, src, dest)

    // Load all dest cards for dedup
    const { data: existingData } = await db
      .from('cards')
      .select('id, front, back')
      .eq('owner_id', userId)
      .eq('source_language', dest.source_language)
      .eq('target_language', dest.target_language)
      .is('deleted_at', null)

    const destCards = (existingData ?? []) as SimpleCard[]
    const destFronts = new Set(destCards.map(c => normFront(c.front)))
    let nextPosition = destCards.length

    // Capture loop variables for closure
    const capturedSrc  = src
    const capturedDest = dest
    const capturedRule = rule
    const capturedInfra = infra

    async function processOneCard(card: SimpleCard): Promise<SimpleCard | null> {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method:  'POST',
          headers: {
            'content-type':    'application/json',
            'x-api-key':       apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      ANTHROPIC_MODEL,
            max_tokens: 300,
            messages:   [{
              role:    'user',
              content: buildPrompt(
                card.front, card.back,
                capturedSrc.source_language,
                capturedDest.source_language,
                capturedDest.target_language,
              ),
            }],
          }),
        })

        if (!res.ok) return null

        const data  = await res.json()
        const text: string = data?.content?.[0]?.text ?? ''
        const match = /\{[\s\S]*\}/.exec(text)
        if (!match) return null

        let parsed: Record<string, unknown>
        try { parsed = JSON.parse(match[0]) } catch { return null }

        if (typeof parsed.front !== 'string' || typeof parsed.back !== 'string') return null

        const generatedFront = (parsed.front as string).trim()
        const generatedBack  = (parsed.back  as string).trim()
        const confidence     = typeof parsed.confidence === 'number' ? parsed.confidence : null
        const warning        = typeof parsed.warning === 'string' && parsed.warning ? parsed.warning : null

        let syncedCardId: string | null = null
        let resultCard:   SimpleCard | null = null

        if (capturedRule.mode === 'auto') {
          const nf        = normFront(generatedFront)
          const duplicate = destCards.find(c => normFront(c.front) === nf)

          if (duplicate) {
            syncedCardId = duplicate.id
            resultCard   = duplicate
            await db.from('deck_cards').upsert(
              { deck_id: capturedInfra.deckId, card_id: duplicate.id, position: nextPosition++ },
              { onConflict: 'deck_id,card_id', ignoreDuplicates: true },
            )
          } else if (!destFronts.has(nf)) {
            destFronts.add(nf)
            const pos = nextPosition++
            const { data: created, error: createErr } = await db
              .from('cards')
              .insert({
                owner_id:        userId,
                source_language: capturedDest.source_language,
                target_language: capturedDest.target_language,
                front:           generatedFront,
                back:            generatedBack,
                hints:           [],
                position:        pos,
              })
              .select('id, front, back')
              .single()

            if (!createErr && created) {
              syncedCardId = created.id as string
              resultCard   = { id: created.id as string, front: generatedFront, back: generatedBack }
              destCards.push(resultCard)
              await db.from('deck_cards').upsert(
                { deck_id: capturedInfra.deckId, card_id: created.id, position: pos },
                { onConflict: 'deck_id,card_id', ignoreDuplicates: true },
              )
            }
          }
        }

        await db.from('synced_card_links').upsert({
          user_id:              userId,
          source_card_id:       card.id,
          synced_card_id:       syncedCardId,
          source_pair_id:       capturedSrc.id,
          destination_pair_id:  capturedRule.destination_pair_id,
          sync_rule_id:         capturedRule.id,
          source_front_at_sync: card.front,
          source_back_at_sync:  card.back,
          generated_front:      generatedFront,
          generated_back:       generatedBack,
          confidence,
          warning,
          status: capturedRule.mode === 'auto' ? 'active' : 'pending',
        }, { onConflict: 'source_card_id,destination_pair_id' })

        return resultCard
      } catch (err) {
        console.error('syncProcessor: failed for card', card.front, err)
        return null
      }
    }

    const created = await runInBatchesWithRetry(cards, processOneCard)

    if (capturedRule.mode === 'auto' && created.length > 0) {
      nextHops.push({
        userId,
        sourceLanguage: capturedDest.source_language,
        targetLanguage: capturedDest.target_language,
        cards:   created,
        visited: [...visitedSet],
      })
    }
  }

  return { nextHops }
}
