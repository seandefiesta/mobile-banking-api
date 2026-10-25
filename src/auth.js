import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

/** Password hashing with scrypt and a per-user random salt. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// --- Minimal HS256 JWT (kept dependency-free on purpose) -------------------

const b64url = (input) => Buffer.from(input).toString('base64url');

export function signJwt(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

/** Returns the payload or throws if the token is malformed, forged or expired. */
export function verifyJwt(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, s] = parts;

  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'HS256') throw new Error('Unsupported algorithm');

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error('Bad signature');
  }

  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}
