// Token security report for Risk Mode, backed by the GoPlus Security API.
// EVM chains are fully supported; Solana is best-effort (some fields N/A).
// No API key required (public, rate-limited).

export type RiskLevel = "ok" | "warn" | "danger" | "unknown";

export interface RiskRow {
  key: string;
  label: string;
  value: string;
  level: RiskLevel;
}

export interface RiskReport {
  ca: string;
  chain: string;
  source: string; // "goplus"
  supported: boolean;
  rows: RiskRow[];
  overall: { level: RiskLevel; label: string };
  note?: string;
}

// DexScreener chainId -> GoPlus EVM chain id.
const GOPLUS_CHAIN: Record<string, string> = {
  ethereum: "1",
  eth: "1",
  bsc: "56",
  base: "8453",
  arbitrum: "42161",
  polygon: "137",
  optimism: "10",
  avalanche: "43114",
  fantom: "250",
  cronos: "25",
  zksync: "324",
  linea: "59144",
  scroll: "534352",
};

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: RiskReport }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function getJson(url: string, ms = 8000): Promise<any> {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(400 * attempt + Math.random() * 200);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(ms),
        headers: { accept: "application/json" },
      });
    } catch {
      lastStatus = 0;
      continue;
    }
    if (res.ok) return res.json();
    lastStatus = res.status;
    if (!RETRYABLE.has(res.status)) throw new Error(`goplus ${res.status}`);
  }
  throw new Error(`goplus ${lastStatus || "timeout"}`);
}

const yes = (v: any) => String(v) === "1";
const pct = (frac: any) => {
  const n = Number(frac);
  return isFinite(n) ? n * 100 : NaN;
};

function boolRow(
  key: string,
  label: string,
  present: boolean | null,
  dangerWhenTrue: boolean,
): RiskRow {
  if (present === null) return { key, label, value: "N/A", level: "unknown" };
  // For flags where "true" is bad (honeypot/mintable/blacklist): danger/warn when true.
  // For flags where "true" is good (verified): ok when true.
  if (dangerWhenTrue) {
    return {
      key,
      label,
      value: present ? "Yes" : "No",
      level: present ? "danger" : "ok",
    };
  }
  return {
    key,
    label,
    value: present ? "Yes" : "No",
    level: present ? "ok" : "warn",
  };
}

function buildEvmReport(ca: string, chain: string, data: any): RiskReport {
  const rows: RiskRow[] = [];

  const verified =
    data?.is_open_source != null ? yes(data.is_open_source) : null;
  rows.push(boolRow("contract_verified", "Contract Verified", verified, false));

  // LP locked: sum percent of lp_holders flagged locked (includes burn addresses).
  let lpLocked: number | null = null;
  if (Array.isArray(data?.lp_holders) && data.lp_holders.length) {
    lpLocked = data.lp_holders
      .filter(
        (h: any) =>
          yes(h?.is_locked) || /lock|burn/i.test(String(h?.tag ?? "")),
      )
      .reduce((s: number, h: any) => s + (pct(h?.percent) || 0), 0);
  }
  rows.push(
    lpLocked == null
      ? { key: "lp_locked", label: "LP Locked", value: "N/A", level: "unknown" }
      : {
          key: "lp_locked",
          label: "LP Locked",
          value: `${lpLocked.toFixed(0)}%`,
          level: lpLocked >= 90 ? "ok" : lpLocked >= 50 ? "warn" : "danger",
        },
  );

  const honeypot = data?.is_honeypot != null ? yes(data.is_honeypot) : null;
  rows.push(boolRow("honeypot", "Honeypot", honeypot, true));

  const mintable = data?.is_mintable != null ? yes(data.is_mintable) : null;
  rows.push(boolRow("mint_function", "Mint Function", mintable, true));

  const blacklist =
    data?.is_blacklisted != null
      ? yes(data.is_blacklisted)
      : data?.transfer_pausable != null
        ? yes(data.transfer_pausable)
        : null;
  rows.push(boolRow("blacklist", "Blacklist", blacklist, true));

  // Top holders: sum of top 10 non-locked holder percentages (concentration).
  let top10: number | null = null;
  if (Array.isArray(data?.holders) && data.holders.length) {
    top10 = data.holders
      .filter(
        (h: any) =>
          !yes(h?.is_locked) && !/lock|burn/i.test(String(h?.tag ?? "")),
      )
      .slice(0, 10)
      .reduce((s: number, h: any) => s + (pct(h?.percent) || 0), 0);
  }
  rows.push(
    top10 == null
      ? {
          key: "top_holders",
          label: "Top Holders",
          value: "N/A",
          level: "unknown",
        }
      : {
          key: "top_holders",
          label: "Top Holders",
          value: `${top10.toFixed(0)}% (top 10)`,
          level: top10 < 30 ? "ok" : top10 <= 60 ? "warn" : "danger",
        },
  );

  return {
    ca,
    chain,
    source: "goplus",
    supported: true,
    rows,
    overall: computeOverall(rows, honeypot),
  };
}

function buildSolanaReport(ca: string, chain: string, data: any): RiskReport {
  const rows: RiskRow[] = [];

  // Solana has no "verified source" concept; the closest meaningful signal is
  // whether token metadata (name/symbol/image) can still be changed by the dev.
  const metaMutable =
    data?.metadata_mutable?.status != null
      ? yes(data.metadata_mutable.status)
      : data?.mutable_metadata?.status != null
        ? yes(data.mutable_metadata.status)
        : data?.metadata?.mutable != null
          ? yes(data.metadata.mutable)
          : null;
  rows.push(
    metaMutable == null
      ? {
          key: "metadata_mutable",
          label: "Metadata Mutable",
          value: "N/A",
          level: "unknown",
        }
      : {
          key: "metadata_mutable",
          label: "Metadata Mutable",
          value: metaMutable ? "Yes" : "No",
          level: metaMutable ? "warn" : "ok",
        },
  );

  // LP locked / burned.
  let lpLocked: number | null = null;
  if (Array.isArray(data?.lp_holders) && data.lp_holders.length) {
    lpLocked = data.lp_holders
      .filter(
        (h: any) =>
          yes(h?.is_locked) || /lock|burn/i.test(String(h?.tag ?? "")),
      )
      .reduce((s: number, h: any) => s + (pct(h?.percent) || 0), 0);
  }
  rows.push(
    lpLocked == null
      ? {
          key: "lp_locked",
          label: "LP Locked / Burned",
          value: "N/A",
          level: "unknown",
        }
      : {
          key: "lp_locked",
          label: "LP Locked / Burned",
          value: `${lpLocked.toFixed(0)}%`,
          level: lpLocked >= 90 ? "ok" : lpLocked >= 50 ? "warn" : "danger",
        },
  );

  // Transferable — Solana's honeypot-equivalent. non_transferable = can't move
  // tokens at all; a transfer hook can intercept/tax/block transfers.
  const nonTransferable =
    data?.non_transferable != null ? yes(data.non_transferable) : null;
  const hasHook = Array.isArray(data?.transfer_hook)
    ? data.transfer_hook.length > 0
    : data?.transfer_hook?.status != null
      ? yes(data.transfer_hook.status)
      : false;
  let transferable: RiskRow;
  if (nonTransferable === true) {
    transferable = {
      key: "transferable",
      label: "Transferable",
      value: "No",
      level: "danger",
    };
  } else if (hasHook) {
    transferable = {
      key: "transferable",
      label: "Transferable",
      value: "Transfer hook",
      level: "warn",
    };
  } else if (nonTransferable === false) {
    transferable = {
      key: "transferable",
      label: "Transferable",
      value: "Yes",
      level: "ok",
    };
  } else {
    transferable = {
      key: "transferable",
      label: "Transferable",
      value: "N/A",
      level: "unknown",
    };
  }
  rows.push(transferable);

  const mintable =
    data?.mintable?.status != null ? yes(data.mintable.status) : null;
  rows.push(boolRow("mint_function", "Mint Function", mintable, true));

  const frozen =
    data?.freezable?.status != null ? yes(data.freezable.status) : null;
  rows.push(boolRow("blacklist", "Freeze Authority", frozen, true));

  let top10: number | null = null;
  if (Array.isArray(data?.holders) && data.holders.length) {
    top10 = data.holders
      .filter(
        (h: any) =>
          !yes(h?.is_locked) && !/lock|burn/i.test(String(h?.tag ?? "")),
      )
      .slice(0, 10)
      .reduce((s: number, h: any) => s + (pct(h?.percent) || 0), 0);
  }
  rows.push(
    top10 == null
      ? {
          key: "top_holders",
          label: "Top Holders",
          value: "N/A",
          level: "unknown",
        }
      : {
          key: "top_holders",
          label: "Top Holders",
          value: `${top10.toFixed(0)}% (top 10)`,
          level: top10 < 30 ? "ok" : top10 <= 60 ? "warn" : "danger",
        },
  );

  return {
    ca,
    chain,
    source: "goplus",
    supported: true,
    rows,
    overall: computeOverall(rows, null),
    note: "Solana uses different security signals than EVM (mint/freeze authority, metadata, transfer hooks).",
  };
}

function computeOverall(
  rows: RiskRow[],
  honeypot: boolean | null,
): { level: RiskLevel; label: string } {
  if (honeypot) return { level: "danger", label: "High" };
  const dangers = rows.filter((r) => r.level === "danger").length;
  const warns = rows.filter((r) => r.level === "warn").length;
  if (dangers >= 2) return { level: "danger", label: "High" };
  if (dangers === 1 || warns >= 2) return { level: "warn", label: "Medium" };
  if (rows.every((r) => r.level === "unknown"))
    return { level: "unknown", label: "Unknown" };
  return { level: "ok", label: "Low" };
}

export async function fetchSecurity(
  caRaw: string,
  chainRaw: string,
): Promise<RiskReport> {
  const ca = caRaw.trim();
  const chain = (chainRaw || "").trim().toLowerCase();
  const key = `${chain}:${ca.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let report: RiskReport;

  if (chain === "solana") {
    const url = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(ca)}`;
    const json = await getJson(url);
    const data = json?.result?.[ca] ?? json?.result?.[ca.toLowerCase()] ?? null;
    report = data
      ? buildSolanaReport(ca, chain, data)
      : {
          ca,
          chain,
          source: "goplus",
          supported: false,
          rows: [],
          overall: { level: "unknown", label: "Unknown" },
          note: "No security data returned.",
        };
  } else {
    const chainId = GOPLUS_CHAIN[chain];
    if (!chainId) {
      report = {
        ca,
        chain,
        source: "goplus",
        supported: false,
        rows: [],
        overall: { level: "unknown", label: "Unknown" },
        note: `Security checks not supported for chain "${chain}".`,
      };
    } else {
      const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(ca)}`;
      const json = await getJson(url);
      const data = json?.result?.[ca.toLowerCase()] ?? null;
      report = data
        ? buildEvmReport(ca, chain, data)
        : {
            ca,
            chain,
            source: "goplus",
            supported: false,
            rows: [],
            overall: { level: "unknown", label: "Unknown" },
            note: "No security data returned for this token.",
          };
    }
  }

  cache.set(key, { at: Date.now(), data: report });
  return report;
}
