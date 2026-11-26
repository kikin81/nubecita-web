/** Decides whether one more request from `key` is allowed right now. */
export type RateLimit = (key: string) => boolean;

/**
 * A fixed-window counter held in memory. It is per instance, so it bounds a
 * burst rather than enforcing an exact global figure; the cap on instances
 * bounds the rest.
 */
export function createRateLimit(limit: number, windowMs: number, now: () => number, maxKeys = 10_000): RateLimit {
  const windows = new Map<string, {start: number; count: number}>();

  return (key) => {
    const time = now();
    const window = windows.get(key);
    if (window === undefined || time - window.start >= windowMs) {
      if (windows.size >= maxKeys) {
        for (const [candidate, value] of windows) {
          if (time - value.start >= windowMs) windows.delete(candidate);
        }
        // Still full of live windows: start over rather than grow without bound.
        if (windows.size >= maxKeys) windows.clear();
      }
      windows.set(key, {start: time, count: 1});
      return true;
    }
    window.count += 1;
    return window.count <= limit;
  };
}
