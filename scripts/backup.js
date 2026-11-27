// Usage: npm run backup            -> data/backups/yasser-YYYY-MM-DD_HH-MM.db (keeps the 14 newest)
// A consistent copy of the live database (safe while the server runs). Uploaded images are in data/uploads.
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
const file = path.join(dir, `yasser-${stamp}.db`);
fs.rmSync(file, { force: true });
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
const keep = 14;
const all = fs.readdirSync(dir).filter((f) => /^yasser-.*\.db$/.test(f)).sort();
for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, old));
console.log(`✓ Backup written: ${file} (${Math.round(fs.statSync(file).size / 1024)} KB). Keeping the ${keep} newest.`);
