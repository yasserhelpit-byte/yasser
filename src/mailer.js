const nodemailer = require('nodemailer');

// Configure with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
// Without SMTP settings, emails are printed to the server console instead (handy in development).
const configured = !!process.env.SMTP_HOST;
const transport = configured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;
const FROM = process.env.MAIL_FROM || 'YASSER <no-reply@yasser.local>';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, bodyHtml) {
  return `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f6f7f9;font-family:Tahoma,Arial,sans-serif;color:#1a1d23">
  <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e4e7ec;border-radius:12px;overflow:hidden">
    <div style="background:#0f766e;color:#fff;padding:16px 24px;font-weight:bold;font-size:20px">YASSER</div>
    <div style="padding:24px"><h2 style="margin-top:0">${esc(title)}</h2>${bodyHtml}</div>
  </div></body></html>`;
}

// Never throws: a failed email must not break the request that triggered it.
async function send({ to, subject, text, html }) {
  if (!to) return false;
  if (!configured) {
    console.log(`\n📧 [email to ${to}] ${subject}\n${text}\n`);
    return true;
  }
  try {
    await transport.sendMail({ from: FROM, to, subject, text, html });
    return true;
  } catch (err) {
    console.error('Email failed:', err.message);
    return false;
  }
}

module.exports = { send, layout, esc, configured };
