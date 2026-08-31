require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const multer = require('multer');

const app = express();
const upload = multer(); // parses multipart/form-data fields (no file uploads expected)

// A&A's inbound POST is multipart/form-data, not urlencoded — multer
// handles that on the inbound route specifically (see app.post below).
// We still parse urlencoded + JSON globally in case that ever changes,
// or for the 3CX -> us outbound leg.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  PORT = 3000,
  INBOUND_PATH = '/aa-sms-in',
  OUTBOUND_PATH = '/cx-sms-out',
  THREECX_WEBHOOK_URL,
  AA_SMS_URL = 'https://sms.aa.net.uk/sms.cgi',
  AA_USERNAME,
  AA_PASSWORD,
  SHARED_SECRET, // optional: appended as ?key=... on the inbound URL you give to A&A
} = process.env;

function checkSecret(req, res) {
  if (!SHARED_SECRET) return true;
  if (req.query.key === SHARED_SECRET) return true;
  res.status(403).send('Forbidden');
  return false;
}

/**
 * LEG 1 — INBOUND: A&A -> us -> 3CX
 *
 * A&A POSTs form fields here (oa, da, ud, scts, ...). We reshape into
 * 3CX's Generic SMS "message.received" event and forward it on.
 *
 * Give A&A this URL as the SMS delivery target (space-separated if you
 * also have email targets), prefixed with "+" so A&A sends E.123 numbers
 * and ISO8601 timestamps, e.g.:
 *   you@example.com +https://your-server/aa-sms-in?key=yoursecret
 */
async function handleInbound(req, res) {
  if (!checkSecret(req, res)) return;

  // A&A's exact delivery mechanism (GET query string vs POST form body)
  // isn't confirmed, so accept fields from either — query string wins if
  // a field appears in both, since that's the more common webhook pattern.
  const aa = { ...(req.body || {}), ...(req.query || {}) };

  console.log(`[inbound] ${req.method} received from A&A`);
  console.log('[inbound] query:', req.query);
  console.log('[inbound] body:', req.body);
  console.log('[inbound] content-type:', req.headers['content-type']);
  console.log('[inbound] merged fields:', aa);

  if (!aa.ud && !aa.message) {
    console.warn('[inbound] payload has no recognisable message body, ignoring');
    return res.status(200).send('OK'); // still 200 so A&A doesn't retry forever
  }

  const cxPayload = {
    data: {
      event_type: 'message.received',
      id: crypto.randomUUID(),
      occurred_at: new Date().toISOString(),
      payload: {
        direction: 'inbound',
        text: aa.ud || aa.message,
        received_at: aa.scts || new Date().toISOString(),
        from: {
          phone_number: normalisePhone(aa.oa || aa.originator),
        },
        to: [
          { phone_number: normalisePhone(aa.da || aa.destination) },
        ],
        type: 'SMS',
      },
    },
  };

  try {
    if (!THREECX_WEBHOOK_URL) {
      throw new Error('THREECX_WEBHOOK_URL is not configured');
    }
    const cxResp = await fetch(THREECX_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cxPayload),
    });
    console.log(`[inbound] forwarded to 3CX, status ${cxResp.status}`);
  } catch (err) {
    console.error('[inbound] failed to forward to 3CX:', err.message);
    // Still return 200 to A&A — we received it fine, the downstream
    // failure is ours to retry/investigate, not theirs.
  }

  res.status(200).send('OK');
}

// A&A's exact HTTP method for delivering to a URL target isn't documented,
// so listen on both until we've confirmed which one it actually uses.
// upload.none() parses multipart/form-data fields (A&A's actual format)
// into req.body without expecting any file attachments.
app.post(INBOUND_PATH, upload.none(), handleInbound);
app.get(INBOUND_PATH, handleInbound);

/**
 * LEG 2 — OUTBOUND: 3CX -> us -> A&A
 *
 * Point 3CX's Generic SMS provider "Provider URL" at this endpoint
 * (instead of A&A's sms.cgi directly), since A&A needs username/password
 * form fields rather than the Bearer-style API key 3CX expects to send.
 *
 * We accept whatever shape 3CX sends (JSON body with a text + destination
 * somewhere) — adjust extractOutbound() below once you see 3CX's real
 * outbound payload, the exact shape isn't publicly documented.
 */
app.post(OUTBOUND_PATH, async (req, res) => {
  if (!checkSecret(req, res)) return;

  console.log('[outbound] received from 3CX:', JSON.stringify(req.body));

  const { to, text } = extractOutbound(req.body);
  if (!to || !text) {
    console.warn('[outbound] could not find destination/text in 3CX payload');
    return res.status(400).json({ error: 'missing to/text' });
  }

  if (!AA_USERNAME || !AA_PASSWORD) {
    console.error('[outbound] AA_USERNAME / AA_PASSWORD not configured');
    return res.status(500).json({ error: 'server not configured for outbound send' });
  }

  const params = new URLSearchParams({
    username: AA_USERNAME,
    password: AA_PASSWORD,
    da: to,
    ud: text,
  });

  try {
    const aaResp = await fetch(AA_SMS_URL, { method: 'POST', body: params });
    const bodyText = await aaResp.text();
    console.log(`[outbound] A&A responded ${aaResp.status}: ${bodyText}`);
    res.status(aaResp.ok ? 200 : 502).json({ status: aaResp.status, body: bodyText });
  } catch (err) {
    console.error('[outbound] failed to send via A&A:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Best-effort extraction since 3CX's actual outbound webhook shape isn't
// documented — tweak this once you've captured a real request (see the
// /debug echo route below, or your server logs).
function extractOutbound(body = {}) {
  const to =
    body?.to?.[0]?.phone_number ||
    body?.data?.payload?.to?.[0]?.phone_number ||
    body?.to ||
    body?.destination;
  const text = body?.text || body?.data?.payload?.text || body?.message || body?.ud;
  return { to: to ? normalisePhone(to) : null, text };
}

function normalisePhone(num) {
  if (!num) return num;
  // A&A with the "+" target prefix already sends E.123 (+44...), but
  // normalise defensively in case a leading 0 slips through.
  const trimmed = String(num).trim();
  if (trimmed.startsWith('+')) return trimmed;
  if (trimmed.startsWith('0')) return '+44' + trimmed.slice(1);
  return trimmed;
}

// Handy while wiring things up: hit this from a browser/curl to confirm
// the server is alive, and log-and-echo any POST so you can inspect
// exactly what 3CX or A&A actually sends.
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.post('/debug', (req, res) => {
  console.log('[debug] headers:', req.headers);
  console.log('[debug] body:', req.body);
  res.json({ received: req.body });
});

app.listen(PORT, () => {
  console.log(`AA <-> 3CX SMS bridge listening on port ${PORT}`);
  console.log(`  Inbound  (A&A -> 3CX): POST http://localhost:${PORT}${INBOUND_PATH}`);
  console.log(`  Outbound (3CX -> A&A): POST http://localhost:${PORT}${OUTBOUND_PATH}`);
});
