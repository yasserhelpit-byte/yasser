// Periodic housekeeping: old sessions and uploaded images that nothing references any more.
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { uploadsDir } = require('./uploads');
const auth = require('./auth');

const FILE_RE = /[a-f0-9]{32}\.(?:webp|jpg|png|gif)/g;

// Every upload filename referenced anywhere in the database.
function referencedUploads() {
  const found = new Set();
  const scan = (text) => { for (const m of String(text || '').match(FILE_RE) || []) found.add(m); };
  for (const r of db.prepare('SELECT images, image_url FROM products').all()) { scan(r.images); scan(r.image_url); }
  for (const r of db.prepare('SELECT logo_url, banner_url, home_sections FROM stores').all()) { scan(r.logo_url); scan(r.banner_url); scan(r.home_sections); }
  for (const r of db.prepare('SELECT sections FROM pages').all()) scan(r.sections);
  return found;
}

// Delete unreferenced uploads older than minAgeMs (the grace period covers forms still being filled in).
function cleanupUploads({ minAgeMs = 24 * 3600 * 1000, dryRun = false } = {}) {
  const used = referencedUploads();
  let removed = 0, bytes = 0;
  for (const name of fs.readdirSync(uploadsDir)) {
    if (!/^[a-f0-9]{32}\.(webp|jpg|png|gif)$/.test(name) || used.has(name)) continue;
    const file = path.join(uploadsDir, name);
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < minAgeMs) continue;
    removed++; bytes += st.size;
    if (!dryRun) fs.unlinkSync(file);
  }
  return { removed, bytes };
}

function runMaintenance() {
  try {
    const sessions = auth.cleanupSessions();
    const files = cleanupUploads();
    if (sessions || files.removed) console.log(`🧹 maintenance: ${sessions} old sessions, ${files.removed} unused images (${Math.round(files.bytes / 1024)} KB) removed`);
  } catch (err) {
    console.error('Maintenance failed:', err.message);
  }
}

// First run a minute after start, then every 6 hours.
function scheduleMaintenance() {
  setTimeout(runMaintenance, 60 * 1000).unref();
  setInterval(runMaintenance, 6 * 3600 * 1000).unref();
}

module.exports = { referencedUploads, cleanupUploads, runMaintenance, scheduleMaintenance };
