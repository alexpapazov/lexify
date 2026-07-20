/**
 * lib/supabasePaged.ts — page through a Supabase query that can exceed the server row cap.
 *
 * PostgREST enforces a `db-max-rows` ceiling (1000 by default on Supabase) that a client-side
 * `.limit(n)` does NOT override — it silently truncates instead of erroring. Any query that can
 * return more than a thousand rows (review_events or ladder_events over a multi-week window,
 * graduations over a month at a 50-cards/day goal) must page with `.range()` or it quietly analyses
 * only the newest sliver of the data.
 */

/** Supabase rows come back as loosely-typed records; callers cast to their own row shape. */
type PagedResult<T> = { data: T[] | null; error: unknown }

/**
 * Repeatedly runs `makeQuery(from, to)` in `page`-sized windows until a short page comes back
 * (or `max` is reached) and returns every row concatenated. `makeQuery` must apply `.range(from, to)`
 * — and should also apply a deterministic `.order(...)`, since paging an unordered query can repeat
 * or skip rows.
 */
export async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<PagedResult<T>>,
  { page = 1000, max = 60000 }: { page?: number; max?: number } = {},
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < max; from += page) {
    const { data, error } = await makeQuery(from, from + page - 1)
    if (error || !data || data.length === 0) break
    out.push(...data)
    if (data.length < page) break        // short page → that was the last one
  }
  return out
}
