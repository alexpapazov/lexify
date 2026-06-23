/**
 * lib/syncProcessor.ts
 *
 * Two-phase server-side language sync.
 *
 * PHASE 1 — Stub creation (no AI, instant):
 *   createAllStubs() is called once per upload. It BFS-walks the sync rules,
 *   finds every reachable destination language, and immediately creates
 *   placeholder cards (front = original word, e.g. "el perro"; back = basis
 *   gloss, e.g. "dog"). All cards appear in their decks right away. Each stub
 *   has a matching `synced_card_links` row with status = 'pending'.
 *
 * PHASE 2 — Translation fill (AI, one card at a time):
 *   fillPendingBatch() is called by the self-chaining /api/sync route. It
 *   fetches FILL_BATCH pending links, calls Anthropic once per link to
 *   translate the stored original word into the destination language, and
 *   updates the card's front/back in-place. Each fill invocation makes
 *   FILL_BATCH parallel Anthropic calls (≈2 s). The chain continues until
 *   all pending links are active.
 *
 * Max concurrent Vercel invocations = 1 (sequential self-chain). No cascade.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { langName }          from '@/lib/languages'

export const FILL_BATCH      = 5
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
  userId:          string
  sourceLanguage?: string
  targetLanguage?: string
  cards:           SimpleCard[]
  fillPending?:    boolean   // true = skip stub creation, go straight to fill phase
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTranslationPrompt(
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
    const [{ data: deck }, { data: folder }] = await Promise.all([
      db.from('decks').select('id').eq('id', existing.deck_id).is('deleted_at', null).maybeSingle(),
      db.from('folders').select('id').eq('id', existing.root_folder_id).is('deleted_at', null).maybeSingle(),
    ])
    if (deck && folder) return { deckId: existing.deck_id as string }
    // Stale — clear and recreate
    console.log('[sync] stale infra for', destPair.source_language, '— recreating')
    await db
      .from('language_sync_state')
      .delete()
      .eq('user_id', userId)
      .eq('source_pair_id', srcPair.id)
      .eq('destination_pair_id', destPair.id)
  }

  // Each destination pair gets its own "SYNCED VOCABULARY" folder so it only
  // appears in that language's library view.
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

// ── BFS: find all destinations reachable from srcPairId ───────────────────────

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
      queue.push(rule.destination_pair_id)
    }
  }

  return result
}

// ── Phase 1: Create stub cards (no AI) ───────────────────────────────────────

/**
 * Creates placeholder cards for all destination languages immediately.
 * Each stub has the original source word as its front/back so the user can
 * see the card right away. A pending `synced_card_links` row is stored for
 * each stub — Phase 2 will replace the placeholder with the real translation.
 */
export async function createAllStubs(payload: SyncPayload): Promise<{ pendingCount: number }> {
  const { userId, sourceLanguage, targetLanguage, cards: sourceCards } = payload
  if (sourceCards.length === 0) return { pendingCount: 0 }

  const db = createAdminClient()

  const { data: pairsData } = await db
    .from('language_pairs')
    .select('id, source_language, target_language')
    .eq('owner_id', userId)
  const pairs = (pairsData ?? []) as PairRow[]

  const src = pairs.find(p => p.source_language === sourceLanguage! && p.target_language === targetLanguage!)
  if (!src) return { pendingCount: 0 }

  const { data: rulesData } = await db
    .from('language_sync_rules')
    .select('id, source_pair_id, destination_pair_id, mode, enabled')
    .eq('user_id', userId)
    .eq('enabled', true)
  const allRules = (rulesData ?? []) as RuleRow[]

  const destinations = findAllDestinations(src.id, allRules, pairs)
    .filter(d => d.rule.mode === 'auto')
  if (destinations.length === 0) return { pendingCount: 0 }

  let totalPending = 0

  // Process all destination languages in parallel
  await Promise.all(destinations.map(async ({ pair: destPair, rule }) => {
    const infra = await ensureInfra(db, userId, src, destPair)

    // Find which source cards have already been synced to this destination
    const { data: existingLinks } = await db
      .from('synced_card_links')
      .select('source_card_id')
      .eq('user_id', userId)
      .eq('destination_pair_id', destPair.id)

    const alreadySynced = new Set((existingLinks ?? []).map((l: { source_card_id: string }) => l.source_card_id))
    const toSync = sourceCards.filter(c => !alreadySynced.has(c.id))
    if (toSync.length === 0) return

    // Get existing card count for position offset
    const { count: existingCount } = await db
      .from('cards')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .eq('source_language', destPair.source_language)
      .eq('target_language', destPair.target_language)
      .is('deleted_at', null)
    const basePosition = existingCount ?? 0

    // Bulk-insert stub cards (source word as placeholder front/back)
    const { data: created, error: insertErr } = await db
      .from('cards')
      .insert(toSync.map((c, i) => ({
        owner_id:        userId,
        source_language: destPair.source_language,
        target_language: destPair.target_language,
        front:           c.front,   // placeholder: original source word
        back:            c.back,    // placeholder: original basis-language meaning
        hints:           [],
        position:        basePosition + i,
      })))
      .select('id')
    if (insertErr) {
      console.error('[sync] stub insert error', insertErr.message)
      return
    }

    const createdCards = (created ?? []) as Array<{ id: string }>

    // Link stubs to the synced deck
    await db.from('deck_cards').upsert(
      createdCards.map((c, i) => ({
        deck_id:  infra.deckId,
        card_id:  c.id,
        position: basePosition + i,
      })),
      { onConflict: 'deck_id,card_id', ignoreDuplicates: true },
    )

    // Create pending sync links (source word stored for Phase 2 to use)
    const linkRows = createdCards.flatMap((stubCard, i) => {
      const srcCard = toSync[i]
      if (!srcCard) return []
      return [{
        user_id:              userId,
        source_card_id:       srcCard.id,
        synced_card_id:       stubCard.id,
        source_pair_id:       src.id,
        destination_pair_id:  destPair.id,
        sync_rule_id:         rule.id,
        source_front_at_sync: srcCard.front,   // "el perro" — used by Phase 2
        source_back_at_sync:  srcCard.back,    // "dog"
        generated_front:      '',  // NOT NULL in schema; filled by Phase 2
        generated_back:       '',  // NOT NULL in schema; filled by Phase 2
        confidence:           null,
        warning:              null,
        status:               'pending',
      }]
    })
    await db.from('synced_card_links').upsert(
      linkRows,
      { onConflict: 'source_card_id,destination_pair_id', ignoreDuplicates: true },
    )

    totalPending += createdCards.length
  }))

  return { pendingCount: totalPending }
}

// ── Phase 2: Fill translations (one batch of Anthropic calls) ─────────────────

/**
 * Translates up to FILL_BATCH pending stub cards. Reads the stored original
 * word from `synced_card_links.source_front_at_sync`, calls Anthropic, and
 * updates the card's front/back in-place. Returns remaining pending count.
 */
export async function fillPendingBatch(userId: string): Promise<{ filled: number; remaining: number }> {
  const db     = createAdminClient()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { filled: 0, remaining: 0 }

  // Fetch next batch of pending links
  const { data: pending } = await db
    .from('synced_card_links')
    .select('id, synced_card_id, source_pair_id, destination_pair_id, source_front_at_sync, source_back_at_sync')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .not('synced_card_id', 'is', null)
    .limit(FILL_BATCH)

  if (!pending || pending.length === 0) return { filled: 0, remaining: 0 }

  const { data: pairsData } = await db
    .from('language_pairs')
    .select('id, source_language, target_language')
    .eq('owner_id', userId)
  const pairs = (pairsData ?? []) as PairRow[]

  // Translate all FILL_BATCH links in parallel
  const results = await Promise.all(pending.map(async (link: {
    id: string
    synced_card_id: string
    source_pair_id: string
    destination_pair_id: string
    source_front_at_sync: string
    source_back_at_sync: string
  }) => {
    const srcPair  = pairs.find(p => p.id === link.source_pair_id)
    const destPair = pairs.find(p => p.id === link.destination_pair_id)
    if (!srcPair || !destPair) return false

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
          messages:   [{ role: 'user', content: buildTranslationPrompt(
            link.source_front_at_sync,
            link.source_back_at_sync,
            srcPair.source_language,
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

      const newFront = (parsed.front as string).trim()
      const newBack  = (parsed.back  as string).trim()
      if (!newFront || !newBack) return false

      // Update the stub card with the real translation
      await db.from('cards')
        .update({ front: newFront, back: newBack })
        .eq('id', link.synced_card_id)

      // Mark the link as active
      await db.from('synced_card_links')
        .update({
          generated_front: newFront,
          generated_back:  newBack,
          confidence:      typeof parsed.confidence === 'number' ? parsed.confidence : null,
          warning:         typeof parsed.warning    === 'string' && parsed.warning   ? parsed.warning : null,
          status:          'active',
        })
        .eq('id', link.id)

      return true
    } catch (err) {
      console.error('[sync] fill failed for card', link.source_front_at_sync, err)
      return false
    }
  }))

  const filled = results.filter(Boolean).length

  // Count remaining pending links for this user
  const { count } = await db
    .from('synced_card_links')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'pending')
    .not('synced_card_id', 'is', null)

  return { filled, remaining: count ?? 0 }
}
