import { createClient, type RedisClientType } from "redis";
import { DEFAULT_REDIS_KEY_PREFIX } from "./relay.js";

/** Counters as observed after the request being decided was counted. */
export interface RateLimitObservation {
  perDay: number;
  perMinute: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  observed: RateLimitObservation;
  /**
   * Seconds until the request could be admitted: the latest of the windows it
   * is over, because a request cannot succeed until every offending window has
   * rolled over. Absent when the request was allowed.
   */
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  close: () => Promise<void>;
  /**
   * Counts one request against the organization's fixed windows and decides.
   *
   * The request is counted even when it is refused, so a caller that retries in
   * a tight loop stays over the limit instead of resetting its own counter.
   */
  consume: (input: {
    burstPerMinute: number;
    organizationId: string;
    requestsPerDay: number;
  }) => Promise<RateLimitDecision>;
  /**
   * The same decision keyed on an arbitrary caller-chosen key.
   *
   * Sign-in has no organization to count against: the request arrives before
   * the caller is anyone, so the identity endpoints key on what is known at that
   * moment — the requesting address, or the address being signed in. `consume`
   * is this with the organization as the key, so both share one implementation
   * and one window definition.
   */
  consumeKey: (input: {
    burstPerMinute: number;
    key: string;
    requestsPerDay: number;
  }) => Promise<RateLimitDecision>;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Increments both windows and gives each its remaining lifetime in one round
 * trip. A separate `INCR` and `EXPIRE` could leave a bucket with no TTL, which
 * would make it permanent and lock the organization out for good.
 */
const COUNT_REQUEST_SCRIPT = `
local minute = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
local day = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return {minute, day}
`;

const UNAVAILABLE =
  "Rate limiting is unavailable, so the request was refused rather than admitted uncounted.";

function readCounters(reply: unknown): RateLimitObservation {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new Error(UNAVAILABLE);
  }

  const perMinute = Number(reply[0]);
  const perDay = Number(reply[1]);
  if (!(Number.isFinite(perMinute) && Number.isFinite(perDay))) {
    throw new Error(UNAVAILABLE);
  }

  return { perDay, perMinute };
}

export function createRateLimiter(config: {
  keyPrefix?: string;
  url: string | undefined;
}): RateLimiter {
  const keyPrefix = config.keyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
  let client: RedisClientType | undefined;
  let connecting: Promise<unknown> | undefined;

  async function connected(): Promise<RedisClientType> {
    if (!config.url) {
      throw new Error(UNAVAILABLE);
    }

    if (!client) {
      const created = createClient({
        socket: {
          connectTimeout: CONNECT_TIMEOUT_MS,
          // Fail fast rather than queue behind a reconnect. The default backoff
          // keeps the command pending until Redis returns, and a limiter that
          // hangs cannot refuse a request, which is the only thing it is for.
          reconnectStrategy: false,
        },
        url: config.url,
      });
      // A transport error rejects the command that hit it, which `consume`
      // turns into a refusal; this listener only stops an unhandled 'error'
      // event from taking the process down.
      created.on("error", () => undefined);
      client = created;
    }

    if (!client.isReady) {
      // Cleared on settle, so a connection that failed is attempted again by
      // the next request instead of poisoning every later one.
      connecting ??= client.connect().finally(() => {
        connecting = undefined;
      });
      await connecting;
    }

    return client;
  }

  const consumeKey: RateLimiter["consumeKey"] = async (input) => {
    const now = Date.now();
    // Buckets are aligned to the UTC clock, so every replica counts a request
    // in the same window without coordinating.
    const minuteBucket = Math.floor(now / MINUTE_MS);
    const dayBucket = Math.floor(now / DAY_MS);
    const minuteTtl = Math.ceil((MINUTE_MS - (now % MINUTE_MS)) / 1000);
    const dayTtl = Math.ceil((DAY_MS - (now % DAY_MS)) / 1000);

    let reply: unknown;
    try {
      const active = await connected();
      reply = await active.eval(COUNT_REQUEST_SCRIPT, {
        arguments: [String(minuteTtl), String(dayTtl)],
        keys: [
          `${keyPrefix}:ratelimit:${input.key}:minute:${minuteBucket}`,
          `${keyPrefix}:ratelimit:${input.key}:day:${dayBucket}`,
        ],
      });
    } catch (error) {
      throw new Error(UNAVAILABLE, { cause: error });
    }

    const observation = readCounters(reply);

    const minuteOver = observation.perMinute > input.burstPerMinute;
    const dayOver = observation.perDay > input.requestsPerDay;
    if (!(minuteOver || dayOver)) {
      return { allowed: true, observed: observation };
    }

    return {
      allowed: false,
      observed: observation,
      retryAfterSeconds: Math.max(
        1,
        minuteOver ? minuteTtl : 0,
        dayOver ? dayTtl : 0
      ),
    };
  };

  return {
    close: async () => {
      if (client?.isOpen) {
        await client.quit();
      }
    },

    consume: async (input) =>
      await consumeKey({
        burstPerMinute: input.burstPerMinute,
        key: input.organizationId,
        requestsPerDay: input.requestsPerDay,
      }),

    consumeKey,
  };
}
