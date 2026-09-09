/**
 * Map `items` through an async `fn` with at most `concurrency` calls in flight,
 * returning results in INPUT order (not completion order). Pure control-flow —
 * no I/O, no clock — so it's safe to unit-test and share. A rejected `fn`
 * rejects the whole map (via Promise.all), matching a sequential loop's throw.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
