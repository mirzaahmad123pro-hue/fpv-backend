// Tiny in-process TTL cache for public, read-mostly API responses.
//
// Why it exists: on a free-tier host the API sleeps when idle and every page
// used to fire several separate queries. Serving repeat reads from memory
// (and sharing one in-flight query between simultaneous visitors) keeps the
// storefront fast without changing any data. Any successful write request
// clears the whole cache (see server.js), so admin edits, new orders and stock
// changes show up immediately instead of waiting for the TTL.

const store = new Map();     // key -> { value, expires }
const inflight = new Map();  // key -> Promise (coalesces simultaneous misses)
const MAX_ENTRIES = 300;

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { store.delete(key); return undefined; }
  return hit.value;
}

function set(key, value, ttlMs) {
  if (store.size >= MAX_ENTRIES) {
    // Drop the oldest entry (Map preserves insertion order).
    store.delete(store.keys().next().value);
  }
  store.set(key, { value, expires: Date.now() + ttlMs });
}

// Returns the cached value for `key`, or runs `producer()` once (even if many
// requests arrive at the same moment) and caches what it returns.
async function wrap(key, ttlMs, producer) {
  const cached = get(key);
  if (cached !== undefined) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const value = await producer();
      set(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

function clear() {
  store.clear();
}

module.exports = { get, set, wrap, clear };
