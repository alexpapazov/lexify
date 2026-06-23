/**
 * lib/syncProcessor.ts
 *
 * Server-side language sync — single-batch processor.
 * Processes exactly one batch of cards (BATCH_SIZE) per call.
 * Retries and continuation are handled by the API route, which re-invokes
 * itself with the remaining cards. This keeps each invocation under the
 * Vercel Hobby 10-second function limit.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { langName }          from '@/lib/languages'

export const BATCH_SIZE = 5
export const SYNC_FOLDER_NAME = 'SYNCED VOCABULARY'

const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'
const ANTHROPIC_MODEL     = 'claude-haiku-4-5-20251001'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SimpleCard {
  id:    string
  front: string
  back:  string
}

export interface SyncPayload {
  userId:         string
  sourceLanguage: string
  targetLanguage: string
  cards:          SimpleCard[]            // remaining cards (first BATCH_SIZE are processed)
  visited:        string[]
  failCounts?:    Record<string, number>  // cardId → cumulative failure count
  isChainHop?:    boolean                 // true = cascade to a new language (triggers delay)
}

export interface NextHop extends SyncPayload {
  isChainHop: true
}

export interface BatchResult {
  successCards: SimpleCard[]
  failedCards:  SimpleCard[]
  nextHops:     NextHop[]    // cascade destinations with this batch's successCards
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normFront(s: string): string { return s.trim().toLowerCase() }

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

// ── Infra (folder + deck) ─────────────────────────────────────────────────────

interface PairRow { id: string; source_language: string; target_language: string }

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

  // Find the single shared "SYNCED VOCABULARY" folder, or create it
  const { data: existingFolder } = await db
    .from('folders')
    .select('id')
    .eq('owner_id', userId)
    .eq('name', SYNC_FOLDER_NAME)
    .is('deleted_at', null)
    .maybeSingle()

  let rootFolderId: string
  if (existingFolder) {
    rootFolderId = existingFolder.id as string
  } else {
    const { data: folder, error: folderErr } = await db
      .from('folders')
      .insert({ owner_id: userId, name: SYNC_FOLDER_NAME, parent_id: null })
      .select().single()
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
    .select().single()
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

/**
 * Process a single batch of cards (payload.cards.slice(0, BATCH_SIZE)).
 * Does NOT loop or retry internally — the API route handles that.
 */
export async function processSyncBatch(payload: SyncPayload): Promise<BatchResult> {
  const { userId, sourceLanguage, targetLanguage, visited } = payload
  const batch = payload.cards.slice(0, BATCH_SIZE)

  if (batch.length === 0) return { successCards: [], failedCards: [], nextHops: [] }

  const pairKey    = `${sourceLanguage}:${targetLanguage}`
  const visitedSet = new Set(visited)
  if (visitedSet.has(pairKey)) return { successCards: [], failedCards: [], nextHops: [] }
  visitedSet.add(pairKey)

  const db     = createAdminClient()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('syncProcessor: ANTHROPIC_API_KEY not set')
    return { successCards: [], failedCards: batch, nextHops: [] }
  }

  const { data: pairsData } = await db
    .from('language_pairs')
    .select('id, source_language, target_language')
    .eq('owner_id', userId)

  const pairs = (pairsData ?? []) as PairRow[]
  const src   = pairs.find(p => p.source_language === sourceLanguage && p.target_language === targetLanguage)
  if (!src) return { successCards: [], failedCards: batch, nextHops: [] }

  const { data: rulesData } = await db
    .from('language_sync_rules')
    .select('id, destination_pair_id, mode, enabled')
    .eq('user_id', userId)
    .eq('source_pair_id', src.id)
    .eq('enabled', true)

  const rules = (rulesData ?? []) as Array<{ id: string; destination_pair_id: string; mode: string }>
  if (rules.length === 0) return { successCards: [], failedCards: [], nextHops: [] }

  // We collect per-rule success cards for cascade — use first rule's result as the
  // primary success list (cards successfully translated into at least one dest lang).
  const allSuccessIds = new Set<string>()
  const failedCards:   SimpleCard[] = []
  const nextHops:      NextHop[]    = []

  for (const rule of rules) {
    const dest = pairs.find(p => p.id === rule.destination_pair_id)
    if (!dest) continue

    const destKey = `${dest.source_language}:${dest.target_language}`
    if (visitedSet.has(destKey)) continue

    const capturedSrc  = src
    const capturedDest = dest
    const capturedRule = rule

    const infra = await ensureInfra(db, userId, capturedSrc, capturedDest)

    const { data: existingData } = await db
      .from('cards')
      .select('id, front, back')
      .eq('owner_id', userId)
      .eq('source_language', capturedDest.source_language)
      .eq('target_language', capturedDest.target_language)
      .is('deleted_at', null)

    const destCards  = (existingData ?? []) as SimpleCard[]
    const destFronts = new Set(destCards.map(c => normFront(c.front)))
    let   nextPos    = destCards.length

    const ruleSuccessCards: SimpleCard[] = []
    const ruleFailed:       SimpleCard[] = []

    const batchResults = await Promise.all(batch.map(async (card): Promise<SimpleCard | null> => {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method:  'POST',
          headers: {
            'content-type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      ANTHROPIC_MODEL,
            max_tokens: 300,
            messages:   [{ role: 'user', content: buildPrompt(
              card.front, card.back,
              capturedSrc.source_language,
              capturedDest.source_language,
              capturedDest.target_language,
            )}],
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
        const warning        = typeof parsed.warning    === 'string' && parsed.warning ? parsed.warning : null

        let syncedCardId: string | null = null
        let resultCard:   SimpleCard | null = null

        if (capturedRule.mode === 'auto') {
          const nf        = normFront(generatedFront)
          const duplicate = destCards.find(c => normFront(c.front) === nf)

          if (duplicate) {
            syncedCardId = duplicate.id
            resultCard   = duplicate
            await db.from('deck_cards').upsert(
              { deck_id: infra.deckId, card_id: duplicate.id, position: nextPos++ },
              { onConflict: 'deck_id,card_id', ignoreDuplicates: true },
            )
          } else if (!destFronts.has(nf)) {
            destFronts.add(nf)
            const pos = nextPos++
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
              .select('id, front, back').single()
            if (!createErr && created) {
              syncedCardId = created.id as string
              resultCard   = { id: created.id as string, front: generatedFront, back: generatedBack }
              destCards.push(resultCard)
              await db.from('deck_cards').upsert(
                { deck_id: infra.deckId, card_id: created.id, position: pos },
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
    }))

    for (let i = 0; i < batch.length; i++) {
      const r = batchResults[i] ?? null
      if (r !== null) {
        ruleSuccessCards.push(batch[i]!)
        allSuccessIds.add(batch[i]!.id)
      } else {
        ruleFailed.push(batch[i]!)
      }
    }

    if (capturedRule.mode === 'auto' && ruleSuccessCards.length > 0) {
      // The cascade cards are the DEST cards created (not the source cards)
      const createdDestCards = batchResults
        .filter((r): r is SimpleCard => r !== null)
      if (createdDestCards.length > 0) {
        nextHops.push({
          userId,
          sourceLanguage: capturedDest.source_language,
          targetLanguage: capturedDest.target_language,
          cards:          createdDestCards,
          visited:        [...visitedSet],
          isChainHop:     true,
        })
      }
    }

    // Track failures (union across rules — a card failed if it failed in ANY rule)
    for (const c of ruleFailed) {
      if (!allSuccessIds.has(c.id)) failedCards.push(c)
    }
  }

  const successCards = batch.filter(c => allSuccessIds.has(c.id))
  return { successCards, failedCards, nextHops }
}
