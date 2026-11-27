// Usage: npm run list-users
// Shows every account (to find the email you signed up with).
const { db } = require('../src/db');

const users = db.prepare(
  `SELECT u.id, u.name, u.email, u.role, u.created_at,
     (SELECT GROUP_CONCAT(s.name, ', ') FROM stores s WHERE s.owner_id = u.id) AS stores
   FROM users u ORDER BY u.id`
).all();
if (!users.length) {
  console.log('No accounts yet. Sign up on the website first.');
} else {
  console.log(`\n${users.length} account(s):\n`);
  for (const u of users) {
    console.log(`#${u.id}  ${u.email}  —  ${u.name}${u.role === 'admin' ? '  [ADMIN]' : ''}`);
    console.log(`     created ${u.created_at}${u.stores ? `  ·  stores: ${u.stores}` : ''}\n`);
  }
}
