/** 令牌桶：每个连接一个，限制消息频率 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** 固定窗口计数：按 key（通常是 IP）限制建房、查房等低频操作 */
export class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now: number): boolean {
    let e = this.hits.get(key);
    if (!e || now >= e.resetAt) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    if (this.hits.size > 10_000) this.sweep(now);
    return e.count <= this.limit;
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
  }
}
