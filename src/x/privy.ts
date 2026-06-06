// x/privy.ts
// Verifies a Privy ACCESS token locally (ES256) using the app's verification key.
// No per-request API call. If PRIVY_APP_ID / PRIVY_VERIFICATION_KEY are not set,
// verification is treated as "not configured" (returns null) so the app falls back
// to cookie sessions and keeps working without Privy.
//
// Env:
//   PRIVY_APP_ID            — your Privy app id (the token's `aud`)
//   PRIVY_VERIFICATION_KEY  — PEM public key from Privy dashboard (App settings)

import * as jose from "jose";

let keyPromise: ReturnType<typeof jose.importSPKI> | null = null;

function getKey(): ReturnType<typeof jose.importSPKI> | null {
  const pem = process.env.PRIVY_VERIFICATION_KEY;
  if (!pem) return null;
  if (!keyPromise) {
    // env vars often store newlines as literal "\n"
    keyPromise = jose.importSPKI(pem.replace(/\\n/g, "\n"), "ES256");
  }
  return keyPromise;
}

export function privyConfigured(): boolean {
  return !!process.env.PRIVY_APP_ID && !!process.env.PRIVY_VERIFICATION_KEY;
}

// Returns the Privy user id (DID, the token `sub`) if the token is valid, else null.
export async function verifyPrivyToken(token: string): Promise<string | null> {
  const appId = process.env.PRIVY_APP_ID;
  const keyP = getKey();
  if (!appId || !keyP) return null;
  try {
    const key = await keyP;
    const { payload } = await jose.jwtVerify(token, key, {
      issuer: "privy.io",
      audience: appId,
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
