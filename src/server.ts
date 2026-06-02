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
import { generatePost, type PostOptions, type Tone } from "./gemini.js";
import { fetchOhlcv } from "./chart.js";

const VALID_TONES: Tone[] = ["hype", "degen", "professional", "ct", "reply"];

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
      language: language === "id" ? "id" : "en",
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

// Serve frontend (public/index.html) for everything else.
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`\n  shill-gen running:  http://localhost:${PORT}\n`);
});
