/**
 * lib/sessionAudio.ts — background audio hydration for study sessions.
 *
 * Session queues are built from SESSION_CARD_COLUMNS reads (`cardRepo.listForDecks`), which exclude
 * the base64 audio blobs so a whole-library load doesn't ship megabytes of MP3s to queue a few dozen
 * cards. This helper fetches the STORED clips for just the queued cards and patches them back in, so
 * playback uses the card's real clip (ElevenLabs/Forvo) instead of the TTS self-heal fallback —
 * which would re-generate (cost) and can't reproduce a Forvo native recording.
 *
 * Callers: fire right after the queue is built. Await the returned promise ONLY when the first card
 * needs its clip immediately (autoplay); otherwise let it land in the background and patch state via
 * the callback.
 */

import type { Card } from '@/domain'
import { SupabaseCardRepository } from '@/lib/data/cards'

export type AudioPatch = Map<string, { audioData: string | null; audioSources: Card['audioSources'] }>

/** True when a card plausibly has a stored clip worth hydrating (skip robotic/browser-only cards). */
export function needsAudioHydration(card: Card): boolean {
  if (card.audioData) return false               // already hydrated (offline store, or a legacy full read)
  if (card.audioSource === 'browser') return false // explicit robotic pick — never has a clip worth fetching
  return card.audioGenerated === true
}

/**
 * Fetches stored clips for every queue card that needs them and reports them via `onPatch` (called
 * once, with the full map — apply it to queue/card state). Best-effort: errors resolve to an empty
 * patch, and playback still self-heals via TTS for anything missed.
 */
export async function hydrateSessionAudio(
  cards: Card[],
  onPatch: (patch: AudioPatch) => void,
): Promise<AudioPatch> {
  const ids = [...new Set(cards.filter(needsAudioHydration).map(c => c.id))]
  if (ids.length === 0) return new Map()
  try {
    const patch = await new SupabaseCardRepository().audioForCards(ids)
    if (patch.size > 0) onPatch(patch)
    return patch
  } catch {
    return new Map()
  }
}

/** Applies a hydration patch to a card, returning a new object (or the same one when not patched). */
export function applyAudioPatch(card: Card, patch: AudioPatch): Card {
  const p = patch.get(card.id)
  return p ? { ...card, audioData: p.audioData, audioSources: p.audioSources } : card
}
