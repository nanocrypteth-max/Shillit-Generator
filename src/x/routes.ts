// x/routes.ts
// "Post to X" endpoints under /api/x/*. Mounted additively in server.ts.
//
// CREDENTIALS ARE PER-USER: each user supplies their own X app (Client ID/Secret/
// Callback/Scopes) via POST /api/x/config. They are stored encrypted at rest
// (TOKEN_ENC_KEY is the server master key) and used for that session's OAuth.
// App-level env: TOKEN_ENC_KEY, FRONTEND_ORIGIN, COOKIE_SECURE, X_DEFAULT_CALLBACK_URL.

import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { isValidCa } from "../market.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getMe,
  makePkce,
  postTweet,
  randomState,
  refreshToken,
  revoke,
  XError,
  type TokenSet,
} from "./oauth.js";
import {
  clearConfig,
  clearTokens,
  createJob,
  deleteJob,
  listJobs,
  loadConfig,
  loadPublicConfig,
  loadTokens,
  saveConfig,
  saveTokens,
  setFlow,
  setJobStatus,
  takeFlow,
  type XAppConfig,
} from "./store.js";
import { freshAccessToken, postTextForSession } from "./poster.js";

const MIN_INTERVAL_SEC = Number(process.env.SCHED_MIN_INTERVAL_SEC ?? 300); // floor: 5 min
const MAX_POSTS = Number(process.env.SCHED_MAX_POSTS ?? 100);
const VALID_TONES = ["hype", "degen", "professional", "ct", "reply"];
const VALID_LANGS = ["en", "id", "zh"];

const router = Router();

// App-level (server) settings — NOT per user.
function appCfg() {
  return {
    frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
    cookieSecure: process.env.COOKIE_SECURE === "true",
    // Default callback shown to the user to prefill the form / register in their X app.
    defaultCallback:
      process.env.X_DEFAULT_CALLBACK_URL ??
      `${process.env.FRONTEND_ORIGIN ?? "http://localhost:5173"}/api/x/callback`,
    defaultScopes:
      process.env.X_SCOPES ??
      "tweet.read tweet.write users.read offline.access",
  };
}

const COOKIE = "sg_sid";

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  (header ?? "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1)
      out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function ensureSid(req: Request, res: Response, secure: boolean): string {
  const existing = parseCookies(req.headers.cookie)[COOKIE];
  if (existing) return existing;
  const sid = crypto.randomBytes(24).toString("base64url");
  res.cookie(COOKIE, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 30 * 24 * 3600 * 1000,
  });
  return sid;
}
function readSid(req: Request): string | null {
  return parseCookies(req.headers.cookie)[COOKIE] ?? null;
}

// Load this session's X app credentials; throw if the user hasn't configured them.
async function requireConfig(sid: string): Promise<XAppConfig> {
  const cfg = await loadConfig(sid);
  if (!cfg)
    throw new XError(
      "x_not_configured",
      "Enter your X app credentials first",
      400,
    );
  return cfg;
}

// Valid access token for posting now lives in poster.ts (shared with scheduler).

// ---- CONFIG: get (non-secret), save, clear the user's X app credentials ----
router.get("/api/x/config", async (req, res) => {
  const a = appCfg();
  const sid = readSid(req);
  const pub = sid ? await loadPublicConfig(sid) : null;
  res.json({
    configured: !!pub,
    clientId: pub?.clientId ?? null,
    callbackUrl: pub?.callbackUrl ?? a.defaultCallback, // prefill
    scopes: pub?.scopes ?? a.defaultScopes,
    defaultCallback: a.defaultCallback, // the URL they must register in their X app
  });
});

router.post("/api/x/config", async (req, res) => {
  const a = appCfg();
  const sid = ensureSid(req, res, a.cookieSecure);
  const clientId = (req.body?.clientId ?? "").toString().trim();
  const clientSecret = (req.body?.clientSecret ?? "").toString().trim();
  const callbackUrl = (req.body?.callbackUrl ?? a.defaultCallback)
    .toString()
    .trim();
  const scopes = (req.body?.scopes ?? a.defaultScopes).toString().trim();

  if (!clientId || !clientSecret) {
    return res.status(400).json({
      error: "missing",
      message: "clientId and clientSecret are required.",
    });
  }
  try {
    new URL(callbackUrl); // validate it's a URL
  } catch {
    return res.status(400).json({
      error: "bad_callback",
      message: "callbackUrl must be a valid URL.",
    });
  }
  if (!/\btweet\.write\b/.test(scopes) || !/\boffline\.access\b/.test(scopes)) {
    return res.status(400).json({
      error: "bad_scopes",
      message: "scopes must include tweet.write and offline.access.",
    });
  }

  await saveConfig(sid, { clientId, clientSecret, callbackUrl, scopes });
  res.json({ ok: true, callbackUrl });
});

router.delete("/api/x/config", async (req, res) => {
  const sid = readSid(req);
  if (sid) {
    await clearConfig(sid);
    await clearTokens(sid);
  }
  res.json({ ok: true });
});

// ---- STATUS ----
router.get("/api/x/status", async (req, res) => {
  const sid = readSid(req);
  const rec = sid ? await loadTokens(sid) : null;
  const configured = sid ? !!(await loadPublicConfig(sid)) : false;
  res.json({ connected: !!rec, username: rec?.username ?? null, configured });
});

// ---- LOGIN: start OAuth using the user's stored credentials ----
router.get("/api/x/login", async (req, res) => {
  const a = appCfg();
  const sid = ensureSid(req, res, a.cookieSecure);
  let cfg: XAppConfig;
  try {
    cfg = await requireConfig(sid);
  } catch {
    return res
      .status(400)
      .send("X app not configured. Submit your credentials first.");
  }
  const state = randomState();
  const { verifier, challenge } = makePkce();
  setFlow(sid, state, verifier);

  res.redirect(
    buildAuthorizeUrl({
      clientId: cfg.clientId,
      redirectUri: cfg.callbackUrl,
      scopes: cfg.scopes,
      state,
      challenge,
    }),
  );
});

// ---- CALLBACK ----
router.get("/api/x/callback", async (req, res) => {
  const a = appCfg();
  const closePopup = (ok: boolean, error?: string) =>
    res.type("html")
      .send(`<!doctype html><meta charset="utf-8"><body style="background:#07090b;color:#b6ff3c;font-family:monospace">
<script>
  try { window.opener && window.opener.postMessage(
    { source: "shill-x", ok: ${ok}, error: ${JSON.stringify(error ?? null)} },
    ${JSON.stringify(a.frontendOrigin)}
  ); } catch (e) {}
  window.close();
</script>${ok ? "Connected. You can close this window." : "Auth failed: " + (error ?? "")}</body>`);

  const sid = readSid(req);
  const { code, state, error } = req.query as Record<string, string>;
  if (error) return closePopup(false, error);
  if (!sid || !code || !state) return closePopup(false, "missing params");

  const verifier = takeFlow(sid, state);
  if (!verifier) return closePopup(false, "invalid state");

  let cfg: XAppConfig;
  try {
    cfg = await requireConfig(sid);
  } catch {
    return closePopup(false, "not configured");
  }

  try {
    const tokens = await exchangeCode({
      code,
      verifier,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.callbackUrl,
    });
    const me = await getMe(tokens.accessToken);
    await saveTokens(sid, me.username, me.id, tokens);
    return closePopup(true);
  } catch (e: any) {
    console.error(
      "[x/callback] exchange failed:",
      e?.status ?? "",
      e?.detail ?? e?.message ?? e,
    );
    return closePopup(false, e?.code ?? "exchange failed");
  }
});

// ---- POST ----
router.post("/api/x/post", async (req, res) => {
  const sid = readSid(req);
  if (!sid)
    return res.status(401).json({
      error: "not_connected",
      message: "Connect your X account first.",
    });

  const text = (req.body?.text ?? "").toString();
  if (!text.trim())
    return res
      .status(400)
      .json({ error: "empty", message: "Nothing to post." });
  if (text.length > 280)
    return res
      .status(400)
      .json({ error: "too_long", message: "Tweet exceeds 280 characters." });

  try {
    const { username, url, id } = await postTextForSession(sid, text);
    return res.json({ id, username, url });
  } catch (e: any) {
    if (e instanceof XError) {
      if (e.code === "post_error") {
        console.error("[x/post]", e.status, e.detail);
        // 402 = X API credit balance empty (pay-per-use).
        if (e.status === 402) {
          return res.status(402).json({
            error: "no_credits",
            message:
              "X API credits depleted — top up at console.x.com (Billing).",
          });
        }
        return res.status(502).json({
          error: "post_error",
          message:
            "X rejected the post (write access, duplicate, or rate limit).",
        });
      }
      return res
        .status(e.status === 401 ? 401 : 502)
        .json({ error: e.code, message: e.detail || e.code });
    }
    console.error("[x/post]", e);
    return res
      .status(500)
      .json({ error: "internal", message: "Unexpected error." });
  }
});

// ---- LOGOUT (tokens only; keeps stored credentials) ----
router.post("/api/x/logout", async (req, res) => {
  const sid = readSid(req);
  if (sid) {
    const rec = await loadTokens(sid);
    if (rec?.tokens.accessToken) {
      const cfg = await loadConfig(sid);
      if (cfg) {
        try {
          await revoke(rec.tokens.accessToken, cfg.clientId, cfg.clientSecret);
        } catch {
          /* ignore */
        }
      }
    }
    await clearTokens(sid);
  }
  res.json({ ok: true });
});

// ---- Mode 2: scheduled auto-post jobs ----
router.post("/api/x/jobs", async (req, res) => {
  const sid = readSid(req);
  if (!sid)
    return res.status(401).json({
      error: "not_connected",
      message: "Connect your X account first.",
    });
  // Worker posts on the user's behalf later -> require tokens + config now.
  if (!(await loadTokens(sid)))
    return res.status(401).json({
      error: "not_connected",
      message: "Connect your X account first.",
    });

  const b = req.body ?? {};
  const ca = (b.ca ?? "").toString().trim();
  if (!isValidCa(ca))
    return res.status(400).json({
      error: "invalid_ca",
      message: "Provide a valid EVM/Solana address.",
    });

  const tone = VALID_TONES.includes(b.tone) ? b.tone : "hype";
  const language = VALID_LANGS.includes(b.language) ? b.language : "en";
  const chain = typeof b.chain === "string" && b.chain ? b.chain : null;
  const withHashtags = b.withHashtags === true;

  const intervalSec = Math.floor(Number(b.intervalSec));
  const total = Math.floor(Number(b.total));
  if (!Number.isFinite(intervalSec) || intervalSec < MIN_INTERVAL_SEC) {
    return res.status(400).json({
      error: "bad_interval",
      message: `Interval must be ≥ ${MIN_INTERVAL_SEC}s.`,
    });
  }
  if (!Number.isFinite(total) || total < 1 || total > MAX_POSTS) {
    return res.status(400).json({
      error: "bad_total",
      message: `Post count must be 1–${MAX_POSTS}.`,
    });
  }

  const id = await createJob({
    sid,
    ca,
    chain,
    tone,
    language,
    withHashtags,
    intervalSec,
    total,
  });
  res.json({ id });
});

router.get("/api/x/jobs", async (req, res) => {
  const sid = readSid(req);
  res.json({
    jobs: sid ? await listJobs(sid) : [],
    limits: { minIntervalSec: MIN_INTERVAL_SEC, maxPosts: MAX_POSTS },
  });
});

router.patch("/api/x/jobs/:id", async (req, res) => {
  const sid = readSid(req);
  if (!sid) return res.status(401).json({ error: "not_connected" });
  const status = req.body?.status;
  if (status !== "active" && status !== "paused") {
    return res.status(400).json({
      error: "bad_status",
      message: "status must be 'active' or 'paused'.",
    });
  }
  const ok = await setJobStatus(req.params.id, sid, status);
  if (!ok)
    return res
      .status(404)
      .json({ error: "not_found", message: "Job not found or already done." });
  res.json({ ok: true });
});

router.delete("/api/x/jobs/:id", async (req, res) => {
  const sid = readSid(req);
  if (!sid) return res.status(401).json({ error: "not_connected" });
  const ok = await deleteJob(req.params.id, sid);
  res.json({ ok });
});

export default router;
