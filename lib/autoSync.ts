'use client'

/**
 * lib/autoSync.ts
 *
 * Fires language syncing when the user checks "Sync to other languages" at upload time.
 * Called fire-and-forget from handleCommit() in app/study/[deckId]/add/page.tsx.
 *
 * Supports transitive (cascading) sync:
 *   French upload → French→Spanish rule → Spanish cards created
 *                → Spanish→Russian rule → Russian cards created
 *
 * The _visited set (pairKey = `${sourceLanguage}:${targetLanguage}`) prevents
 * infinite loops (e.g. Spanish→French→Spanish→…).
 *
 * Cascade only happens for 'auto' mode rules — 'review_first' records a
 * pending link but creates no card, so there is nothing to cascade from.
 */

import { SupabaseLanguageSyncRuleRepository } from '@/lib/data/languageSyncRules'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseSyncedCardLinkRepository } from '@/lib/data/syncedCardLinks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { ensureSyncInfra } from '@/lib/syncFolderInfra'
import type { Card } from '@/domain'

function normFront(s: string): string {
  return s.trim().toLowerCase()
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

    // Translate and create/link all source cards in parallel.
    // Returns the Card that ended up in the dest deck (new or reused), or null on failure.
    const destCardsCreated = (await Promise.all(cards.map(async (card): Promise<Card | null> => {
      try {
        // Translate
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

        const generatedFront: string      = data.front
        const generatedBack:  string      = data.back
        const confidence: number | null   = data.confidence ?? null
        const warning:    string | null   = data.warning    ?? null

        let syncedCardId: string | null = null
        let resultCard:   Card  | null = null

        if (rule.mode === 'auto') {
          const nf = normFront(generatedFront)
          const duplicate = destCards.find(c => normFront(c.front) === nf)

          if (duplicate) {
            // Reuse existing card — add to dest deck, no new row
            syncedCardId = duplicate.id
            resultCard   = duplicate
            await cardRepo.addToDeck(infra.deckId, duplicate.id, nextPosition++)
          } else if (!destFronts.has(nf)) {
            // No duplicate — create new card
            destFronts.add(nf) // guard against concurrent dupes within this batch
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

        // Record the link (upsert is safe to re-run)
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
    }))).filter((c): c is Card => c !== null)

    // Cascade: sync the newly created dest cards into further language pairs.
    // Only 'auto' mode produces real cards to cascade from.
    // _visited is passed by reference so loops are prevented across all branches.
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
