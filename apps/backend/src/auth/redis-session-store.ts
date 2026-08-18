import session, { type SessionData } from "express-session";
import { z } from "zod";

import type { RedisClient } from "../redis/client.js";

const storedSessionSchema = z.object({ cookie: z.record(z.string(), z.unknown()) }).passthrough();

export class RedisSessionStore extends session.Store {
  public constructor(
    private readonly redis: RedisClient,
    private readonly keyPrefix: string,
    private readonly defaultTtlMs: number,
  ) {
    super();
  }

  public override get(
    sessionId: string,
    callback: (error: unknown, session?: SessionData | null) => void,
  ): void {
    void this.redis
      .get(this.key(sessionId))
      .then((stored) => {
        if (stored === null) {
          callback(null, null);
          return;
        }

        const parsed: unknown = JSON.parse(stored);
        const validated = storedSessionSchema.parse(parsed);
        // Express-session restores Cookie behavior after loading plain JSON from a store.
        callback(null, validated as unknown as SessionData);
      })
      .catch((error: unknown) => callback(error));
  }

  public override set(
    sessionId: string,
    sessionData: SessionData,
    callback?: (error?: unknown) => void,
  ): void {
    const ttlMs = sessionData.cookie.expires
      ? Math.max(sessionData.cookie.expires.getTime() - Date.now(), 1)
      : this.defaultTtlMs;

    void this.redis
      .psetex(this.key(sessionId), ttlMs, JSON.stringify(sessionData))
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  public override destroy(sessionId: string, callback?: (error?: unknown) => void): void {
    void this.redis
      .del(this.key(sessionId))
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  public override touch(
    sessionId: string,
    sessionData: SessionData,
    callback?: (error?: unknown) => void,
  ): void {
    const ttlMs = sessionData.cookie.expires
      ? Math.max(sessionData.cookie.expires.getTime() - Date.now(), 1)
      : this.defaultTtlMs;

    void this.redis
      .pexpire(this.key(sessionId), ttlMs)
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  private key(sessionId: string): string {
    return `${this.keyPrefix}${sessionId}`;
  }
}
