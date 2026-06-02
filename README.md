# SHILL://GEN

Input a token **contract address (CA)** → auto-fetch live market data (price, MCap/FDV, volume, liquidity, txns) → generate an AI promo post grounded in that data.

- **Backend:** Node + Express + TypeScript. One endpoint: `POST /api/generate`.
- **Data:** DexScreener (primary) → GeckoTerminal (fallback). No API key needed for either.
- **AI:** Google Gemini via the new `@google/genai` SDK.
- **Frontend:** single static `public/index.html`, served by the same process (no CORS, no separate build).

---

## 1. Prerequisites

- **Node.js 18.17+** (uses global `fetch`). Check: `node -v`
- A **Gemini API key** (free): https://aistudio.google.com/apikey

## 2. Setup

```bash
npm install
cp .env.example .env       # then edit .env and paste your GEMINI_API_KEY
```

`.env`:
```
GEMINI_API_KEY=AIza...your_key...
GEMINI_MODEL=gemini-2.5-flash   # optional; try gemini-3.5-flash if your key has access
PORT=8787
RATE_LIMIT_PER_MIN=20
```

## 3. Run

**Dev (hot reload, no build step):**
```bash
npm run dev
```

**Production (compile then run):**
```bash
npm run build      # tsc -> dist/
npm start          # node dist/server.js
```

Open **http://localhost:8787** — paste a CA, pick chain/tone/language, hit GENERATE.

## 4. Hit the API directly

```bash
curl -X POST http://localhost:8787/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "ca": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    "chain": "eth",
    "tone": "hype",
    "language": "en"
  }'
```

Request fields: `ca` (required, EVM `0x...` or Solana base58), `chain` (optional: `eth|bsc|base|arbitrum|polygon|solana`, omit for auto), `tone` (`hype|degen|professional`), `language` (`en|id`).

Response:
```json
{
  "market": { "symbol": "UNI", "priceUsd": 0, "marketCap": 0, "fdv": 0,
              "volume24h": 0, "liquidityUsd": 0, "priceChange24h": 0,
              "txns24h": { "buys": 0, "sells": 0 }, "source": "dexscreener", "chain": "ethereum" },
  "post": "...generated post ending with: Not financial advice. DYOR."
}
```

Error codes: `400 invalid_ca`, `404 token_not_found`, `429 rate_limited`, `502 generation_blocked|upstream`, `500 config`.

---

## Notes / limits

- **MCap vs FDV:** DexScreener often returns only FDV (price × total supply). True MCap needs circulating supply, which is unknown for many new tokens → `marketCap` may be `null`; the UI falls back to FDV and labels it.
- **Rate limits:** DexScreener ~300 req/min (pairs); GeckoTerminal ~30 req/min. A 30s in-memory cache per CA softens repeats. The per-IP limiter protects your Gemini billing.
- **Generation guardrails (in `gemini.ts`):** the model is restricted to the real numbers passed in, forbidden from inventing partnerships/listings/returns, and always appends `Not financial advice. DYOR.` Removing these raises misrepresentation / disclosure / platform-spam risk — keep them.
- **Compliance:** publishing promotional content may trigger disclosure rules (e.g. paid/affiliated promotion) and platform anti-spam policies. Disclose material connections and check local rules before posting.

## Structure

```
shill-gen/
├─ src/
│  ├─ server.ts    # Express: API + static serving, rate limit, error mapping
│  ├─ market.ts    # DexScreener + GeckoTerminal fetch, cache, CA validation
│  └─ gemini.ts    # grounded prompt + @google/genai call
├─ public/
│  └─ index.html   # dApp-style frontend (self-contained)
├─ .env.example
├─ package.json
└─ tsconfig.json
```
