# Upstox ← TradingView Webhook Bridge (Cloudflare Worker) v2

A Cloudflare Worker that receives **TradingView alert webhooks** and places **live orders on Upstox** — now with a built-in dashboard, trailing stop-loss exit engine, and manual controls.

## What's new in v2

- **Dashboard** — a self-contained HTML UI served from the Worker itself. No separate hosting.
- **Trailing stop-loss engine** — automatically exits positions when price reverses, with configurable activation threshold and trail percentage.
- **Fixed SL + Target** — optional hard stop-loss and profit-target exits.
- **Kill switch** — instantly halt all automated trading from the dashboard.
- **Signal & order logs** — every webhook and order response is logged for review.
- **Position tracking** — the worker tracks filled positions and monitors them for exit conditions.
- **Manual order panel** — place test orders directly from the dashboard.

## Architecture

```
TradingView alert
   │  POST /webhook?token=SECRET  (JSON payload)
   ▼
Cloudflare Worker
   ├─ validates secret + payload
   ├─ checks kill switch
   ├─ dedupes (10s window)
   ├─ places order via Upstox /v2/order/place
   ├─ logs signal + order to KV
   └─ tracks position for exit engine
         │
         │  Cron every minute during market hours:
         │  ├─ fetch LTP for each tracked position
         │  ├─ check trailing SL / fixed SL / target
         │  └─ place exit order if condition met
         ▼
   Dashboard (GET /)
     ├─ Token status + request button
     ├─ Kill switch toggle
     ├─ Signals log
     ├─ Orders log
     ├─ Tracked positions
     ├─ Live Upstox positions
     ├─ Manual order form
     └─ Exit-condition config
```

## Token refresh

Upstox access tokens expire at 3:30 AM IST daily. This project uses Upstox's **semi-automated** flow:

1. A cron trigger fires at 9:10 AM IST calling `POST /v3/login/auth/token/request/{client_id}`.
2. You get a push notification on the Upstox mobile app — tap **Approve**.
3. Upstox POSTs the access token to your `/notifier` endpoint.
4. The token is stored in KV and used for all orders.

You can also trigger a token request manually from the dashboard's **Token Status** panel.

## Deploy steps

### 1. Clone / unzip

```bash
unzip upstox-tv-webhook-v2.zip
cd upstox-tv-webhook
npm install -g wrangler
wrangler login
```

### 2. Create KV namespace

```bash
wrangler kv namespace create UPSTOX_KV
```

Paste the returned `id` and `preview_id` into `wrangler.toml`.

### 3. Configure

In `wrangler.toml`, set your `UPSTOX_CLIENT_ID`.

Set secrets:
```bash
wrangler secret put WEBHOOK_SECRET
wrangler secret put UPSTOX_CLIENT_SECRET
```

### 4. Deploy

```bash
wrangler deploy
```

### 5. Update Upstox app

On https://developer.upstox.com, edit your app:
- **Redirect URL**: `https://buildaistore.tech/callback`
- **Notifier Webhook Endpoint (Postback URL)**: `https://buildaistore.tech/notifier`

### 6. Get your first token

Open the dashboard at `https://buildaistore.tech/`, click **Request New Token**, approve the notification on your phone. Verify on the dashboard that token status turns green.

## Dashboard

Visit `https://buildaistore.tech/` — the dashboard is the server's root route.

### Tabs

| Tab | What it shows |
|-----|---------------|
| **Signals** | Every TradingView webhook received — action, instrument, status (placed/duplicate/rejected) |
| **Orders** | Every Upstox order response — entry, exit, and manual orders, with success/failure |
| **Positions** | Tracked positions (what the exit engine is monitoring) and a live view from Upstox |
| **Manual Order** | Form to place a test order by hand |
| **Exit Conditions** | Configure trailing SL, fixed SL, and target |

## Exit conditions — how they work

The exit engine runs as a **cron trigger every minute** during NSE market hours (9:15 AM – 3:30 PM IST, Mon–Fri). For each tracked position, it fetches the current LTP and checks the configured exit conditions.

### Trailing stop-loss

1. Position is opened (BUY or SELL) and tracked.
2. The engine waits for price to move in your favour by the **activation %** (e.g. 1% profit).
3. Once activated, a trailing stop-loss is set at **trailing SL %** below the highest price (for BUY) or above the lowest price (for SELL).
4. As price moves further in your favour, the trailing SL moves with it.
5. If price reverses and hits the trailing SL, the engine places a market exit order.

Example: BUY at ₹100, activation 1%, trailing SL 2%.
- Price rises to ₹101 → trailing activates. SL set at ₹98.98 (₹101 × 0.98).
- Price rises to ₹105 → SL trails up to ₹102.90 (₹105 × 0.98).
- Price drops to ₹102.90 → exit order placed.

### Fixed SL + Target

- **Fixed SL %**: if price drops below entry × (1 − SL%), exit immediately.
- **Fixed Target %**: if price rises above entry × (1 + target%), exit immediately.
- For SELL positions, the directions are inverted.

### Modes

| Mode | Behaviour |
|------|-----------|
| `none` | No automatic exits — positions are tracked but never closed by the engine |
| `trailing_sl` | Only trailing stop-loss is active |
| `fixed_sl_target` | Only fixed SL and target are active |
| `both` | Trailing SL + fixed SL + target all active — exits on whichever triggers first |

### Configuring from the dashboard

Go to the **Exit Conditions** tab:
1. Toggle **Enable Exit Engine** on.
2. Select a **Mode**.
3. Set your percentages.
4. Click **Save Exit Config**.

The engine picks up the new config on the next cron tick (within 1 minute).

## TradingView webhook setup

In your TradingView alert:
- **Webhook URL**: `https://buildaistore.tech/webhook?token=YOUR_WEBHOOK_SECRET`
- **Message**:
  ```json
  {"action":"BUY","instrument_token":"NSE_EQ|INE669E01016","quantity":1}
  ```

### Payload fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `action` | yes | — | `BUY` or `SELL` |
| `instrument_token` | yes | — | e.g. `NSE_EQ\|INE669E01016` |
| `quantity` | no | 1 | number of shares / lots |
| `order_type` | no | MARKET | `MARKET`, `LIMIT`, `SL`, `SL-M` |
| `product` | no | D | `D` (Delivery), `I` (Intraday), `MTF` |
| `validity` | no | DAY | `DAY` or `IOC` |
| `price` | no | 0 | required for LIMIT orders |
| `trigger_price` | no | 0 | required for SL / SL-M |

## All endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | none | Dashboard (HTML) |
| POST | `/webhook` | `?token=SECRET` | TradingView alert receiver |
| POST | `/notifier` | client_id check | Receives Upstox access token |
| POST | `/api/manual-order` | — | Place order from dashboard |
| POST | `/api/kill-switch` | — | Toggle kill switch |
| POST | `/api/exit-config` | — | Save exit conditions |
| POST | `/api/request-token` | — | Trigger token request now |
| GET | `/api/token-status` | — | Token presence + expiry |
| GET | `/api/signals` | — | Recent signals (JSON) |
| GET | `/api/orders` | — | Recent orders (JSON) |
| GET | `/api/positions` | — | Tracked positions (JSON) |
| GET | `/api/exit-config` | — | Current exit config (JSON) |
| GET | `/api/upstox-positions` | — | Live positions from Upstox |
| GET | `/health` | none | Liveness probe |

## Cron triggers

| Schedule (UTC) | IST | Purpose |
|-----------------|-----|---------|
| `40 3 * * 1-5` | 9:10 AM Mon–Fri | Request new access token |
| `* * * * *` | Every minute | Exit engine (trailing SL / fixed SL / target) |

The exit-engine cron runs every minute but only processes positions during NSE market hours (checked in code).

## Safety features

- **Kill switch** — blocks all incoming signals instantly; visible as a red banner on the dashboard.
- **Duplicate suppression** — identical payloads within 10 seconds are ignored.
- **Secret verification** — webhook requires `?token=SECRET` in the URL.
- **Client ID check** — the notifier endpoint verifies the payload's `client_id` matches yours.
- **Market-hours awareness** — the exit engine only runs during NSE trading hours.
- **No credentials stored** — the semi-automated flow never stores your password or TOTP secret.

## Limitations

- **Exit orders are MARKET orders** — there's no support for SL-limit exit orders yet.
- **LTP fetch is poll-based** (every 1 minute) — not real-time. Fast-moving stocks could slip between checks. For tighter control, reduce the poll interval (but watch KV/API rate limits).
- **Position tracking is worker-side** — if the Worker's KV is cleared, tracked positions are lost. The live Upstox positions view is always available as a fallback.
- **No WebSocket fills** — you won't see real-time fill updates in the dashboard; refresh positions manually.
- **One exit config globally** — per-strategy exit configs are not yet supported.

## Costs

- Cloudflare Workers free tier: 100,000 requests/day.
- KV free tier: 100,000 reads/day, 1,000 writes/day. The exit engine does ~1 write per position per minute during market hours — well within limits for a personal account.
- Upstox API: free for personal use.

## License

MIT — use at your own risk. Trading involves risk of loss. Test thoroughly with small quantities before going live.
