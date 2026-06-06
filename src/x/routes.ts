// x/routes.ts
// "Post to X" endpoints under /api/x/*. Mounted additively in server.ts.
//
// IDENTITY: durable data (X app credentials + tokens) is keyed by an "owner":
//   - If the request carries a valid Privy access token (Authorization: Bearer …),
//     owner = "privy:<privy user id>"  -> tied to the user's wallet/login, so the
//     same user gets their saved keys + connection back on any device without
//     re-entering credentials or re-authorizing.
//   - Otherwise owner = "sid:<cookie session>" (fallback when Privy isn't set up).
// The cookie session id (sg_sid) is still used for the transient OAuth PKCE flow
// (login -> callback), which is a top-level navigation that can't send a header.
// App-level env: TOKEN_ENC_KEY, FRONTEND_ORIGIN, COOKIE_SECURE, X_DEFAULT_CALLBACK_URL,
//                PRIVY_APP_ID, PRIVY_VERIFICATION_KEY.

import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { isValidCa } from "../market.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getMe,
  makePkce,
  randomState,
  revoke,
  XError,
} from "./oauth.js";
import {
  clearConfig,
  clearTokens,
  createJob,
  deleteJob,
  getOwner,
  listJobs,
  loadConfig,
  loadPublicConfig,
  loadTokens,
  saveConfig,
  saveTokens,
  setFlow,
  setJobStatus,
  setOwner,
  takeFlow,
  type XAppConfig,
} from "./store.js";
import { postTextForSession } from "./poster.js";
import { verifyPrivyToken } from "./privy.js";

const MIN_INTERVAL_SEC = Number(process.env.SCHED_MIN_INTERVAL_SEC ?? 300); // floor: 5 min
const MAX_POSTS = Number(process.env.SCHED_MAX_POSTS ?? 100);
const VALID_TONES = ["hype", "degen", "professional", "ct", "reply"];
const VALID_LANGS = ["en", "zh", "ja", "de"];

const router = Router();

function appCfg() {
  return {
    frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
    cookieSecure: process.env.COOKIE_SECURE === "true",
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
function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t || null;
}

// Resolve the durable owner key for this request. Always ensures a cookie session
// (needed for the OAuth popup flow). When a valid Privy token is present, the owner
// is the Privy user id and we remember sid->owner so the popup flow can resolve it.
async function ownerFromRequest(req: Request, res: Response): Promise<string> {
  const a = appCfg();
  const sid = ensureSid(req, res, a.cookieSecure);
  const token = bearer(req);
  if (token) {
    const uid = await verifyPrivyToken(token);
    if (uid) {
      const owner = `privy:${uid}`;
      setOwner(sid, owner);
      return owner;
    }
  }
  return `sid:${sid}`;
}

// Owner key during the OAuth popup flow (no header available): use the mapping set
// by the prior authenticated call, else fall back to the cookie session.
function ownerForFlow(sid: string): string {
  return getOwner(sid) ?? `sid:${sid}`;
}

async function requireConfig(owner: string): Promise<XAppConfig> {
  const cfg = await loadConfig(owner);
  if (!cfg)
    throw new XError(
      "x_not_configured",
      "Enter your X app credentials first",
      400,
    );
  return cfg;
}

// ---- FLOW-INIT: bind this cookie session to the verified owner before connecting ----
router.post("/api/x/flow-init", async (req, res) => {
  const owner = await ownerFromRequest(req, res);
  res.json({ ok: true, scoped: owner.startsWith("privy:") });
});

// ---- CONFIG ----
router.get("/api/x/config", async (req, res) => {
  const a = appCfg();
  const owner = await ownerFromRequest(req, res);
  const pub = await loadPublicConfig(owner);
  res.json({
    configured: !!pub,
    clientId: pub?.clientId ?? null,
    callbackUrl: pub?.callbackUrl ?? a.defaultCallback,
    scopes: pub?.scopes ?? a.defaultScopes,
    defaultCallback: a.defaultCallback,
  });
});

router.post("/api/x/config", async (req, res) => {
  const a = appCfg();
  const owner = await ownerFromRequest(req, res);
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
    new URL(callbackUrl);
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

  await saveConfig(owner, { clientId, clientSecret, callbackUrl, scopes });
  res.json({ ok: true, callbackUrl });
});

router.delete("/api/x/config", async (req, res) => {
  const owner = await ownerFromRequest(req, res);
  await clearConfig(owner);
  await clearTokens(owner);
  res.json({ ok: true });
});

// ---- STATUS ----
router.get("/api/x/status", async (req, res) => {
  const owner = await ownerFromRequest(req, res);
  const rec = await loadTokens(owner);
  const configured = !!(await loadPublicConfig(owner));
  res.json({ connected: !!rec, username: rec?.username ?? null, configured });
});

// ---- LOGIN ----
router.get("/api/x/login", async (req, res) => {
  const a = appCfg();
  const sid = ensureSid(req, res, a.cookieSecure);
  const owner = ownerForFlow(sid);
  let cfg: XAppConfig;
  try {
    cfg = await requireConfig(owner);
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

  const owner = ownerForFlow(sid);
  let cfg: XAppConfig;
  try {
    cfg = await requireConfig(owner);
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
    await saveTokens(owner, me.username, me.id, tokens);
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
  const owner = await ownerFromRequest(req, res);

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
    const { username, url, id } = await postTextForSession(owner, text);
    return res.json({ id, username, url });
  } catch (e: any) {
    if (e instanceof XError) {
      if (e.code === "post_error") {
        console.error("[x/post]", e.status, e.detail);
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
  const owner = await ownerFromRequest(req, res);
  const rec = await loadTokens(owner);
  if (rec?.tokens.accessToken) {
    const cfg = await loadConfig(owner);
    if (cfg) {
      try {
        await revoke(rec.tokens.accessToken, cfg.clientId, cfg.clientSecret);
      } catch {
        /* ignore */
      }
    }
  }
  await clearTokens(owner);
  res.json({ ok: true });
});

// ---- Mode 2: scheduled auto-post jobs ----
router.post("/api/x/jobs", async (req, res) => {
  const owner = await ownerFromRequest(req, res);
  if (!(await loadTokens(owner)))
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
    sid: owner,
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
  const owner = await ownerFromRequest(req, res);
  res.json({
    jobs: await listJobs(owner),
    limits: { minIntervalSec: MIN_INTERVAL_SEC, maxPosts: MAX_POSTS },
  });
});

router.patch("/api/x/jobs/:id", async (req, res) => {
  const owner = await ownerFromRequest(req, res);
  const status = req.body?.status;
  if (status !== "active" && status !== "paused") {
    return res.status(400).json({
      error: "bad_status",
      message: "status must be 'active' or 'paused'.",
    });
  }
  const ok = await setJobStatus(req.params.id, owner, status);
  if (!ok)
    return res
      .status(404)
      .json({ error: "not_found", message: "Job not found or already done." });
  res.json({ ok: true });
});

router.delete("/api/x/jobs/:id", async (req, res) => {
  const owner = await ownerFromRequest(req, res);
  const ok = await deleteJob(req.params.id, owner);
  res.json({ ok });
});

export default router;
