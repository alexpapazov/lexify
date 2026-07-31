/**
 * lib/mapLimit.ts — bounded-concurrency map with progress.
 *
 * Used wherever the client fans out network work over a list: pre-generating distractors for an
 * offline download, verifying an onboarding batch, formatting a long word list through the AI. Going
 * unbounded gets rate-limited (which degrades silently), and going strictly serial makes a
 * few-hundred-item job take minutes of pure round-trip latency.
 *
 * An item that throws resolves to `null` rather than rejecting the whole run — every caller here
 * would rather finish the other items and report the gap than lose the batch.
 */
export async function mapLimit<T, R>(
  items:  T[],
  limit:  number,
  fn:     (item: T, index: number) => Promise<R>,
  onDone?: (completed: number, total: number) => void,
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null)
  let next = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try { out[i] = await fn(items[i]!, i) } catch { out[i] = null }
      onDone?.(++done, items.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return out
}

/** Splits a list into consecutive chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)))
  return out
}
