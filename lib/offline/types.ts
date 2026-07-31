/**
 * lib/offline/types.ts — shapes for the offline local store: the download bundle written into it,
 * the outbox of local changes to push on reconnect, and the manifest describing what was downloaded.
 */
import type { Card, CardState, Deck, Folder } from '@/domain'

// ── Scope of a download ──────────────────────────────────────────────────────
type OfflineScopeKind = 'deck' | 'folder' | 'language' | 'library'
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
  // Opt-ins that widen the default selection. By default a download carries only what you can actually
  // study — learnable cards plus graduated ones due inside the window — so a deck that's entirely
  // graduated-and-not-due-soon bundles nothing. These let you take the rest anyway (e.g. before a trip,
  // or to browse/edit the full library offline) at the cost of a much larger bundle.
  includeGraduated?: boolean  // ALL graduated cards, regardless of due date
  includeDormant?:   boolean  // dormant cards, which are never due by definition
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
/** Per-deck study settings (new/day, batch size, spillover, audio speed/volume, elective cap). Without
 *  these offline the deck page reads "0 new/day" and the ladder silently falls back to defaults. */
export interface StoredDeckPreference { key: string; deckId: string; prefs: unknown }

// ── Outbox: local changes queued for the next online sync ────────────────────
export type OutboxEntity =
  | 'cardState' | 'ladderClimb' | 'ladderEvent' | 'reviewEvent' | 'override' | 'card' | 'cardCreate'
  | 'deckCreate' | 'folderCreate' | 'deckCardLink' | 'ladderSave' | 'ladderReset'
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
  /** Optional: bundles downloaded before deck settings were included simply won't have it. */
  deckPreferences?: StoredDeckPreference[]
}
