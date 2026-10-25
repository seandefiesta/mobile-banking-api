import { HttpError, unauthorized } from './errors.js';
import { verifyJwt } from './auth.js';
import { createServices } from './services.js';
import { buildRoutes } from './routes.js';

const MAX_BODY_BYTES = 100 * 1024;

function compileRoutes(routes) {
  return routes.map((route) => {
    const names = [];
    const pattern = route.path.replace(/:([a-zA-Z]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    return { ...route, regex: new RegExp(`^${pattern}$`), names };
  });
}

/** Tiny fixed-window rate limiter keyed by client IP (in-memory, fine for a single process). */
function createRateLimiter({ max, windowMs }) {
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return 0;
    }
    entry.count += 1;
    return entry.count > max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object');
  }
  return parsed;
}

function send(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'X-Content-Type-Options': 'nosniff',
    // Only the docs page may load scripts/styles, and only from cdnjs.
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; " +
      "style-src https://cdnjs.cloudflare.com 'unsafe-inline'; img-src 'self' data: https:; " +
      "connect-src 'self'; font-src https://cdnjs.cloudflare.com",
  });
  res.end(html);
}

export function createApp({
  db,
  jwtSecret,
  jwtTtlSeconds = 3600,
  rateLimit = { max: 10, windowMs: 60_000 },
  logger = console,
}) {
  const services = createServices(db, { jwtSecret, jwtTtlSeconds });
  const routes = compileRoutes(buildRoutes(services));
  const limiter = createRateLimiter(rateLimit);

  function authenticate(req) {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();
    let payload;
    try {
      payload = verifyJwt(token, jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    const user = services.getUser(payload.sub);
    if (!user) throw unauthorized('Invalid or expired token');
    return user;
  }

  return async function handler(req, res) {
    const started = Date.now();
    let status = 500;
    try {
      const url = new URL(req.url, 'http://localhost');
      let matched = null;
      let pathExists = false;

      for (const route of routes) {
        const m = route.regex.exec(url.pathname);
        if (!m) continue;
        pathExists = true;
        if (route.method !== req.method) continue;
        matched = { route, params: Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
        break;
      }

      if (!matched) {
        throw pathExists
          ? new HttpError(405, 'method_not_allowed', 'Method not allowed')
          : new HttpError(404, 'not_found', 'Route not found');
      }

      const { route, params } = matched;

      if (route.limited) {
        const retryAfter = limiter(req.socket.remoteAddress ?? 'unknown');
        if (retryAfter) {
          const err = new HttpError(429, 'rate_limited', 'Too many attempts, please try again later');
          err.headers = { 'Retry-After': String(retryAfter) };
          throw err;
        }
      }

      const user = route.auth ? authenticate(req) : null;
      const body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : {};

      const result = await route.handler({ user, params, query: url.searchParams, body, headers: req.headers });
      status = result.status;
      if (result.html) sendHtml(res, status, result.html);
      else send(res, status, result.body, result.headers);
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        send(res, status, { error: { code: err.code, message: err.message, details: err.details } }, err.headers);
      } else {
        logger.error?.(err);
        status = 500;
        send(res, 500, { error: { code: 'internal_error', message: 'Something went wrong' } });
      }
    } finally {
      logger.info?.(`${req.method} ${req.url} -> ${status} (${Date.now() - started}ms)`);
    }
  };
}
