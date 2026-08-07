import { Injectable, Logger } from '@nestjs/common';

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

/**
 * Fast in-process key/value store for WS request correlation.
 * Avoids Redis round-trips on the ACK critical path.
 */
@Injectable()
export class PendingStore {
  private readonly logger = new Logger(PendingStore.name);
  private readonly map = new Map<string, MemoryEntry>();

  set(key: string, value: string, ttlSeconds = 120): void {
    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  get(key: string): string | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  del(key: string): void {
    this.map.delete(key);
  }

  /** Sliding-window rate limit in memory. Returns true if allowed. */
  checkRateLimit(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const bucketKey = `rl:${key}`;
    const raw = this.get(bucketKey);
    let stamps: number[] = [];
    if (raw) {
      try {
        stamps = JSON.parse(raw) as number[];
      } catch {
        stamps = [];
      }
    }
    stamps = stamps.filter((t) => now - t <= windowMs);
    stamps.push(now);
    this.set(bucketKey, JSON.stringify(stamps), Math.ceil(windowMs / 1000) + 1);
    const allowed = stamps.length <= max;
    if (!allowed) {
      this.logger.warn(`Rate limited ${key} (${stamps.length}/${max})`);
    }
    return allowed;
  }

  /** Returns false if nonce was already seen. */
  claimNonce(nonce: string, ttlSeconds = 120): boolean {
    const key = `nonce:${nonce}`;
    if (this.get(key)) return false;
    this.set(key, '1', ttlSeconds);
    return true;
  }
}
