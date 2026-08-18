import type { AppConfig } from "../config/env.js";
import type { RedisClient } from "../redis/client.js";

const hourMilliseconds = 60 * 60 * 1_000;

const reserveScript = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local nextAt = tonumber(redis.call('GET', KEYS[2]) or '0')
local hasReservation = redis.call('EXISTS', KEYS[3]) == 1
local now = tonumber(ARGV[1])
local hourEnd = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local minimumDelay = tonumber(ARGV[4])
local reservationTtl = tonumber(ARGV[5])

if nextAt > now then
  return {0, nextAt, hasReservation and 1 or 0}
end

if not hasReservation and count >= limit then
  local retryAt = hourEnd
  if nextAt > retryAt then retryAt = nextAt end
  return {0, retryAt, 0}
end

if not hasReservation then
  redis.call('SET', KEYS[3], tostring(now), 'PX', reservationTtl)
  count = redis.call('INCR', KEYS[1])
  redis.call('PEXPIREAT', KEYS[1], hourEnd + reservationTtl)
end

local admittedNextAt = now + minimumDelay
redis.call('SET', KEYS[2], tostring(admittedNextAt), 'PX', reservationTtl)
return {1, now, hasReservation and 1 or 0}
`;

const seedScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4])
end
if tonumber(ARGV[2]) > 0 and redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('SET', KEYS[2], tostring(tonumber(ARGV[2]) + tonumber(ARGV[3])), 'PX', ARGV[4])
end
return 1
`;

type RateLimitConfig = Pick<AppConfig, "BULLMQ_PREFIX" | "RATE_LIMIT_RESERVATION_TTL_MS">;

export interface SenderPolicy {
  senderId: string;
  hourlyLimit: number;
  minimumDelayMs: number;
}

export interface RateLimitDecision {
  admitted: boolean;
  nextAvailableAt: Date;
  existingReservation: boolean;
}

function hourWindow(now: Date): { start: number; end: number } {
  const start = Math.floor(now.getTime() / hourMilliseconds) * hourMilliseconds;
  return { start, end: start + hourMilliseconds };
}

function keys(prefix: string, senderId: string, emailId: string, hourStart: number) {
  const senderTag = `{${senderId}}`;
  const base = `${prefix}:email-rate:v1:${senderTag}`;
  return {
    count: `${base}:hour:${hourStart}`,
    next: `${base}:next`,
    reservation: `${base}:reservation:${emailId}`,
  };
}

function numberResult(value: unknown, index: number): number {
  if (!Array.isArray(value)) {
    throw new Error("Redis rate-limit script returned an invalid response");
  }
  const entry = value[index];
  const parsed = typeof entry === "number" ? entry : Number(entry);
  if (!Number.isFinite(parsed)) {
    throw new Error("Redis rate-limit script returned an invalid number");
  }
  return parsed;
}

export class SenderRateLimiter {
  constructor(
    private readonly redis: RedisClient,
    private readonly config: RateLimitConfig,
  ) {}

  async reserve(
    policy: SenderPolicy,
    scheduledEmailId: string,
    now = new Date(),
  ): Promise<RateLimitDecision> {
    const window = hourWindow(now);
    const rateKeys = keys(
      this.config.BULLMQ_PREFIX,
      policy.senderId,
      scheduledEmailId,
      window.start,
    );
    const result = await this.redis.eval(
      reserveScript,
      3,
      rateKeys.count,
      rateKeys.next,
      rateKeys.reservation,
      now.getTime(),
      window.end,
      policy.hourlyLimit,
      policy.minimumDelayMs,
      this.config.RATE_LIMIT_RESERVATION_TTL_MS,
    );

    return {
      admitted: numberResult(result, 0) === 1,
      nextAvailableAt: new Date(numberResult(result, 1)),
      existingReservation: numberResult(result, 2) === 1,
    };
  }

  async seed(
    policy: SenderPolicy,
    acceptedCount: number,
    lastAcceptedAt: Date | null,
    now = new Date(),
  ): Promise<void> {
    const window = hourWindow(now);
    const rateKeys = keys(this.config.BULLMQ_PREFIX, policy.senderId, "seed", window.start);
    const ttl = window.end - now.getTime() + this.config.RATE_LIMIT_RESERVATION_TTL_MS;

    await this.redis.eval(
      seedScript,
      2,
      rateKeys.count,
      rateKeys.next,
      acceptedCount,
      lastAcceptedAt?.getTime() ?? 0,
      policy.minimumDelayMs,
      ttl,
    );
  }
}

export function currentHourStart(now = new Date()): Date {
  return new Date(hourWindow(now).start);
}
