// x/oauth.ts
// X (Twitter) API v2 — OAuth 2.0 Authorization Code Flow with PKCE (user context).
// No SDK: just node:crypto + global fetch. Hosts use api.x.com (current);
// api.twitter.com still resolves but x.com is the canonical host now.

import crypto from "node:crypto";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REVOKE_URL = "https://api.x.com/2/oauth2/revoke";
const API = "https://api.x.com/2";

export class XError extends Error {
  code: string;
  status: number;
  detail: string;
  constructor(code: string, detail: string, status = 502) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

// --- PKCE ---
export function makePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
export function randomState() {
  return crypto.randomBytes(16).toString("base64url");
}

export function buildAuthorizeUrl(o: {
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  challenge: string;
}): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: o.scopes,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

// Confidential client -> authenticate the token endpoint with HTTP Basic.
function basicAuth(id: string, secret: string): string {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function tokenRequest(body: URLSearchParams, clientId: string, clientSecret: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(clientId, clientSecret),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new XError("token_error", text, res.status);
  const j = JSON.parse(text);
  return {
    accessToken: j.access_token as string,
    refreshToken: j.refresh_token as string | undefined,
    expiresAt: Date.now() + Number(j.expires_in ?? 7200) * 1000,
  } satisfies TokenSet;
}

export function exchangeCode(o: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  verifier: string;
}): Promise<TokenSet> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: o.code,
      redirect_uri: o.redirectUri,
      code_verifier: o.verifier,
      client_id: o.clientId,
    }),
    o.clientId,
    o.clientSecret
  );
}

export function refreshToken(o: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenSet> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: o.refreshToken,
      client_id: o.clientId,
    }),
    o.clientId,
    o.clientSecret
  ).then((t) => ({ ...t, refreshToken: t.refreshToken ?? o.refreshToken }));
}

export async function getMe(accessToken: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${API}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new XError("me_error", text, res.status);
  const j = JSON.parse(text);
  return { id: j.data.id, username: j.data.username };
}

export async function postTweet(accessToken: string, text: string): Promise<{ id: string }> {
  const res = await fetch(`${API}/tweets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (!res.ok) throw new XError("post_error", body, res.status);
  const j = JSON.parse(body);
  return { id: j.data.id };
}

export async function revoke(token: string, clientId: string, clientSecret: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(clientId, clientSecret),
    },
    body: new URLSearchParams({ token, token_type_hint: "access_token" }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {}); // best-effort
}
