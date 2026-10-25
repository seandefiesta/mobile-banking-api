// Populates the local database with two demo customers so you can try the API immediately.
//   npm run seed
import { openDb } from '../src/db.js';
import { createServices } from '../src/services.js';

const db = openDb(process.env.DB_PATH ?? './data/bank.db');
const s = createServices(db, { jwtSecret: 'seed-only', jwtTtlSeconds: 60 });

const demo = [
  { name: 'Alice Santos', email: 'alice@example.com', password: 'Password123' },
  { name: 'Bob Reyes', email: 'bob@example.com', password: 'Password123' },
];

for (const u of demo) {
  try {
    const { user, account } = await s.register(u);
    s.deposit(user.id, account.id, 500_000, 'Initial deposit');
    s.withdraw(user.id, account.id, 12_550, 'Groceries');
    console.log(`Created ${u.email} (account ${account.accountNumber})`);
  } catch (err) {
    console.log(`Skipped ${u.email}: ${err.message}`);
  }
}
console.log('\nLog in with any seeded email and the password "Password123".');
db.close();
