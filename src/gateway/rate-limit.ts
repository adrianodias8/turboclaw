export interface RateLimiter {
  check(ip: string): boolean; // returns true if allowed
  cleanup(): void;
}

export function createRateLimiter(maxRequests: number = 120, windowMs: number = 60000): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    check(ip: string): boolean {
      const now = Date.now();
      const bucket = buckets.get(ip);
      if (!bucket || now >= bucket.resetAt) {
        buckets.set(ip, { count: 1, resetAt: now + windowMs });
        return true;
      }
      bucket.count++;
      return bucket.count <= maxRequests;
    },
    cleanup() {
      const now = Date.now();
      for (const [ip, bucket] of buckets) {
        if (now >= bucket.resetAt) buckets.delete(ip);
      }
    },
  };
}
