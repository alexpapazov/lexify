'use client'

/**
 * lib/autoSync.ts
 *
 * Triggers language syncing automatically when cards are created.
 * Called fire-and-forget from the add-cards page after bulkCreate.
 *
 * For each enabled sync rule where:
 *   - source_pair matches the deck's language direction
 *   - trigger = 'on_card_created'
 *
 * In 'auto' mode: translate + deduplicate + create card in dest deck.
 * In 'review_first' mode: translate + record pending link (no card created yet).
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
): Promise<void> {
  if (cards.length === 0) return

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

    // Ensure folder + deck infrastructure exists
    const infra = await ensureSyncInfra(userId, sourcePair, destPair)

    // Load all cards the user already owns in the dest language direction
    // (used for duplicate detection and positioning)
    const destCards = await cardRepo.listOwned(userId, destPair.sourceLanguage, destPair.targetLanguage)
    const destFronts = new Set(destCards.map(c => normFront(c.front)))
    let nextPosition = destCards.length

    // Process all cards for this rule in parallel
    await Promise.all(cards.map(async (card) => {
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
          return
        }

        const generatedFront: string = data.front
        const generatedBack:  string = data.back
        const confidence: number | null = data.confidence ?? null
        const warning:    string | null = data.warning    ?? null

        let syncedCardId: string | null = null

        if (rule.mode === 'auto') {
          const nf = normFront(generatedFront)
          const duplicate = destCards.find(c => normFront(c.front) === nf)

          if (duplicate) {
            // Reuse existing card — add it to the dest deck without creating a duplicate
            syncedCardId = duplicate.id
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
      } catch (err) {
        console.error('autoSync: failed for card', card.front, err)
      }
    }))
  }

}
