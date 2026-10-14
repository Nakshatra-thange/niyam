import type { Redis } from "ioredis";


export type BreakerOptions = { failureThreshold: number; windowMs: number; cooldownMs: number; probeTimeoutMs: number };

export type BreakerCheck = { allowed: true; isProbe: boolean } | { allowed: false; retryInMs: number };

export class CircuitBreaker {
  private opts: BreakerOptions;
  constructor(private redis: Redis, opts: Partial<BreakerOptions> = {}) {
    this.opts = { failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000, probeTimeoutMs: 15_000, ...opts };
  }

  private k = (lender: string, part: string) => `cb:${lender}:${part}`;

  async check(lender: string): Promise<BreakerCheck> {
    const openTtl = await this.redis.pttl(this.k(lender, "open"));
    if (openTtl > 0) return { allowed: false, retryInMs: openTtl };

    const tripped = await this.redis.exists(this.k(lender, "tripped"));
    if (!tripped) return { allowed: true, isProbe: false };

    // Half-open: whoever grabs the probe lock gets to test the lender.
    const gotProbe = await this.redis.set(this.k(lender, "probe"), "1", "PX", this.opts.probeTimeoutMs, "NX");
    return gotProbe ? { allowed: true, isProbe: true } : { allowed: false, retryInMs: 2_000 };
  }

  async recordSuccess(lender: string) {
    await this.redis.del(this.k(lender, "failures"), this.k(lender, "tripped"), this.k(lender, "probe"));
  }

  async recordFailure(lender: string, isProbe: boolean) {
    if (isProbe) return this.trip(lender);
    const failures = await this.redis.incr(this.k(lender, "failures"));
    if (failures === 1) await this.redis.pexpire(this.k(lender, "failures"), this.opts.windowMs);
    if (failures >= this.opts.failureThreshold) await this.trip(lender);
  }

  async state(lender: string): Promise<"closed" | "open" | "half_open"> {
    if ((await this.redis.pttl(this.k(lender, "open"))) > 0) return "open";
    return (await this.redis.exists(this.k(lender, "tripped"))) ? "half_open" : "closed";
  }

  private async trip(lender: string) {
    await this.redis
      .multi()
      .set(this.k(lender, "open"), "1", "PX", this.opts.cooldownMs)
      .set(this.k(lender, "tripped"), "1")
      .del(this.k(lender, "failures"), this.k(lender, "probe"))
      .exec();
  }
}