// Simple in-memory sliding-window rate limiter.
// Good enough for a single server process; resets when the server restarts.
const buckets = new Map();

function hit(key, limit, windowMs) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  buckets.set(key, list);
  return list.length <= limit;
}

function count(key, windowMs) {
  const now = Date.now();
  return (buckets.get(key) || []).filter((t) => now - t < windowMs).length;
}

function reset(key) {
  buckets.delete(key);
}

// Minutes until the oldest attempt in the window expires.
function retryAfterMin(key, windowMs) {
  const list = buckets.get(key) || [];
  if (!list.length) return 0;
  return Math.max(1, Math.ceil((list[0] + windowMs - Date.now()) / 60000));
}

// Periodically drop empty buckets so memory doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of buckets) if (!list.some((t) => now - t < 24 * 3600 * 1000)) buckets.delete(k);
}, 10 * 60 * 1000).unref();

// Clear everything (used by tests).
function clear() {
  buckets.clear();
}

module.exports = { hit, count, reset, retryAfterMin, clear };
