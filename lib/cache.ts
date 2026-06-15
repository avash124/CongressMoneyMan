type RedisLike = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown, opts?: { ex?: number }) => Promise<unknown>
  incr: (key: string) => Promise<number>
  expire: (key: string, seconds: number) => Promise<unknown>
}

let clientPromise: Promise<RedisLike | null> | null = null

async function getClient(): Promise<RedisLike | null> {
  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    return null
  }

  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const pkg = "@upstash/redis"
        const mod = (await import(pkg)) as {
          Redis: new (cfg: { url: string; token: string }) => RedisLike
        }
        return new mod.Redis({
          url: process.env.UPSTASH_REDIS_REST_URL as string,
          token: process.env.UPSTASH_REDIS_REST_TOKEN as string,
        })
      } catch (error) {
        console.error("[cache] Failed to initialize Upstash Redis:", error)
        return null
      }
    })()
  }

  return clientPromise
}

export async function getCache<T>(key: string): Promise<T | null> {
  const client = await getClient()
  if (!client) return null

  try {
    const value = await client.get(key)
    // The Upstash client deserializes JSON values automatically.
    return (value as T | null) ?? null
  } catch (error) {
    console.error(`[cache] get failed for "${key}":`, error)
    return null
  }
}

export async function setCache<T>(
  key: string,
  value: T,
  ttlSeconds: number
): Promise<void> {
  const client = await getClient()
  if (!client) return

  try {
    await client.set(key, value, { ex: ttlSeconds })
  } catch (error) {
    console.error(`[cache] set failed for "${key}":`, error)
  }
}
export async function incrementCache(
  key: string,
  ttlSeconds: number
): Promise<number | null> {
  const client = await getClient()
  if (!client) return null

  try {
    const count = await client.incr(key)
    if (count === 1) await client.expire(key, ttlSeconds)
    return count
  } catch (error) {
    console.error(`[cache] incr failed for "${key}":`, error)
    return null
  }
}
