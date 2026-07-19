/**
 * lib/offline/types.ts — shapes for the offline local store: the download bundle written into it,
 * the outbox of local changes to push on reconnect, and the manifest describing what was downloaded.
 */
import type { Card, CardState, Deck, Folder } from '@/domain'

// ── Scope of a download ──────────────────────────────────────────────────────
export type OfflineScopeKind = 'deck' | 'folder' | 'language' | 'library'
export interface OfflineScope {
  kind:     OfflineScopeKind
  deckId?:  string
  folderId?: string
  source?:  string
  target?:  string
}

export interface Manifest {
  userId:        string
  scope:         OfflineScope     // first scope (back-compat)
  scopes?:       OfflineScope[]   // all selected scopes — used to re-download / "update"
  dueWindowDays: number     // how far ahead Due-Now cards were included
  includeAudio:  boolean    // whether cached audio clips were bundled
  downloadedAt:  string     // ISO
  cardCount:     number
  bytes?:        number     // approximate bundle size on device
}

// ── Stored rows (domain object + local sync metadata) ────────────────────────
/** `serverUpdatedAt` = the row's server `updated_at` when downloaded/last synced — the baseline the
 *  sync engine compares against to detect a server-side change (→ conflict). */
export type StoredCardState = CardState & { key: string; serverUpdatedAt: string | null }
export interface StoredClimb  { cardId: string; deckId: string; state: unknown; serverUpdatedAt: string | null }
export interface StoredLadder { key: string; source: string | null; target: string | null; ladder: unknown }
export interface StoredParam  { key: string; source: string; target: string; answerField: string; row: unknown }
export interface StoredLink   { id: string; [k: string]: unknown }
export interface StoredOverride { key: string; cardId: string; answerSide: string; answerText: string }
export interface StoredDeckCard { key: string; deckId: string; cardId: string }

// ── Outbox: local changes queued for the next online sync ────────────────────
export type OutboxEntity = 'cardState' | 'ladderClimb' | 'ladderEvent' | 'reviewEvent' | 'override' | 'card' | 'cardCreate'
export interface OutboxEntry {
  id?:            number       // Dexie auto-increment
  entity:         OutboxEntity
  key:            string       // the affected row's key
  op:             'upsert' | 'insert' | 'delete'
  payload:        unknown      // the row / event to write
  localUpdatedAt: string       // device-local timestamp (authoritative for offline reviews)
}

// ── Everything a download writes into the local store ────────────────────────
export interface DownloadBundle {
  manifest:        Manifest
  cards:           Card[]
  cardStates:      StoredCardState[]
  ladderClimb:     StoredClimb[]
  ladders:         StoredLadder[]
  schedulerParams: StoredParam[]
  decks:           Deck[]
  folders:         Folder[]
  confusionLinks:  StoredLink[]
  overrides:       StoredOverride[]
  deckCards:       StoredDeckCard[]   // deck ↔ card membership (for per-deck reads offline)
}
