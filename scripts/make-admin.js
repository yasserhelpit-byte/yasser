// Usage: npm run make-admin -- someone@example.com        (grant admin)
//        npm run make-admin -- someone@example.com --remove
const { db } = require('../src/db');

const email = (process.argv[2] || '').trim().toLowerCase();
const remove = process.argv.includes('--remove');
if (!email) {
  console.error('Usage: npm run make-admin -- <email> [--remove]');
  process.exit(1);
}
const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No account with email ${email}. Sign up first, then run this again.`);
  process.exit(1);
}
db.prepare('UPDATE users SET role = ? WHERE id = ?').run(remove ? 'merchant' : 'admin', user.id);
console.log(remove ? `✓ ${user.name} (${email}) is no longer an admin.` : `✓ ${user.name} (${email}) is now an admin. Open /admin after logging in.`);
