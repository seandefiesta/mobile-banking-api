import { randomInt, randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { hashPassword, verifyPassword, signJwt } from './auth.js';
import { HttpError, notFound } from './errors.js';

const CURRENCY = 'USD';

// --- Row -> API shape mappers ----------------------------------------------

const toUser = (row) => ({ id: row.id, name: row.name, email: row.email, createdAt: row.created_at });

const toAccount = (row) => ({
  id: row.id,
  accountNumber: row.account_number,
  type: row.type,
  balance: row.balance_cents / 100,
  currency: CURRENCY,
  createdAt: row.created_at,
});

const toTransaction = (row) => ({
  id: row.id,
  accountId: row.account_id,
  type: row.type,
  amount: row.amount_cents / 100,
  balanceAfter: row.balance_after_cents / 100,
  description: row.description,
  counterpartyAccountNumber: row.counterparty_account_number,
  reference: row.reference,
  createdAt: row.created_at,
});

export function createServices(db, { jwtSecret, jwtTtlSeconds }) {
  const tx = (fn) => withTransaction(db, fn);

  // Used to burn the same CPU time when an email doesn't exist,
  // so response timing doesn't reveal which emails are registered.
  let dummyHash;

  function generateAccountNumber() {
    for (let i = 0; i < 10; i++) {
      const candidate = String(randomInt(1_000_000_000, 10_000_000_000));
      if (!db.prepare('SELECT 1 FROM accounts WHERE account_number = ?').get(candidate)) return candidate;
    }
    throw new Error('Could not generate a unique account number');
  }

  function insertAccount(userId, type) {
    return db
      .prepare('INSERT INTO accounts (user_id, account_number, type) VALUES (?, ?, ?) RETURNING *')
      .get(userId, generateAccountNumber(), type);
  }

  function getOwnedAccount(userId, accountId) {
    const row = accountId == null
      ? undefined
      : db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(accountId, userId);
    // 404 (not 403) so we never reveal that someone else's account exists.
    if (!row) throw notFound('Account not found');
    return row;
  }

  function recordTransaction({ accountId, type, cents, balanceAfter, description, counterparty, reference }) {
    return db
      .prepare(
        `INSERT INTO transactions
           (account_id, type, amount_cents, balance_after_cents, description, counterparty_account_number, reference)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .get(accountId, type, cents, balanceAfter, description, counterparty, reference);
  }

  function setBalance(accountId, cents) {
    db.prepare('UPDATE accounts SET balance_cents = ? WHERE id = ?').run(cents, accountId);
  }

  // --- Auth ------------------------------------------------------------------

  async function register({ name, email, password }) {
    const passwordHash = await hashPassword(password);
    try {
      return tx(() => {
        const user = db
          .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?) RETURNING *')
          .get(name, email, passwordHash);
        const account = insertAccount(user.id, 'checking'); // every customer starts with a checking account
        return { user: toUser(user), account: toAccount(account) };
      });
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) {
        throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      }
      throw err;
    }
  }

  async function login({ email, password }) {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    dummyHash ??= await hashPassword('dummy-password-for-timing');
    const ok = await verifyPassword(password, user ? user.password_hash : dummyHash);
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');

    return {
      accessToken: signJwt({ sub: user.id }, jwtSecret, jwtTtlSeconds),
      tokenType: 'Bearer',
      expiresIn: jwtTtlSeconds,
      user: toUser(user),
    };
  }

  const getUser = (id) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? toUser(row) : null;
  };

  // --- Accounts --------------------------------------------------------------

  const listAccounts = (userId) =>
    db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY id').all(userId).map(toAccount);

  const getAccount = (userId, accountId) => toAccount(getOwnedAccount(userId, accountId));

  const createAccount = (userId, type) => toAccount(insertAccount(userId, type));

  // --- Money movement --------------------------------------------------------

  function deposit(userId, accountId, cents, description) {
    return tx(() => {
      const account = getOwnedAccount(userId, accountId);
      const newBalance = account.balance_cents + cents;
      setBalance(account.id, newBalance);
      const row = recordTransaction({
        accountId: account.id, type: 'deposit', cents, balanceAfter: newBalance,
        description, counterparty: null, reference: randomUUID(),
      });
      return {
        transaction: toTransaction(row),
        account: toAccount({ ...account, balance_cents: newBalance }),
      };
    });
  }

  function withdraw(userId, accountId, cents, description) {
    return tx(() => {
      const account = getOwnedAccount(userId, accountId);
      if (account.balance_cents < cents) {
        throw new HttpError(422, 'insufficient_funds', 'Insufficient funds');
      }
      const newBalance = account.balance_cents - cents;
      setBalance(account.id, newBalance);
      const row = recordTransaction({
        accountId: account.id, type: 'withdrawal', cents, balanceAfter: newBalance,
        description, counterparty: null, reference: randomUUID(),
      });
      return {
        transaction: toTransaction(row),
        account: toAccount({ ...account, balance_cents: newBalance }),
      };
    });
  }

  /**
   * Moves money between two accounts atomically. If anything fails, nothing is written.
   * An optional Idempotency-Key makes retries safe: the same key + same request returns
   * the original result instead of moving money twice.
   */
  function transfer(userId, { fromAccountId, toAccountNumber, cents, description }, idempotencyKey) {
    const requestHash = JSON.stringify({ fromAccountId, toAccountNumber, cents, description });

    return tx(() => {
      if (idempotencyKey) {
        const prior = db
          .prepare('SELECT request_hash, response_json FROM idempotency_keys WHERE key = ? AND user_id = ?')
          .get(idempotencyKey, userId);
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw new HttpError(422, 'idempotency_key_reuse', 'This Idempotency-Key was used with a different request');
          }
          return { ...JSON.parse(prior.response_json), replayed: true };
        }
      }

      const from = getOwnedAccount(userId, fromAccountId);
      const to = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(toAccountNumber);
      if (!to) throw notFound('Destination account not found');
      if (to.id === from.id) throw new HttpError(422, 'same_account', 'Cannot transfer to the same account');
      if (from.balance_cents < cents) throw new HttpError(422, 'insufficient_funds', 'Insufficient funds');

      const fromBalance = from.balance_cents - cents;
      const toBalance = to.balance_cents + cents;
      setBalance(from.id, fromBalance);
      setBalance(to.id, toBalance);

      const reference = randomUUID();
      const outRow = recordTransaction({
        accountId: from.id, type: 'transfer_out', cents, balanceAfter: fromBalance,
        description, counterparty: to.account_number, reference,
      });
      recordTransaction({
        accountId: to.id, type: 'transfer_in', cents, balanceAfter: toBalance,
        description, counterparty: from.account_number, reference,
      });

      const result = {
        reference,
        transaction: toTransaction(outRow),
        account: toAccount({ ...from, balance_cents: fromBalance }),
      };

      if (idempotencyKey) {
        db.prepare('INSERT INTO idempotency_keys (key, user_id, request_hash, response_json) VALUES (?, ?, ?, ?)')
          .run(idempotencyKey, userId, requestHash, JSON.stringify(result));
      }
      return result;
    });
  }

  function listTransactions(userId, accountId, { limit, offset }) {
    const account = getOwnedAccount(userId, accountId);
    const rows = db
      .prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(account.id, limit, offset);
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM transactions WHERE account_id = ?').get(account.id);
    return { data: rows.map(toTransaction), pagination: { limit, offset, total } };
  }

  return {
    register, login, getUser,
    listAccounts, getAccount, createAccount,
    deposit, withdraw, transfer, listTransactions,
  };
}
