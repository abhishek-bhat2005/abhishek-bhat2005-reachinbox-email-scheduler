import { Redis } from "ioredis";

export function createRedisClient(redisUrl: string, connectionName: string): Redis {
  return new Redis(redisUrl, {
    connectionName,
    enableReadyCheck: true,
    family: 0,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
}

export type RedisClient = ReturnType<typeof createRedisClient>;
