// OpenAPI 3.0 description of the API. Served at /openapi.json and rendered by Swagger UI at /docs.

const err = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});
const secured = [{ bearerAuth: [] }];
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 };
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const ok = (description, ref) => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Mobile Banking API',
    version: '1.0.0',
    description:
      'Portfolio project: a local REST API for a mobile banking app.\n\n' +
      '**How to try it:** call `POST /api/auth/login`, copy the `accessToken`, click **Authorize** ' +
      'and paste the token. Then every locked endpoint works. Demo users (after `npm run seed`): ' +
      '`alice@example.com` / `Password123`.',
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [{ name: 'Auth' }, { name: 'Accounts' }, { name: 'Money' }],
  paths: {
    '/api/auth/register': {
      post: {
        tags: ['Auth'], summary: 'Create a customer and a starter checking account',
        requestBody: json({ $ref: '#/components/schemas/RegisterRequest' }),
        responses: { 201: ok('Created', 'RegisterResponse'), 409: err('Email already registered'), 422: err('Validation failed'), 429: err('Rate limited') },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Log in and receive an access token',
        requestBody: json({ $ref: '#/components/schemas/LoginRequest' }),
        responses: { 200: ok('Logged in', 'LoginResponse'), 401: err('Invalid email or password'), 429: err('Rate limited') },
      },
    },
    '/api/me': {
      get: {
        tags: ['Auth'], summary: 'Current user', security: secured,
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } } } } }, 401: err('Not authenticated') },
      },
    },
    '/api/accounts': {
      get: {
        tags: ['Accounts'], summary: 'List my accounts', security: secured,
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Account' } } } } } } }, 401: err('Not authenticated') },
      },
      post: {
        tags: ['Accounts'], summary: 'Open a new account', security: secured,
        requestBody: json({ type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['checking', 'savings'] } } }),
        responses: { 201: { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { account: { $ref: '#/components/schemas/Account' } } } } } }, 422: err('Validation failed') },
      },
    },
    '/api/accounts/{id}': {
      get: {
        tags: ['Accounts'], summary: 'Account details and balance', security: secured, parameters: [idParam],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { account: { $ref: '#/components/schemas/Account' } } } } } }, 404: err('Not found') },
      },
    },
    '/api/accounts/{id}/transactions': {
      get: {
        tags: ['Accounts'], summary: 'Transaction history (newest first)', security: secured,
        parameters: [
          idParam,
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: { 200: ok('OK', 'TransactionList'), 404: err('Not found'), 422: err('Bad pagination') },
      },
    },
    '/api/accounts/{id}/deposits': {
      post: {
        tags: ['Money'], summary: 'Deposit money', security: secured, parameters: [idParam],
        requestBody: json({ $ref: '#/components/schemas/AmountRequest' }),
        responses: { 201: ok('Deposited', 'MoneyResult'), 404: err('Not found'), 422: err('Validation failed') },
      },
    },
    '/api/accounts/{id}/withdrawals': {
      post: {
        tags: ['Money'], summary: 'Withdraw money', security: secured, parameters: [idParam],
        requestBody: json({ $ref: '#/components/schemas/AmountRequest' }),
        responses: { 201: ok('Withdrawn', 'MoneyResult'), 404: err('Not found'), 422: err('Validation failed or insufficient funds') },
      },
    },
    '/api/transfers': {
      post: {
        tags: ['Money'], summary: 'Transfer to another account', security: secured,
        description: 'Send an `Idempotency-Key` header to make retries safe: repeating the same request returns the original result (200) instead of moving money twice.',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 100 }, example: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }],
        requestBody: json({ $ref: '#/components/schemas/TransferRequest' }),
        responses: { 200: ok('Replay of an earlier identical request', 'TransferResult'), 201: ok('Transferred', 'TransferResult'), 404: err('Account not found'), 422: err('Validation failed or insufficient funds') },
      },
    },
    '/health': {
      get: { summary: 'Liveness check', responses: { 200: { description: 'OK' } } },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string', example: 'insufficient_funds' }, message: { type: 'string' }, details: { type: 'object', nullable: true } } } } },
      User: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } } },
      Account: { type: 'object', properties: { id: { type: 'integer' }, accountNumber: { type: 'string', example: '7403853807' }, type: { type: 'string', enum: ['checking', 'savings'] }, balance: { type: 'number', example: 4874.5 }, currency: { type: 'string', example: 'USD' }, createdAt: { type: 'string', format: 'date-time' } } },
      Transaction: { type: 'object', properties: { id: { type: 'integer' }, accountId: { type: 'integer' }, type: { type: 'string', enum: ['deposit', 'withdrawal', 'transfer_in', 'transfer_out'] }, amount: { type: 'number' }, balanceAfter: { type: 'number' }, description: { type: 'string', nullable: true }, counterpartyAccountNumber: { type: 'string', nullable: true }, reference: { type: 'string', format: 'uuid' }, createdAt: { type: 'string', format: 'date-time' } } },
      RegisterRequest: { type: 'object', required: ['name', 'email', 'password'], properties: { name: { type: 'string', example: 'Carla Lim' }, email: { type: 'string', example: 'carla@example.com' }, password: { type: 'string', example: 'Password123', description: '8+ chars with a letter and a number' } } },
      RegisterResponse: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' }, account: { $ref: '#/components/schemas/Account' } } },
      LoginRequest: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', example: 'alice@example.com' }, password: { type: 'string', example: 'Password123' } } },
      LoginResponse: { type: 'object', properties: { accessToken: { type: 'string' }, tokenType: { type: 'string', example: 'Bearer' }, expiresIn: { type: 'integer', example: 3600 }, user: { $ref: '#/components/schemas/User' } } },
      AmountRequest: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', example: 250.75, description: 'Positive, max 2 decimals, up to 1,000,000' }, description: { type: 'string', maxLength: 140, example: 'Salary' } } },
      MoneyResult: { type: 'object', properties: { transaction: { $ref: '#/components/schemas/Transaction' }, account: { $ref: '#/components/schemas/Account' } } },
      TransferRequest: { type: 'object', required: ['fromAccountId', 'toAccountNumber', 'amount'], properties: { fromAccountId: { type: 'integer', example: 1 }, toAccountNumber: { type: 'string', example: '7309809527', description: '10-digit account number' }, amount: { type: 'number', example: 100 }, description: { type: 'string', example: 'Rent share' } } },
      TransferResult: { type: 'object', properties: { reference: { type: 'string', format: 'uuid' }, transaction: { $ref: '#/components/schemas/Transaction' }, account: { $ref: '#/components/schemas/Account' } } },
      TransactionList: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } }, pagination: { type: 'object', properties: { limit: { type: 'integer' }, offset: { type: 'integer' }, total: { type: 'integer' } } } } },
    },
  },
};

// Swagger UI loaded from the cdnjs CDN (needs internet in your browser, nothing to install).
const SWAGGER_VERSION = '5.17.14';
export const docsHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Mobile Banking API - Docs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_VERSION}/swagger-ui.min.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_VERSION}/swagger-ui-bundle.min.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', persistAuthorization: true });
  </script>
</body>
</html>`;
