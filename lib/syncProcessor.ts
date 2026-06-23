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
import { fastTrackCardState } from '@/engine/pipeline'

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
  userId:             string
  sourceLanguage?:    string
  targetLanguage?:    string
  cards:              SimpleCard[]
  fillPending?:       boolean   // true = skip stub creation, go straight to fill phase
  fastTrackSyncMode?: 'none' | 'new_only'  // create fast-track CardStates for new synced stubs
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

// ── Infra (per-destination-pair folder hierarchy + per-day deck) ──────────────
//
// Folder structure created for each sync direction:
//
//   SYNCED VOCABULARY/           ← root, is_synced=true, per dest-pair
//     Spanish / English/         ← source-pair subfolder, is_synced=true
//       June 23 2026             ← deck; one per calendar day (reused same-day)
//       June 24 2026             ← new deck next day
//
// Both folders are protected from rename/delete in the UI.
// Deck name is today's date; multiple uploads on the same day merge into one deck.

interface PairRow { id: string; source_language: string; target_language: string }
interface RuleRow { id: string; source_pair_id: string; destination_pair_id: string; mode: string }

function formatSyncDate(date: Date): string {
  const month = date.toLocaleDateString('en-US', { month: 'long' })
  const day   = date.getDate()
  const year  = date.getFullYear()
  return `${month} ${day} ${year}`   // "June 23 2026"
}

async function ensureInfra(
  db:       ReturnType<typeof createAdminClient>,
  userId:   string,
  srcPair:  PairRow,
  destPair: PairRow,
): Promise<{ deckId: string }> {
  // ── 1. Get or create the stable folder pair ───────────────────────────────
  //
  // Each destination pair gets its OWN "SYNCED VOCABULARY" root so it appears
  // only in that language's library and can be reorganised independently.
  //
  // Three staleness cases handled:
  //   A) Both root + sub exist        → reuse as-is
  //   B) Root ok, sub deleted         → recreate sub under same root (no new root!)
  //   C) Root deleted (± sub deleted) → full recreation via createSyncFolders
  const { data: existing } = await db
    .from('language_sync_state')
    .select('root_folder_id, sub_folder_id')
    .eq('user_id', userId)
    .eq('source_pair_id', srcPair.id)
    .eq('destination_pair_id', destPair.id)
    .maybeSingle()

  let rootFolderId = ''
  let subFolderId  = ''

  if (existing) {
    const [{ data: root }, { data: sub }] = await Promise.all([
      db.from('folders').select('id').eq('id', existing.root_folder_id).is('deleted_at', null).maybeSingle(),
      db.from('folders').select('id').eq('id', existing.sub_folder_id).is('deleted_at', null).maybeSingle(),
    ])

    if (root && sub) {
      // Case A: both alive — reuse
      rootFolderId = existing.root_folder_id as string
      subFolderId  = existing.sub_folder_id  as string
    } else if (root && !sub) {
      // Case B: root ok but sub was deleted — recreate sub only, keep same root.
      // This is the common case when a user deletes a language's subfolder;
      // it must NOT create a new root (that would produce duplicates).
      console.log('[sync] stale sub-folder for', destPair.source_language, '— recreating sub only')
      rootFolderId = existing.root_folder_id as string
      const subName = `${langName(srcPair.source_language)} / ${langName(srcPair.target_language)}`
      const { data: newSub, error: subErr } = await db.from('folders').insert({
        owner_id:  userId,
        name:      subName,
        parent_id: rootFolderId,
        is_synced: true,
      }).select().single()
      if (subErr) throw new Error(subErr.message)
      subFolderId = (newSub as { id: string }).id
      await db.from('language_sync_state').delete()
        .eq('user_id', userId)
        .eq('source_pair_id', srcPair.id)
        .eq('destination_pair_id', destPair.id)
    } else {
      // Case C: root was deleted — full recreation
      console.log('[sync] stale root for', destPair.source_language, '— full recreate')
      await db.from('language_sync_state').delete()
        .eq('user_id', userId)
        .eq('source_pair_id', srcPair.id)
        .eq('destination_pair_id', destPair.id)
      ;({ rootFolderId, subFolderId } = await createSyncFolders(db, userId, srcPair, destPair))
    }
  } else {
    // No state row — look for orphaned infra before creating new folders.
    //
    // A previous Phase 1 run may have created folders but failed to save state
    // (e.g. Vercel timeout, Supabase transient error). Rather than stacking up
    // duplicate SYNCED VOCABULARY roots, adopt any orphaned root that isn't
    // already claimed by another dest language's state row.
    //
    // NOTE: ensureInfra must be called sequentially (not via Promise.all) so
    // each dest language claims its own orphan before the next one runs.
    const subName = `${langName(srcPair.source_language)} / ${langName(srcPair.target_language)}`

    // Which roots are already claimed by state rows for this user?
    const { data: claimedRows } = await db
      .from('language_sync_state')
      .select('root_folder_id')
      .eq('user_id', userId)
    const claimedRootIds = new Set(
      ((claimedRows ?? []) as Array<{ root_folder_id: string }>).map(r => r.root_folder_id)
    )

    // Unclaimed SYNCED VOCABULARY roots owned by this user
    const { data: allRootsData } = await db.from('folders')
      .select('id')
      .eq('owner_id', userId)
      .eq('name', SYNC_FOLDER_NAME)
      .is('deleted_at', null)
    const unclaimedRootIds = ((allRootsData ?? []) as Array<{ id: string }>)
      .filter(r => !claimedRootIds.has(r.id))
      .map(r => r.id)

    let adopted = false
    for (const rootId of unclaimedRootIds) {
      const { data: sub } = await db.from('folders')
        .select('id')
        .eq('owner_id', userId)
        .eq('parent_id', rootId)
        .eq('name', subName)
        .is('deleted_at', null)
        .maybeSingle()
      if (sub) {
        console.log('[sync] adopting orphaned infra for', destPair.source_language)
        rootFolderId = rootId
        subFolderId  = (sub as { id: string }).id
        adopted = true
        break
      }
    }

    if (!adopted) {
      ;({ rootFolderId, subFolderId } = await createSyncFolders(db, userId, srcPair, destPair))
    }
  }

  // ── 2. Find or create today's date deck inside the source subfolder ───────
  const todayLabel = formatSyncDate(new Date())
  const { data: existingDeck } = await db
    .from('decks')
    .select('id')
    .eq('owner_id', userId)
    .eq('folder_id', subFolderId)
    .eq('name', todayLabel)
    .is('deleted_at', null)
    .maybeSingle()

  let deckId: string
  if (existingDeck) {
    deckId = existingDeck.id as string
  } else {
    const { data: newDeck, error: deckErr } = await db.from('decks').insert({
      owner_id:         userId,
      name:             todayLabel,
      source_language:  destPair.source_language,
      target_language:  destPair.target_language,
      pipeline_id:      DEFAULT_PIPELINE_ID,
      folder_id:        subFolderId,
      syncing_complete: false,   // Phase 2 will set true when all cards are filled
    }).select().single()
    if (deckErr) throw new Error(deckErr.message)
    deckId = (newDeck as { id: string }).id
  }

  // ── 3. Persist folder IDs + latest deck in sync state ────────────────────
  const { error: stateErr } = await db.from('language_sync_state').upsert({
    user_id:             userId,
    source_pair_id:      srcPair.id,
    destination_pair_id: destPair.id,
    root_folder_id:      rootFolderId,
    sub_folder_id:       subFolderId,
    deck_id:             deckId,
  }, { onConflict: 'user_id,source_pair_id,destination_pair_id' })
  if (stateErr) throw new Error(`Failed to save sync state for ${destPair.source_language}: ${stateErr.message}`)

  return { deckId }
}

async function createSyncFolders(
  db:       ReturnType<typeof createAdminClient>,
  userId:   string,
  srcPair:  PairRow,
  destPair: PairRow,
): Promise<{ rootFolderId: string; subFolderId: string }> {
  // Called only when no state row exists or the root was deleted.
  // Always creates a fresh root so each destination language gets its OWN
  // independent "SYNCED VOCABULARY" folder, visible only in that language's
  // library and movable without affecting other languages.
  const { data: root, error: rootErr } = await db.from('folders').insert({
    owner_id:  userId,
    name:      SYNC_FOLDER_NAME,
    parent_id: null,
    is_synced: true,
  }).select().single()
  if (rootErr) throw new Error(rootErr.message)

  const subName = `${langName(srcPair.source_language)} / ${langName(srcPair.target_language)}`
  const { data: sub, error: subErr } = await db.from('folders').insert({
    owner_id:  userId,
    name:      subName,
    parent_id: (root as { id: string }).id,
    is_synced: true,
  }).select().single()
  if (subErr) throw new Error(subErr.message)

  return {
    rootFolderId: (root as { id: string }).id,
    subFolderId:  (sub  as { id: string }).id,
  }
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
/** Compute spread due dates for fast-track stubs using the admin client. */
async function batchFastTrackDueDatesServer(
  db:        ReturnType<typeof createAdminClient>,
  userId:    string,
  count:     number,
  startDate: Date,
): Promise<string[]> {
  if (count === 0) return []
  const DAY_MS    = 24 * 60 * 60 * 1000
  const windowDays = Math.min(30, Math.ceil(count / 3))
  const windowEnd  = new Date(startDate.getTime() + (windowDays + 1) * DAY_MS)

  const { data } = await db.from('card_states')
    .select('due_at')
    .eq('user_id', userId)
    .eq('graduated', true)
    .gte('due_at', new Date(startDate.getTime() + DAY_MS).toISOString())
    .lt('due_at', windowEnd.toISOString())

  const existing = new Map<string, number>()
  for (const row of (data ?? []) as Array<{ due_at: string | null }>) {
    if (!row.due_at) continue
    const day = row.due_at.slice(0, 10)
    existing.set(day, (existing.get(day) ?? 0) + 1)
  }

  const days: string[] = []
  for (let d = 1; d <= windowDays; d++) {
    days.push(new Date(startDate.getTime() + d * DAY_MS).toISOString().slice(0, 10))
  }
  const load = new Map<string, number>()
  for (const day of days) load.set(day, existing.get(day) ?? 0)

  const result: string[] = []
  for (let i = 0; i < count; i++) {
    let bestDay  = days[0]!
    let bestLoad = load.get(bestDay)!
    for (const day of days) {
      const l = load.get(day)!
      if (l < bestLoad) { bestLoad = l; bestDay = day }
    }
    result.push(bestDay + 'T12:00:00.000Z')
    load.set(bestDay, bestLoad + 1)
  }
  return result
}

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

  // Process destination languages sequentially — ensures orphan-infra adoption
  // (no-state-row recovery) claims each root before the next language runs,
  // preventing two languages from competing for the same unclaimed root.
  for (const { pair: destPair, rule } of destinations) {
    const infra = await ensureInfra(db, userId, src, destPair)

    // Find which source cards have already been synced to this destination.
    // We also fetch the synced_card_id so we can detect dead links — links whose
    // synced card was later deleted. Dead links must not block re-syncing, and
    // must be removed before upserting new links (they share the same unique key).
    const { data: existingLinksRaw } = await db
      .from('synced_card_links')
      .select('source_card_id, source_front_at_sync, synced_card_id')
      .eq('user_id', userId)
      .eq('destination_pair_id', destPair.id)

    type RawLink = { source_card_id: string; source_front_at_sync: string; synced_card_id: string }
    const rawLinks = (existingLinksRaw ?? []) as RawLink[]

    // Which of those synced cards have been soft-deleted?
    const syncedCardIds = rawLinks.map(l => l.synced_card_id).filter(Boolean)
    const deadCardIds   = new Set<string>()
    if (syncedCardIds.length > 0) {
      const { data: deadCards } = await db.from('cards')
        .select('id').in('id', syncedCardIds).not('deleted_at', 'is', null)
      for (const c of (deadCards ?? []) as Array<{ id: string }>) deadCardIds.add(c.id)
    }

    const aliveLinks = rawLinks.filter(l => !deadCardIds.has(l.synced_card_id))
    const deadLinks  = rawLinks.filter(l =>  deadCardIds.has(l.synced_card_id))

    const alreadySyncedIds    = new Set(aliveLinks.map(l => l.source_card_id))
    const alreadySyncedFronts = new Set(
      aliveLinks.map(l => l.source_front_at_sync?.toLowerCase()).filter(Boolean),
    )
    const toSync = sourceCards.filter(c =>
      !alreadySyncedIds.has(c.id) && !alreadySyncedFronts.has(c.front.toLowerCase()),
    )
    if (toSync.length === 0) continue

    // Remove dead links for source cards we're about to re-sync.
    // Without this, the upsert below would hit the (source_card_id, destination_pair_id)
    // unique conflict and silently skip inserting the fresh link.
    const deadLinkSourceIds = new Set(deadLinks.map(l => l.source_card_id))
    const toResyncIds = toSync.map(c => c.id).filter(id => deadLinkSourceIds.has(id))
    if (toResyncIds.length > 0) {
      await db.from('synced_card_links').delete()
        .in('source_card_id', toResyncIds)
        .eq('destination_pair_id', destPair.id)
        .eq('user_id', userId)
    }

    // Get existing card count for position offset
    const { count: existingCount } = await db
      .from('cards')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .eq('source_language', destPair.source_language)
      .eq('target_language', destPair.target_language)
      .is('deleted_at', null)
    const basePosition = existingCount ?? 0

    // Bulk-insert blank stub cards.
    // front/back start empty — Phase 2 fills them via AI translation.
    // synced_from_language and origin_word record the source permanently.
    const { data: created, error: insertErr } = await db
      .from('cards')
      .insert(toSync.map((c, i) => ({
        owner_id:              userId,
        source_language:       destPair.source_language,
        target_language:       destPair.target_language,
        front:                 '',
        back:                  '',
        hints:                 [],
        synced_from_languages: [src.source_language],  // e.g. ['es']
        origin_words:          [c.front],              // e.g. ['el perro']
        position:              basePosition + i,
      })))
      .select('id')
    if (insertErr) {
      console.error('[sync] stub insert error', insertErr.message)
      continue
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

    // Create fast-track CardStates for the new synced stubs if requested.
    if (payload.fastTrackSyncMode === 'new_only' && createdCards.length > 0) {
      try {
        const now      = new Date()
        const dueDates = await batchFastTrackDueDatesServer(db, userId, createdCards.length, now)
        const states   = createdCards.map((c, i) =>
          fastTrackCardState(userId, c.id, DEFAULT_PIPELINE_ID, dueDates[i]!, 30, now)
        )
        const rows = states.map(s => ({
          user_id: s.userId, card_id: s.cardId, pipeline_id: s.pipelineId,
          current_step_order: s.currentStepOrder, correct_in_step: s.correctInStep,
          graduated: s.graduated, due_at: s.dueAt, interval_days: s.intervalDays,
          scheduled_interval_days: s.scheduledIntervalDays,
          ease: s.ease, reps: s.reps, lapses: s.lapses,
          last_rating: s.lastRating, last_reviewed_at: s.lastReviewedAt,
          introduced_date: s.introducedDate,
          lapse_cluster_count: s.lapseClusterCount, last_lapse_at: s.lastLapseAt,
          graduated_at: s.graduatedAt,
          relearning_step: s.relearningStep, pending_interval_days: s.pendingIntervalDays,
          typed_accuracy_window: s.typedAccuracyWindow, typed_review_count: s.typedReviewCount,
          last_typed_review_at: s.lastTypedReviewAt, forced_typed_remaining: s.forcedTypedRemaining,
          interval_history: s.intervalHistory,
          typing_mistake_streak: s.typingMistakeStreak, typing_fail_cycles: s.typingFailCycles,
          stage3_entered_date: s.stage3EnteredDate,
          i_dont_know_count: s.iDontKnowCount,
          accent_mistake_count: s.accentMistakeCount, article_mistake_count: s.articleMistakeCount,
          gender_mistake_count: s.genderMistakeCount, typo_mistake_count: s.typoMistakeCount,
          semantic_mistake_count: s.semanticMistakeCount, wrong_synonym_count: s.wrongSynonymCount,
          accelerated_mode: s.acceleratedMode, accelerated_locked: s.acceleratedLocked,
          accelerated_wrong_streak: s.acceleratedWrongStreak, accelerated_penalty: s.acceleratedPenalty,
        }))
        const { error: stateErr } = await db.from('card_states').upsert(rows, { onConflict: 'user_id,card_id' })
        if (stateErr) console.error('[sync] fast-track state insert error', stateErr.message)
      } catch (err) {
        console.error('[sync] fast-track state creation failed', err)
      }
    }

    totalPending += createdCards.length
  }

  return { pendingCount: totalPending }
}

// ── Phase 2: Fill translations (all pending at once) ─────────────────────────

/**
 * Translates ALL pending stub cards for this user simultaneously.
 * Each card independently calls Anthropic using the source word stored in
 * its hidden `__sync_source:` hint. On success: fills in the real front/back,
 * removes the hidden hint, and marks the link active. Returns remaining count
 * (non-zero only if some calls failed and need a retry pass).
 */
export async function fillAllPending(userId: string): Promise<{ filled: number; remaining: number }> {
  const db     = createAdminClient()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { filled: 0, remaining: 0 }

  // Fetch ALL pending links for this user (no limit — all run in parallel)
  const { data: pending } = await db
    .from('synced_card_links')
    .select('id, synced_card_id, source_pair_id, destination_pair_id, source_front_at_sync, source_back_at_sync')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .not('synced_card_id', 'is', null)

  if (!pending || pending.length === 0) return { filled: 0, remaining: 0 }

  const { data: pairsData } = await db
    .from('language_pairs')
    .select('id, source_language, target_language')
    .eq('owner_id', userId)
  const pairs = (pairsData ?? []) as PairRow[]

  // Every pending card calls the AI independently and simultaneously
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

      // ── Case 2: detect if a different synced card already has this front ────
      // Different source languages can produce the same dest word (e.g. Spanish
      // "rojo" and Italian "rosso" both translate to French "rouge"). When that
      // happens: reuse the existing card, add it to the current stub's deck,
      // append source info to the existing card's arrays, and soft-delete the stub.
      const { data: matchRows } = await db.from('cards')
        .select('id, origin_words, synced_from_languages')
        .eq('owner_id', userId)
        .eq('source_language', destPair.source_language)
        .eq('target_language', destPair.target_language)
        .ilike('front', newFront)
        .is('deleted_at', null)
        .neq('id', link.synced_card_id)

      type SyncedCardRow = { id: string; origin_words: string[]; synced_from_languages: string[] }
      const existingMatch = ((matchRows ?? []) as SyncedCardRow[])
        .find(r => (r.origin_words?.length ?? 0) > 0)  // only consider synced cards

      if (existingMatch) {
        // Move stub's deck membership to the existing card
        const { data: dcRow } = await db.from('deck_cards')
          .select('deck_id, position')
          .eq('card_id', link.synced_card_id)
          .maybeSingle()

        if (dcRow) {
          const dc = dcRow as { deck_id: string; position: number }
          await db.from('deck_cards').upsert(
            { deck_id: dc.deck_id, card_id: existingMatch.id, position: dc.position },
            { onConflict: 'deck_id,card_id', ignoreDuplicates: true },
          )
          await db.from('deck_cards').delete()
            .eq('deck_id', dc.deck_id)
            .eq('card_id', link.synced_card_id)
        }

        // Append this source language + word to the existing card (no duplicates)
        const currentOrigins = existingMatch.origin_words ?? []
        const currentLangs   = existingMatch.synced_from_languages ?? []
        if (!currentOrigins.includes(link.source_front_at_sync)) {
          await db.from('cards').update({
            origin_words:          [...currentOrigins, link.source_front_at_sync],
            synced_from_languages: [...currentLangs,   srcPair.source_language],
          }).eq('id', existingMatch.id)
        }

        // Soft-delete the now-redundant stub
        await db.from('cards')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', link.synced_card_id)

        // Point the link to the existing card and mark it active
        await db.from('synced_card_links')
          .update({
            synced_card_id:  existingMatch.id,
            generated_front: newFront,
            generated_back:  newBack,
            confidence:      typeof parsed.confidence === 'number' ? parsed.confidence : null,
            warning:         typeof parsed.warning    === 'string' && parsed.warning   ? parsed.warning : null,
            status:          'active',
          })
          .eq('id', link.id)

        return true
      }

      // Normal path: fill the stub in place
      await db.from('cards')
        .update({ front: newFront, back: newBack })
        .eq('id', link.synced_card_id)

      // Mark the link active
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
      console.error('[sync] fill failed for', link.source_front_at_sync, err)
      return false
    }
  }))

  const filled = results.filter(Boolean).length

  const { count } = await db
    .from('synced_card_links')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'pending')
    .not('synced_card_id', 'is', null)

  const remaining = count ?? 0

  // All pending cards filled — mark every incomplete synced deck as done
  if (remaining === 0) {
    await db.from('decks')
      .update({ syncing_complete: true })
      .eq('owner_id', userId)
      .eq('syncing_complete', false)
  }

  return { filled, remaining }
}
