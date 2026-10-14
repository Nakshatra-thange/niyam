import "dotenv/config";
import { Redis } from "ioredis";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export function createRedis() {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: null });
}