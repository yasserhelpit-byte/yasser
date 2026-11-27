// Usage: npm run set-password -- someone@example.com "new password"
// Sets a new password directly (useful when email sending isn't configured yet).
const { db } = require('../src/db');
const auth = require('../src/auth');

const email = (process.argv[2] || '').trim().toLowerCase();
const password = process.argv[3] || '';
if (!email || !password) {
  console.error('Usage: npm run set-password -- <email> <new password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('The password must be at least 8 characters.');
  process.exit(1);
}
const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No account with email ${email}. Run "npm run list-users" to see all accounts.`);
  process.exit(1);
}
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), user.id);
auth.logoutEverywhere(user.id);
console.log(`✓ Password updated for ${user.name} (${email}). You can log in now.`);
