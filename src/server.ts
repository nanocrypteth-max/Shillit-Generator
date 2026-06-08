// server.ts
// Single Express process: serves the API AND the static dApp frontend on one
// port -> no CORS setup, no separate frontend build. Just run and open browser.

import "dotenv/config";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMarket, isValidCa } from "./market.js";
import {
  generatePost,
  type PostOptions,
  type Tone,
  type Lang,
} from "./gemini.js";
import { fetchOhlcv } from "./chart.js";
import { fetchSecurity } from "./api/security.js";
import xRoutes from "./x/routes.js"; // ADDED: Post-to-X feature (isolated module)
// import { startScheduler } from "./x/scheduler.js"; // Mode 2 worker — disabled for now

const VALID_TONES: Tone[] = [
  "hype",
  "degen",
  "professional",
  "ct",
  "reply",
  "analysis",
  "risk",
];
const VALID_LANGS: Lang[] = ["en", "zh", "ja", "de"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "16kb" }));

// --- minimal per-IP rate limiter: protects your Gemini quota/billing ---
const LIMIT = Number(process.env.RATE_LIMIT_PER_MIN ?? 20);
const WINDOW_MS = 60_000;
const hits = new Map<string, { count: number; reset: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return next();
  }
  if (rec.count >= LIMIT) {
    res.setHeader("Retry-After", Math.ceil((rec.reset - now) / 1000));
    return res.status(429).json({
      error: "rate_limited",
      message: "Too many requests, slow down.",
    });
  }
  rec.count++;
  next();
}

// --- main endpoint: CA in -> market data + generated post out ---
// ─────────────────────────────────────────────────────────────────────────────
// FUTURE / TODO — server-side access control for generate (not enforced yet).
//
// Right now the wallet-login + pay-per-generate gate lives ONLY in the frontend
// (UX). It is NOT a backend protection: /api/generate below can still be called
// directly (curl/Postman) without going through the gate, so a paid gate today
// is bypassable.
//
// To make it real later, verify BEFORE processing generate:
//   1. Privy auth token  — read `Authorization: Bearer <privy token>`, verify it
//      against Privy's JWKS / server SDK (needs PRIVY_APP_ID + PRIVY_APP_SECRET).
//      Reject 401 if invalid/expired.
//   2. Payment proof      — confirm the user paid for this generate (e.g. a tx
//      hash to your treasury on the expected chain/amount, or a server-side
//      credit balance decremented per generate). Reject 402 if unpaid.
//
// Wire it as middleware so the generate logic itself stays untouched:
//   app.post("/api/generate", rateLimit, /* requireGenerateAccess, */ async ...)
//
// Stub kept here as the single hook point; currently a pass-through (no-op).
async function requireGenerateAccess(
  _req: Request,
  _res: Response,
  next: NextFunction,
) {
  // TODO: verify Privy token (step 1) + payment proof (step 2); call _res.status(401/402) to block.
  next();
}
void requireGenerateAccess; // referenced so it's kept; not enforced yet
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/generate", rateLimit, async (req: Request, res: Response) => {
  const { ca, chain, tone, language, withHashtags, replyTo } = req.body ?? {};

  if (typeof ca !== "string" || !isValidCa(ca)) {
    return res.status(400).json({
      error: "invalid_ca",
      message: "Provide a valid EVM (0x...) or Solana address.",
    });
  }

  try {
    const market = await fetchMarket(
      ca,
      typeof chain === "string" ? chain : undefined,
    );

    const opts: PostOptions = {
      tone: VALID_TONES.includes(tone) ? tone : "hype",
      language: VALID_LANGS.includes(language) ? language : "en",
      withHashtags: withHashtags === true,
      replyTo: typeof replyTo === "string" ? replyTo : undefined,
    };
    const post = await generatePost(market, opts);

    return res.json({ market, post });
  } catch (e: any) {
    const msg: string = e?.message ?? "unknown";
    // Root-cause-first error mapping for the client.
    if (msg === "no_pairs" || msg.includes("gecko_no_data")) {
      return res.status(404).json({
        error: "token_not_found",
        message:
          "No market data for this CA (not indexed or no liquidity yet).",
      });
    }
    if (msg.includes("GEMINI_API_KEY")) {
      return res.status(500).json({
        error: "config",
        message: "Server missing GEMINI_API_KEY. Set it in .env.",
      });
    }
    if (msg === "empty_generation") {
      return res.status(502).json({
        error: "generation_blocked",
        message:
          "Model returned nothing (possibly a safety filter). Try a different tone.",
      });
    }
    // DexScreener rate-limited / unreachable (after retries) -> friendly, retryable message.
    if (
      msg.includes("dexscreener") ||
      msg.includes("429") ||
      msg.includes("timeout")
    ) {
      return res.status(503).json({
        error: "market_unavailable",
        message: "Dexscreener is not ready, Please try again in a moment",
      });
    }
    console.error("[generate]", msg);
    return res.status(502).json({ error: "upstream", message: msg });
  }
});

app.get("/api/chart", rateLimit, async (req: Request, res: Response) => {
  const network = String(req.query.network ?? "");
  const pool = String(req.query.pool ?? "");
  const tfRaw = String(req.query.tf ?? "hour");
  const tf = (["minute", "hour", "day"] as const).includes(tfRaw as any)
    ? (tfRaw as any)
    : "hour";

  if (!network || !pool) {
    return res.status(400).json({
      error: "missing_params",
      message: "network and pool are required.",
    });
  }
  try {
    const points = await fetchOhlcv(network, pool, tf);
    return res.json({ points });
  } catch (e: any) {
    return res.status(502).json({
      error: "chart_unavailable",
      message: e?.message ?? "no chart data",
    });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Token security report for Risk Mode (GoPlus-backed).
app.get("/api/security", rateLimit, async (req: Request, res: Response) => {
  const ca = String(req.query.ca ?? "");
  const chain = String(req.query.chain ?? "");
  if (!isValidCa(ca)) {
    return res.status(400).json({
      error: "invalid_ca",
      message: "Provide a valid contract address.",
    });
  }
  try {
    const report = await fetchSecurity(ca, chain);
    return res.json(report);
  } catch (e: any) {
    const msg = e?.message ?? "security_unavailable";
    if (
      msg.includes("goplus") ||
      msg.includes("429") ||
      msg.includes("timeout")
    ) {
      return res.status(503).json({
        error: "security_unavailable",
        message: "Security data is not ready, please try again in a moment",
      });
    }
    return res
      .status(502)
      .json({ error: "security_unavailable", message: msg });
  }
});

// ADDED: Post-to-X endpoints (/api/x/*). Isolated; does not touch existing routes.
app.use(xRoutes);

// Serve frontend (public/index.html) for everything else.
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`\n  shill-gen running:  http://localhost:${PORT}\n`);
  // Mode 2 scheduler is DISABLED for now (feature not in use yet).
  // To re-enable later: uncomment the line below (and the import above).
  // if (process.env.DATABASE_URL) startScheduler();
});
