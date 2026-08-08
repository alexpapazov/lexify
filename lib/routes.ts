/**
 * lib/routes.ts — central URL builder for the app's data-driven screens.
 *
 * These routes use QUERY PARAMS (e.g. /study/deck?deck=<id>) rather than dynamic path segments
 * (/study/[deckId]). That's deliberate: it lets the app run BOTH server-rendered on Vercel AND as a
 * fully static export bundled into the native (Capacitor) app. Static export can't client-navigate to
 * arbitrary dynamic-segment ids, but query-param routes are a single static page that reads the id at
 * runtime — so navigation works identically online and offline-in-app.
 *
 * Always build these URLs via `routes.*` (never hand-write the path) so the scheme stays in one place.
 */
type QueryValue = string | number | undefined | null
type Query = Record<string, QueryValue>

function withQuery(base: string, q: Query): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v != null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `${base}?${s}` : base
}

export const routes = {
  /** Deck detail. */
  deck:          (deckId: string, extra: Query = {}) => withQuery('/study/deck',         { deck: deckId,   ...extra }),
  /** Due-now / category study session for a deck. */
  deckSession:   (deckId: string, extra: Query = {}) => withQuery('/study/deck/session', { deck: deckId,   ...extra }),
  /** AI card generation for a deck. */
  deckAdd:       (deckId: string, extra: Query = {}) => withQuery('/study/deck/add',     { deck: deckId,   ...extra }),
  /** Bulk card editor for a deck. */
  deckEdit:      (deckId: string, extra: Query = {}) => withQuery('/study/deck/edit',    { deck: deckId,   ...extra }),
  /** Confidence-rating screen for a deck's onboarding queue. */
  deckOnboard:   (deckId: string, extra: Query = {}) => withQuery('/study/deck/onboard', { deck: deckId,   ...extra }),
  /** Confidence-rating screen across a folder's decks (same page, folder scope). */
  folderOnboard: (folderId: string, extra: Query = {}) => withQuery('/study/deck/onboard', { folder: folderId, ...extra }),
  /** Study session across a folder. */
  folderSession: (folderId: string, extra: Query = {}) => withQuery('/study/folder/session', { folder: folderId, ...extra }),
  /** Learning ladder scoped to a deck. */
  ladderDeck:    (deckId: string, extra: Query = {}) => withQuery('/study/ladder/deck',   { deck: deckId,   ...extra }),
  /** Learning ladder scoped to a folder. */
  ladderFolder:  (folderId: string, extra: Query = {}) => withQuery('/study/ladder/folder', { folder: folderId, ...extra }),
  /** Practice Mode (exercise generation from your own vocabulary). */
  practice:      (extra: Query = {}) => withQuery('/practice', { ...extra }),
  /** A folder's contents in the library. */
  library:       (folderId: string, extra: Query = {}) => withQuery('/library/folder',   { folder: folderId, ...extra }),
  /** An agent change-set review. */
  agentsReview:  (changeSetId: string, extra: Query = {}) => withQuery('/agents/review', { cs: changeSetId, ...extra }),
}
