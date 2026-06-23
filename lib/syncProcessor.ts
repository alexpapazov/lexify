/**
 * lib/syncProcessor.ts
 *
 * Server-side language sync — single-batch processor.
 * Processes exactly one batch of cards (BATCH_SIZE) per call.
 *
 * For each batch, ALL destination languages reachable from the source pair
 * (via BFS through the sync rules) receive translations DIRECTLY from the
 * source cards. No cascade hops — each language level is translated fresh
 * from the original source, not from an intermediate translated language.
 *
 * Retries and continuation are handled by the API route, which re-invokes
 * itself with the remaining cards.
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
  failCounts?:    Record<string, number>  // cardId → cumulative failure count
}

export interface BatchResult {
  successCards: SimpleCard[]
  failedCards:  SimpleCard[]
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

// ── Infra (per-destination-pair folder + deck) ────────────────────────────────

interface PairRow { id: string; source_language: string; target_language: string }
interface RuleRow { id: string; source_pair_id: string; destination_pair_id: string; mode: string }

async function ensureInfra(
  db:       ReturnType<typeof createAdminClient>,
  userId:   string,
  srcPair:  PairRow,
  destPair: PairRow,
): Promise<{ deckId: string }> {
  const { data: existing } = await db
    .from('language_sync_state')
    .select('deck_id, root_folder_id')
    .eq('user_id', userId)
    .eq('source_pair_id', srcPair.id)
    .eq('destination_pair_id', destPair.id)
    .maybeSingle()

  if (existing) {
    // Verify both the deck and its folder still exist
    const [{ data: deck }, { data: folder }] = await Promise.all([
      db.from('decks').select('id').eq('id', existing.deck_id).is('deleted_at', null).maybeSingle(),
      db.from('folders').select('id').eq('id', existing.root_folder_id).is('deleted_at', null).maybeSingle(),
    ])
    if (deck && folder) return { deckId: existing.deck_id as string }
    // Stale — clear and recreate
    console.log('[sync] ensureInfra: stale infra for', destPair.source_language, '— recreating')
    await db
      .from('language_sync_state')
      .delete()
      .eq('user_id', userId)
      .eq('source_pair_id', srcPair.id)
      .eq('destination_pair_id', destPair.id)
  }

  // Each destination pair gets its OWN "SYNCED VOCABULARY" folder so it only
  // appears in that language's library view, not across all languages.
  const { data: folder, error: folderErr } = await db
    .from('folders')
    .insert({ owner_id: userId, name: SYNC_FOLDER_NAME, parent_id: null })
    .select().single()
  if (folderErr) throw new Error(folderErr.message)
  const rootFolderId = folder.id as string

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

// ── BFS helper: find all destination pairs reachable from srcPairId ───────────

function findAllDestinations(
  srcPairId: string,
  allRules:  RuleRow[],
  allPairs:  PairRow[],
): Array<{ pair: PairRow; rule: RuleRow }> {
  const visited = new Set<string>([srcPairId])
  const queue   = [srcPairId]
  const result: Array<{ pair: PairRow; rule: RuleRow }> = []

  while (queue.length > 0) {
    const currentId = queue.shift()!
    for (const rule of allRules) {
      if (rule.source_pair_id !== currentId) continue
      if (visited.has(rule.destination_pair_id)) continue
      const destPair = allPairs.find(p => p.id === rule.destination_pair_id)
      if (!destPair) continue
      visited.add(rule.destination_pair_id)
      result.push({ pair: destPair, rule })
      queue.push(rule.destination_pair_id)  // follow the chain
    }
  }

  return result
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Process one batch of cards (payload.cards.slice(0, BATCH_SIZE)).
 * Translates to ALL destination languages simultaneously (BFS through rules).
 * Does NOT loop or retry — the API route handles continuation and retries.
 */
export async function processSyncBatch(payload: SyncPayload): Promise<BatchResult> {
  const { userId, sourceLanguage, targetLanguage } = payload
  const batch = payload.cards.slice(0, BATCH_SIZE)

  if (batch.length === 0) return { successCards: [], failedCards: [] }

  const db     = createAdminClient()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('syncProcessor: ANTHROPIC_API_KEY not set')
    return { successCards: [], failedCards: batch }
  }

  const { data: pairsData } = await db
    .from('language_pairs')
    .select('id, source_language, target_language')
    .eq('owner_id', userId)

  const pairs = (pairsData ?? []) as PairRow[]
  const src   = pairs.find(p => p.source_language === sourceLanguage && p.target_language === targetLanguage)
  if (!src) return { successCards: [], failedCards: batch }

  const { data: rulesData } = await db
    .from('language_sync_rules')
    .select('id, source_pair_id, destination_pair_id, mode, enabled')
    .eq('user_id', userId)
    .eq('enabled', true)

  const allRules = (rulesData ?? []) as RuleRow[]
  // BFS from src: find every language reachable through the rule chain
  const destinations = findAllDestinations(src.id, allRules, pairs)

  if (destinations.length === 0) return { successCards: [], failedCards: [] }

  const allSuccessIds = new Set<string>()
  const failedIds     = new Set<string>()

  // Process ALL destination languages for this batch simultaneously
  await Promise.all(destinations.map(async ({ pair: destPair, rule }) => {
    if (rule.mode !== 'auto') return

    const infra = await ensureInfra(db, userId, src, destPair)

    const { data: existingData } = await db
      .from('cards')
      .select('id, front, back')
      .eq('owner_id', userId)
      .eq('source_language', destPair.source_language)
      .eq('target_language', destPair.target_language)
      .is('deleted_at', null)

    const destCards  = (existingData ?? []) as SimpleCard[]
    const destFronts = new Set(destCards.map(c => normFront(c.front)))
    let   nextPos    = destCards.length

    const batchResults = await Promise.all(batch.map(async (card): Promise<boolean> => {
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
              src.source_language,
              destPair.source_language,
              destPair.target_language,
            )}],
          }),
        })
        if (!res.ok) return false

        const data  = await res.json()
        const text: string = data?.content?.[0]?.text ?? ''
        const match = /\{[\s\S]*\}/.exec(text)
        if (!match) return false
        let parsed: Record<string, unknown>
        try { parsed = JSON.parse(match[0]) } catch { return false }
        if (typeof parsed.front !== 'string' || typeof parsed.back !== 'string') return false

        const generatedFront = (parsed.front as string).trim()
        const generatedBack  = (parsed.back  as string).trim()
        const confidence     = typeof parsed.confidence === 'number' ? parsed.confidence : null
        const warning        = typeof parsed.warning    === 'string' && parsed.warning ? parsed.warning : null

        const nf        = normFront(generatedFront)
        const duplicate = destCards.find(c => normFront(c.front) === nf)
        let syncedCardId: string | null = null

        if (duplicate) {
          syncedCardId = duplicate.id
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
              source_language: destPair.source_language,
              target_language: destPair.target_language,
              front:           generatedFront,
              back:            generatedBack,
              hints:           [],
              position:        pos,
            })
            .select('id, front, back').single()
          if (!createErr && created) {
            syncedCardId = created.id as string
            destCards.push({ id: created.id as string, front: generatedFront, back: generatedBack })
            await db.from('deck_cards').upsert(
              { deck_id: infra.deckId, card_id: created.id, position: pos },
              { onConflict: 'deck_id,card_id', ignoreDuplicates: true },
            )
          }
        } else {
          // Duplicate detected in-flight — treat as success (card already exists)
          syncedCardId = destCards.find(c => normFront(c.front) === nf)?.id ?? null
        }

        await db.from('synced_card_links').upsert({
          user_id:              userId,
          source_card_id:       card.id,
          synced_card_id:       syncedCardId,
          source_pair_id:       src.id,
          destination_pair_id:  rule.destination_pair_id,
          sync_rule_id:         rule.id,
          source_front_at_sync: card.front,
          source_back_at_sync:  card.back,
          generated_front:      generatedFront,
          generated_back:       generatedBack,
          confidence,
          warning,
          status: 'active',
        }, { onConflict: 'source_card_id,destination_pair_id' })

        return true
      } catch (err) {
        console.error('syncProcessor: failed for card', card.front, 'to', destPair.source_language, err)
        return false
      }
    }))

    // Track which cards succeeded/failed for this destination
    for (let i = 0; i < batch.length; i++) {
      if (batchResults[i]) {
        allSuccessIds.add(batch[i]!.id)
      } else {
        failedIds.add(batch[i]!.id)
      }
    }
  }))

  // A card is "failed" only if it failed in ALL destination languages
  const successCards = batch.filter(c => allSuccessIds.has(c.id))
  const failedCards  = batch.filter(c => !allSuccessIds.has(c.id))
  return { successCards, failedCards }
}
