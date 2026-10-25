import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? './data/bank.db';
const JWT_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS ?? 3600);

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === 'change-me') {
  jwtSecret = randomBytes(48).toString('hex');
  console.warn('[warn] JWT_SECRET not set - using a random one. Tokens will be invalid after a restart.');
}

const db = openDb(DB_PATH);
const app = createApp({ db, jwtSecret, jwtTtlSeconds: JWT_TTL_SECONDS });
const server = http.createServer(app);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mobile Banking API listening on http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nShutting down...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
