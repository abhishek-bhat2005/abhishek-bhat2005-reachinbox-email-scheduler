import { Redis } from "ioredis";

export function createRedisClient(redisUrl: string, connectionName: string): Redis {
  return new Redis(redisUrl, {
    connectionName,
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
}

export type RedisClient = ReturnType<typeof createRedisClient>;
