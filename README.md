# aa-3cx-sms-bridge

A small translation bridge between **Andrews & Arnold (A&A/AAISP)** SMS
delivery and **3CX**'s Generic SMS provider webhook.

A&A and 3CX don't speak the same language for SMS: A&A POSTs plain
form-encoded fields (`oa`, `da`, `ud`, `scts`), while 3CX's Generic SMS
provider expects a specific JSON event shape (`message.received`) for
inbound, and wants a Bearer-token-style API key for outbound — which A&A's
username/password gateway doesn't provide. This bridge sits in the middle
and translates both directions.

```
Inbound:   A&A --(form POST)--> bridge --(3CX JSON)--> 3CX webhook
Outbound:  3CX --(send request)--> bridge --(username/password POST)--> A&A
```

## Requirements

- Node.js 18+ (uses `crypto.randomUUID`)
- An A&A VoIP number with SMS enabled, and an outgoing password set on the
  [A&A Control Pages](https://control.aa.net.uk/)
- A 3CX instance with a **Generic SMS** provider added under
  **Admin Console → Messaging → Add Provider → Generic**
- A publicly reachable place to run this (a VPS, a Pi, a Home Assistant
  add-on host, etc.) with HTTPS in front of it — A&A and 3CX both need to
  reach it over the internet

## Setup

```bash
git clone <this repo>
cd aa-3cx-sms-bridge
npm install
cp .env.example .env
# edit .env with your real values
npm start
```

See `.env.example` for every setting. At minimum you need:

- `THREECX_WEBHOOK_URL` — the webhook URL 3CX generated for your Generic
  SMS provider
- `AA_USERNAME` / `AA_PASSWORD` — your A&A VoIP number and its outgoing
  SMS password
- `SHARED_SECRET` — recommended. A&A's inbound POST has no signature or
  auth of its own, so this is your only real gatekeeping. Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
  ```
  **Generate your own random value — never reuse an example secret you've
  seen elsewhere (including in this README's own examples), and never
  commit a real secret to `.env` or anywhere else in the repo.** The
  `.gitignore` keeps `.env` out of git, but double-check before pushing if
  you ever hardcode it anywhere for testing.

## Wiring it up

### Inbound (A&A → 3CX)

1. Run the bridge somewhere with a public HTTPS URL, e.g.
   `https://your-server/aa-sms-in?key=yoursecret`
2. On the A&A Control Pages, set that as the SMS delivery target for your
   number. A&A's delivery target field is **space-separated** (not comma),
   and multiple targets can be listed together, e.g.:
   ```
   you@example.com +https://your-server/aa-sms-in?key=yoursecret
   ```
   The `+` prefix makes A&A send E.123-formatted numbers (`+44...`) and
   ISO8601 timestamps to that target, which this bridge expects.
3. Text your A&A number. The bridge logs the incoming payload, reshapes
   it, and forwards it to your 3CX webhook.

### Outbound (3CX → A&A)

Point 3CX's Generic SMS provider **Provider URL** at your bridge's
outbound endpoint (e.g. `https://your-server/cx-sms-out?key=yoursecret`)
instead of A&A's gateway directly, since 3CX wants to authenticate with an
API key and A&A doesn't have one.

**Note:** 3CX's exact outbound webhook payload shape isn't publicly
documented. `extractOutbound()` in `src/server.js` makes a best-effort
guess at where the destination number and message text live in the
request body. If outbound sends aren't working, hit the bridge's `/debug`
endpoint from 3CX first (or check the bridge's logs — every outbound
request is logged in full) and adjust `extractOutbound()` to match what
you actually see.

## Running as a Home Assistant Add-on

The `ha-addon/aa-3cx-sms-bridge/` folder packages this as an installable
HA Supervisor add-on — no SSH access to the host required.

1. Push this repo to GitHub (public or private, either works)
2. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**,
   add your repo's URL (the one containing `repository.yaml`)
3. The "AA-3CX SMS Bridge" add-on should appear in the store — install it
4. Go to the add-on's **Configuration** tab and fill in:
   - `threecx_webhook_url` — from 3CX's Generic SMS provider
   - `aa_username` / `aa_password` — your A&A VoIP number and outgoing SMS password
   - `shared_secret` — generate one (see above), keep it, you'll need it below
   - leave `aa_sms_url`, `inbound_path`, `outbound_path` as default unless you have a reason to change them
5. Start the add-on, check its **Log** tab for `AA <-> 3CX SMS bridge listening on port 3000`

### Exposing it via Cloudflare Tunnel

Since you're already tunneling HA, add the bridge as a second public
hostname on the same tunnel:

1. [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) →
   **Networks → Tunnels** → your existing tunnel → **Public Hostnames → Add a public hostname**
2. Pick a subdomain, e.g. `sms-bridge.yourdomain.com`
3. Service type **HTTP**, URL `homeassistant.local:3000` (or your HA host's
   LAN IP if `.local` doesn't resolve for `cloudflared`, e.g. `192.168.1.50:3000`)
4. Save — no router port-forwarding needed, `cloudflared` makes the
   outbound connection

Your URLs to hand out become:
- A&A delivery target: `+https://sms-bridge.yourdomain.com/aa-sms-in?key=yoursecret`
- 3CX Provider URL: `https://sms-bridge.yourdomain.com/cx-sms-out?key=yoursecret`

**Note on the shared secret:** the add-on's `run.sh` parses `/data/options.json`
with `grep`/`cut` rather than a JSON parser, to avoid adding `jq` as a
dependency in the Alpine base image — fine for the simple flat values here,
but if you add option values containing commas or quotes later, switch it
to `jq`.

## Debugging

- `GET /health` — confirms the bridge is up
- `POST /debug` — logs and echoes back whatever is POSTed to it; handy for
  pointing 3CX or A&A at temporarily to see their raw payload shape
- Every inbound and outbound request is logged to stdout

## Known unknowns

- A&A's `!` target prefix isn't documented anywhere public — if you need
  it, ask A&A support directly.
- 3CX's outbound Generic SMS payload shape is inferred, not confirmed
  against real 3CX traffic yet — expect to adjust `extractOutbound()`.

## License

MIT
