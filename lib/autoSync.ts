'use client'

/**
 * lib/autoSync.ts
 *
 * Fires language syncing when the user checks "Sync to other languages" at upload time.
 * Called fire-and-forget from handleCommit() / doSave() in the add/upload pages.
 *
 * Rate-limit safety:
 *   Cards are translated 5 at a time. After each batch, we wait BATCH_DELAY_MS
 *   before the next. Any card whose translation fails (null) is collected and
 *   retried up to MAX_RETRIES more times, with increasing delay between retries
 *   (RETRY_DELAY_MS × attempt number). This survives transient rate-limit spikes
 *   without losing cards.
 *
 * Cascading sync:
 *   French upload → French→Spanish rule → Spanish cards created
 *               → Spanish→Russian rule → Russian cards created
 *   _visited (pairKey = `${sourceLanguage}:${targetLanguage}`) prevents A→B→A loops.
 *
 * Cascade only happens for 'auto' mode rules — 'review_first' records a
 * pending link but creates no card, so there is nothing to cascade from.
 */

import { SupabaseLanguageSyncRuleRepository } from '@/lib/data/languageSyncRules'
import { SupabaseLanguagePairRepository }      from '@/lib/data/languagePairs'
import { SupabaseSyncedCardLinkRepository }    from '@/lib/data/syncedCardLinks'
import { SupabaseCardRepository }              from '@/lib/data/cards'
import { ensureSyncInfra }                     from '@/lib/syncFolderInfra'
import type { Card } from '@/domain'

const BATCH_SIZE     = 5
const BATCH_DELAY_MS = 600   // pause between each batch of 5
const RETRY_DELAY_MS = 3000  // base delay before a retry pass (multiplied by attempt#)
const MAX_RETRIES    = 2     // retry failed cards up to 2 more times

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function normFront(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * Process `cards` through `processOne` in batches of BATCH_SIZE.
 * Any card that returns null is retried up to MAX_RETRIES times with
 * increasing delay. Returns all successfully created/reused Cards.
 */
async function runInBatchesWithRetry(
  cards: Card[],
  processOne: (card: Card) => Promise<Card | null>,
): Promise<Card[]> {
  const results: Card[] = []
  let pending = [...cards]

  for (let attempt = 0; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt)
    const failed: Card[] = []

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(batch.map(processOne))

      for (let j = 0; j < batch.length; j++) {
        const r = batchResults[j] ?? null
        if (r !== null) results.push(r)
        else failed.push(batch[j]!)
      }

      // Wait between batches (but not after the very last one)
      if (i + BATCH_SIZE < pending.length) await sleep(BATCH_DELAY_MS)
    }

    pending = failed
  }

  if (pending.length > 0) {
    console.warn(`autoSync: ${pending.length} card(s) could not be synced after ${MAX_RETRIES} retries`)
  }

  return results
}

export async function autoSyncNewCards(
  userId: string,
  deckSourceLanguage: string,
  deckTargetLanguage: string,
  cards: Card[],
  _visited: Set<string> = new Set(),
): Promise<void> {
  if (cards.length === 0) return

  // Prevent re-entering the same source language pair (loop guard)
  const pairKey = `${deckSourceLanguage}:${deckTargetLanguage}`
  if (_visited.has(pairKey)) return
  _visited.add(pairKey)

  const pairRepo = new SupabaseLanguagePairRepository()
  const ruleRepo = new SupabaseLanguageSyncRuleRepository()
  const linkRepo = new SupabaseSyncedCardLinkRepository()
  const cardRepo = new SupabaseCardRepository()

  // Find the language pair matching this deck's direction
  const allPairs = await pairRepo.list(userId)
  const sourcePair = allPairs.find(
    p => p.sourceLanguage === deckSourceLanguage && p.targetLanguage === deckTargetLanguage
  )
  if (!sourcePair) return

  // Find all enabled rules for this source pair
  const allRules = await ruleRepo.listForUser(userId)
  const rules = allRules.filter(r => r.enabled && r.sourcePairId === sourcePair.id)
  if (rules.length === 0) return

  for (const rule of rules) {
    const destPair = allPairs.find(p => p.id === rule.destinationPairId)
    if (!destPair) continue

    // Skip if we've already visited this destination as a source (loop guard)
    const destKey = `${destPair.sourceLanguage}:${destPair.targetLanguage}`
    if (_visited.has(destKey)) continue

    // Ensure folder + deck infrastructure exists
    const infra = await ensureSyncInfra(userId, sourcePair, destPair)

    // Load all cards the user already owns in the dest language direction
    const destCards = await cardRepo.listOwned(userId, destPair.sourceLanguage, destPair.targetLanguage)
    const destFronts = new Set(destCards.map(c => normFront(c.front)))
    let nextPosition = destCards.length

    // Per-card processor (closed over mutable destCards/destFronts/nextPosition)
    async function processOneCard(card: Card): Promise<Card | null> {
      try {
        const res = await fetch('/api/sync-translate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceFront:       card.front,
            sourceBack:        card.back,
            fromLanguage:      sourcePair.sourceLanguage,
            toLearnedLanguage: destPair.sourceLanguage,
            toBasisLanguage:   destPair.targetLanguage,
          }),
        })
        const data = await res.json()
        if (!data.ok) {
          console.error('autoSync: translation failed for', card.front, data.reason)
          return null
        }

        const generatedFront: string    = data.front
        const generatedBack:  string    = data.back
        const confidence: number | null = data.confidence ?? null
        const warning:    string | null = data.warning    ?? null

        let syncedCardId: string | null = null
        let resultCard:   Card  | null  = null

        if (rule.mode === 'auto') {
          const nf = normFront(generatedFront)
          const duplicate = destCards.find(c => normFront(c.front) === nf)

          if (duplicate) {
            syncedCardId = duplicate.id
            resultCard   = duplicate
            await cardRepo.addToDeck(infra.deckId, duplicate.id, nextPosition++)
          } else if (!destFronts.has(nf)) {
            destFronts.add(nf) // guard against concurrent dupes within a batch
            const pos = nextPosition++
            const [created] = await cardRepo.bulkCreate(
              infra.deckId, userId,
              destPair.sourceLanguage, destPair.targetLanguage,
              [{ front: generatedFront, back: generatedBack, position: pos }],
            )
            if (created) {
              syncedCardId = created.id
              resultCard   = created
              destCards.push(created)
            }
          }
        }

        await linkRepo.upsert({
          userId,
          sourceCardId:      card.id,
          syncedCardId,
          sourcePairId:      sourcePair.id,
          destinationPairId: rule.destinationPairId,
          syncRuleId:        rule.id,
          sourceFrontAtSync: card.front,
          sourceBackAtSync:  card.back,
          generatedFront,
          generatedBack,
          confidence,
          warning,
          status: rule.mode === 'auto' ? 'active' : 'pending',
        })

        return resultCard
      } catch (err) {
        console.error('autoSync: failed for card', card.front, err)
        return null
      }
    }

    // Run batched + retried translation/creation
    const destCardsCreated = await runInBatchesWithRetry(cards, processOneCard)

    // Cascade: sync newly created dest cards into further language pairs
    if (rule.mode === 'auto' && destCardsCreated.length > 0) {
      await autoSyncNewCards(
        userId,
        destPair.sourceLanguage,
        destPair.targetLanguage,
        destCardsCreated,
        _visited,
      )
    }
  }
}
