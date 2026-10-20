const MAX_BODY = 16 * 1024;

export async function readJson(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body too large");
      error.code = "too_large";
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("Request body is not valid JSON");
    error.code = "bad_json";
    throw error;
  }
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(text);
}

/*
 * Only needed when the page is served from a different origin than this API.
 * Set ALLOWED_ORIGIN to that origin. Webhooks are server-to-server and must not
 * be sent through this.
 */
export function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN;
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

/* Returns true when the request has been answered and the caller should stop. */
export function handlePreflight(req, res) {
  if (req.method !== "OPTIONS") return false;
  res.writeHead(204, corsHeaders());
  res.end();
  return true;
}

export function methodNotAllowed(res, allow) {
  sendJson(res, 405, { error: "method_not_allowed" }, { Allow: allow.join(", ") });
}

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/*
 * Best effort. Serverless instances do not share memory, so this throttles a
 * single instance, not a determined attacker. It exists to stop an accidental
 * double submit or a trivial loop from creating a pile of bank fees.
 */
const buckets = new Map();

export function rateLimit(key, limit, windowMs) {
  const current = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || current > bucket.resetAt) {
    if (buckets.size > 5000) buckets.clear();
    buckets.set(key, { count: 1, resetAt: current + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - current) / 1000))
    };
  }
  return { allowed: true, remaining: limit - bucket.count };
}
