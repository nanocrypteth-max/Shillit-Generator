// x/poster.ts
// Shared posting helpers used by BOTH the HTTP route (/api/x/post) and the
// background scheduler. No cookie/HTTP dependency — keyed purely by session id.

import { postTweet, refreshToken, XError, type TokenSet } from "./oauth.js";
import { clearTokens, loadConfig, loadTokens, saveTokens } from "./store.js";

// Return a valid access token, refreshing if near expiry. Throws (XError) on reauth.
export async function freshAccessToken(sid: string): Promise<{ token: string; username: string }> {
  const rec = await loadTokens(sid);
  if (!rec) throw new XError("not_connected", "No X account connected", 401);

  let tokens: TokenSet = rec.tokens;
  if (Date.now() > tokens.expiresAt - 60_000) {
    if (!tokens.refreshToken) throw new XError("reauth_required", "Token expired, reconnect needed", 401);
    const cfg = await loadConfig(sid);
    if (!cfg) throw new XError("x_not_configured", "Credentials missing", 400);
    try {
      tokens = await refreshToken({
        refreshToken: tokens.refreshToken,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
      });
      await saveTokens(sid, rec.username, rec.userId, tokens);
    } catch {
      await clearTokens(sid);
      throw new XError("reauth_required", "Refresh failed, reconnect needed", 401);
    }
  }
  return { token: tokens.accessToken, username: rec.username };
}

export async function postTextForSession(
  sid: string,
  text: string
): Promise<{ id: string; username: string; url: string }> {
  const { token, username } = await freshAccessToken(sid);
  const { id } = await postTweet(token, text);
  return { id, username, url: `https://x.com/${username}/status/${id}` };
}
