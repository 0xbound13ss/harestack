/**
 * Harestack Contact Form — Cloudflare Worker (Resend)
 *
 * Receives POST /submit with JSON body, validates, and forwards
 * the message to hello@neia.group via Resend.
 *
 * ─── Setup ──────────────────────────────────────────────────────
 *
 * 1. Sign up at https://resend.com (free: 3,000 emails/month)
 *
 * 2. Add & verify your domain (neia.group) in Resend dashboard:
 *    → Settings > Domains > Add Domain
 *    → Add the DNS records Resend gives you (SPF, DKIM, etc.)
 *
 * 3. Create an API key:
 *    → Settings > API Keys > Create API Key
 *
 * 4. Store the key as a Worker secret:
 *    npx wrangler secret put RESEND_API_KEY
 *    (paste the key when prompted)
 *
 * 5. Deploy:
 *    npx wrangler deploy worker.js --name harestack-form
 *
 * ─── Alternative: Cloudflare Pages Function ─────────────────────
 *
 * If you're on CF Pages, drop this file into:
 *   functions/api/contact.js
 *
 * And set the secret via the Pages dashboard:
 *   Settings > Environment variables > Add > RESEND_API_KEY
 *
 * The form will POST to /api/contact automatically.
 * ────────────────────────────────────────────────────────────────
 */

const RECIPIENT = 'hello@neia.group';
const FROM_ADDR = 'Harestack Form <form@neia.group>'; // must be on verified domain

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',  // lock down to your domain in prod
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── CF Pages Function export (functions/api/contact.js) ─────────
export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  return handlePost(context.request, context.env);
}

// ── Standard Worker export ──────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }
    return handlePost(request, env);
  },
};

// ── Core handler ────────────────────────────────────────────────

async function handlePost(request, env) {
  // Validate API key is configured
  if (!env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY secret is not set');
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Parse body
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { role, name, email, fields } = data;

  // Basic validation
  if (!role || !name || !email || !fields) {
    return json({ error: 'Missing required fields' }, 400);
  }
  if (typeof name !== 'string' || name.length > 200) {
    return json({ error: 'Invalid name' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email' }, 400);
  }
  if (!['guest', 'hr', 'customer'].includes(role)) {
    return json({ error: 'Invalid role' }, 400);
  }

  // Build email
  const subject = `[Harestack] New ${formatRole(role)} enquiry from ${name}`;
  const html = buildHtml(role, name, email, fields);
  const text = buildPlain(role, name, email, fields);

  // Send via Resend
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDR,
        to: [RECIPIENT],
        replyTo: email,
        subject,
        html,
        text,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Resend error ${res.status}: ${err}`);
      return json({ error: 'Failed to send message' }, 500);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('Resend fetch failed:', err);
    return json({ error: 'Failed to send message' }, 500);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function formatRole(role) {
  const map = { guest: 'Guest', hr: 'HR/Recruiter', customer: 'Customer' };
  return map[role] || role;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(role, name, email, fields) {
  const rows = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 12px;color:#6B5F7B;font-size:13px;vertical-align:top;white-space:nowrap">${esc(k)}</td>
        <td style="padding:8px 12px;color:#2A1F3D;font-size:14px;white-space:pre-wrap">${esc(v)}</td>
      </tr>`)
    .join('');

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#F0EDEA;border-radius:12px;padding:24px 28px;margin-bottom:16px">
        <h2 style="margin:0 0 4px;font-size:18px;color:#2A1F3D">New ${esc(formatRole(role))} enquiry</h2>
        <p style="margin:0;font-size:13px;color:#6B5F7B">from <strong>${esc(name)}</strong> &lt;${esc(email)}&gt;</p>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #E8E4ED">
        ${rows}
      </table>
      <p style="margin-top:16px;font-size:12px;color:#9B93A8;text-align:center">
        Sent from harestack.app contact form
      </p>
    </div>`;
}

function buildPlain(role, name, email, fields) {
  const lines = [
    `New ${formatRole(role)} enquiry`,
    `From: ${name} <${email}>`,
    '',
    '---',
  ];
  for (const [k, v] of Object.entries(fields)) {
    if (v) lines.push(`${k}: ${v}`);
  }
  lines.push('', '— Sent from harestack.app contact form');
  return lines.join('\n');
}