import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './concurrency';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Later items resolve sooner, so completion order != input order.
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 2));
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return n;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  it('handles an empty array', async () => {
    expect(await mapWithConcurrency([], 8, async (x) => x)).toEqual([]);
  });

  it('propagates an error from any callback', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
