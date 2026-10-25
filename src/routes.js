import { openapi, docsHtml } from './openapi.js';
import {
  parseRegister, parseLogin, parseAmount, parseDescription,
  parseAccountType, parseTransfer, parsePagination,
} from './validate.js';

// Turns "/api/accounts/12" param into an integer, or null so the service returns 404.
const toId = (value) => (/^\d+$/.test(value) ? Number(value) : null);

/**
 * Route table. `auth: true` requires a valid Bearer token.
 * `limited: true` applies the stricter rate limit (credential endpoints).
 */
export function buildRoutes(s) {
  return [
    { method: 'GET', path: '/openapi.json', handler: () => ({ status: 200, body: openapi }) },
    { method: 'GET', path: '/docs', handler: () => ({ status: 200, html: docsHtml }) },
    { method: 'GET', path: '/health', handler: () => ({ status: 200, body: { status: 'ok' } }) },

    {
      method: 'POST', path: '/api/auth/register', limited: true,
      handler: async ({ body }) => ({ status: 201, body: await s.register(parseRegister(body)) }),
    },
    {
      method: 'POST', path: '/api/auth/login', limited: true,
      handler: async ({ body }) => ({ status: 200, body: await s.login(parseLogin(body)) }),
    },

    {
      method: 'GET', path: '/api/me', auth: true,
      handler: ({ user }) => ({ status: 200, body: { user } }),
    },

    {
      method: 'GET', path: '/api/accounts', auth: true,
      handler: ({ user }) => ({ status: 200, body: { data: s.listAccounts(user.id) } }),
    },
    {
      method: 'POST', path: '/api/accounts', auth: true,
      handler: ({ user, body }) => ({
        status: 201,
        body: { account: s.createAccount(user.id, parseAccountType(body.type)) },
      }),
    },
    {
      method: 'GET', path: '/api/accounts/:id', auth: true,
      handler: ({ user, params }) => ({
        status: 200,
        body: { account: s.getAccount(user.id, toId(params.id)) },
      }),
    },
    {
      method: 'GET', path: '/api/accounts/:id/transactions', auth: true,
      handler: ({ user, params, query }) => ({
        status: 200,
        body: s.listTransactions(user.id, toId(params.id), parsePagination(query)),
      }),
    },
    {
      method: 'POST', path: '/api/accounts/:id/deposits', auth: true,
      handler: ({ user, params, body }) => ({
        status: 201,
        body: s.deposit(user.id, toId(params.id), parseAmount(body.amount), parseDescription(body.description)),
      }),
    },
    {
      method: 'POST', path: '/api/accounts/:id/withdrawals', auth: true,
      handler: ({ user, params, body }) => ({
        status: 201,
        body: s.withdraw(user.id, toId(params.id), parseAmount(body.amount), parseDescription(body.description)),
      }),
    },

    {
      method: 'POST', path: '/api/transfers', auth: true,
      handler: ({ user, body, headers }) => {
        const key = headers['idempotency-key'];
        if (key !== undefined && (typeof key !== 'string' || key.length < 8 || key.length > 100)) {
          return { status: 400, body: { error: { code: 'bad_request', message: 'Idempotency-Key must be 8-100 characters' } } };
        }
        const result = s.transfer(user.id, parseTransfer(body), key);
        const { replayed, ...payload } = result;
        return {
          status: replayed ? 200 : 201,
          body: payload,
          headers: replayed ? { 'Idempotent-Replayed': 'true' } : undefined,
        };
      },
    },
  ];
}
