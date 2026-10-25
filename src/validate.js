import { validationError } from './errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_AMOUNT_CENTS = 100_000_000; // $1,000,000.00 per operation

export function parseRegister(body) {
  const errors = {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (name.length < 2 || name.length > 80) errors.name = 'Must be 2-80 characters';
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'Must be a valid email address';
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    errors.password = 'Must be 8-128 characters and include a letter and a number';
  }
  if (Object.keys(errors).length) throw validationError(errors);
  return { name, email, password };
}

export function parseLogin(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) throw validationError({ credentials: 'email and password are required' });
  return { email, password };
}

/** Accepts a number with at most 2 decimals and returns integer cents. */
export function parseAmount(value, field = 'amount') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw validationError({ [field]: 'Must be a positive number' });
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) {
    throw validationError({ [field]: 'Cannot have more than 2 decimal places' });
  }
  if (cents > MAX_AMOUNT_CENTS) {
    throw validationError({ [field]: 'Exceeds the maximum of 1,000,000.00 per operation' });
  }
  return cents;
}

export function parseDescription(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 140) {
    throw validationError({ description: 'Must be a string of at most 140 characters' });
  }
  return value.trim();
}

export function parseAccountType(value) {
  if (value !== 'checking' && value !== 'savings') {
    throw validationError({ type: "Must be 'checking' or 'savings'" });
  }
  return value;
}

export function parseTransfer(body) {
  const errors = {};
  const fromAccountId = Number.isInteger(body.fromAccountId) ? body.fromAccountId : null;
  const toAccountNumber = typeof body.toAccountNumber === 'string' ? body.toAccountNumber.trim() : '';
  if (fromAccountId === null) errors.fromAccountId = 'Must be an integer';
  if (!/^\d{10}$/.test(toAccountNumber)) errors.toAccountNumber = 'Must be a 10-digit account number';
  if (Object.keys(errors).length) throw validationError(errors);

  return {
    fromAccountId,
    toAccountNumber,
    cents: parseAmount(body.amount),
    description: parseDescription(body.description),
  };
}

export function parsePagination(query) {
  const limit = query.has('limit') ? Number(query.get('limit')) : 20;
  const offset = query.has('offset') ? Number(query.get('offset')) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw validationError({ limit: 'Must be an integer between 1 and 100' });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw validationError({ offset: 'Must be an integer >= 0' });
  }
  return { limit, offset };
}
