// market.ts
// Fetch token market data from a contract address (CA).
// Primary source: DexScreener (no API key, ~300 req/min on pairs endpoints).
// Fallback:       GeckoTerminal (no API key, ~30 req/min) for very new tokens
//                 that DexScreener hasn't indexed yet.

export interface TokenMarket {
  source: "dexscreener" | "geckoterminal";
  ca: string;
  chain: string;
  symbol: string;
  name: string;
  priceUsd: number;
  // FDV = price * total supply. marketCap uses circulating supply when known.
  // For new tokens circulating supply is often unknown -> marketCap may be null.
  fdv: number;
  marketCap: number | null;
  liquidityUsd: number;
  volume24h: number;
  priceChange24h: number;
  txns24h: { buys: number; sells: number };
  pairCreatedAt: number; // epoch ms; 0 if unknown. Token/pair age signal.
  dexId: string | null;
  url: string | null;
  pairAddress: string | null; // <- WAJIB ada
  chartNetwork: string;
}

// DexScreener uses 'ethereum'; GeckoTerminal uses 'eth'. Map both ways.
const GECKO_NETWORK: Record<string, string> = {
  ethereum: "eth",
  eth: "eth",
  bsc: "bsc",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  solana: "solana",
};

const DS_TOKENS = "https://api.dexscreener.com/latest/dex/tokens";
const GECKO = "https://api.geckoterminal.com/api/v2/networks";

// --- tiny in-memory TTL cache: avoids hammering upstream on repeat CAs ---
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; data: TokenMarket }>();

async function getJson(url: string, ms = 5000): Promise<any> {
  // AbortSignal.timeout: never let an upstream hang our request.
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json();
}

async function fromDexScreener(
  ca: string,
  chain?: string,
): Promise<TokenMarket> {
  const { pairs } = (await getJson(`${DS_TOKENS}/${ca}`)) as {
    pairs: any[] | null;
  };
  if (!pairs?.length) throw new Error("no_pairs");

  // A token can trade on many pairs/chains. Pick the deepest-liquidity pair,
  // optionally constrained to the requested chain.
  let candidates = pairs;
  if (chain) {
    const c = chain === "eth" ? "ethereum" : chain;
    const filtered = pairs.filter((p) => p.chainId === c);
    if (filtered.length) candidates = filtered;
  }
  const p = candidates.reduce((a, b) =>
    (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a,
  );

  return {
    source: "dexscreener",
    ca,
    chain: p.chainId,
    symbol: p.baseToken?.symbol ?? "?",
    name: p.baseToken?.name ?? "Unknown",
    priceUsd: Number(p.priceUsd ?? 0),
    fdv: Number(p.fdv ?? 0),
    marketCap: p.marketCap != null ? Number(p.marketCap) : null,
    liquidityUsd: Number(p.liquidity?.usd ?? 0),
    volume24h: Number(p.volume?.h24 ?? 0),
    priceChange24h: Number(p.priceChange?.h24 ?? 0),
    txns24h: {
      buys: Number(p.txns?.h24?.buys ?? 0),
      sells: Number(p.txns?.h24?.sells ?? 0),
    },
    pairCreatedAt: Number(p.pairCreatedAt ?? 0),
    dexId: p.dexId ?? null,
    url: p.url ?? null,
    pairAddress: p.pairAddress ?? null, // <- WAJIB ada
    chartNetwork: GECKO_NETWORK[p.chainId] ?? p.chainId,
  };
}

async function fromGecko(ca: string, chain = "eth"): Promise<TokenMarket> {
  const network = GECKO_NETWORK[chain] ?? "eth";
  const { data } = await getJson(`${GECKO}/${network}/tokens/${ca}`);
  const a = data?.attributes;
  if (!a) throw new Error("gecko_no_data");

  return {
    source: "geckoterminal",
    ca,
    chain: network,
    symbol: a.symbol ?? "?",
    name: a.name ?? "Unknown",
    priceUsd: Number(a.price_usd ?? 0),
    fdv: Number(a.fdv_usd ?? 0),
    marketCap: a.market_cap_usd != null ? Number(a.market_cap_usd) : null,
    liquidityUsd: Number(a.total_reserve_in_usd ?? 0),
    volume24h: Number(a.volume_usd?.h24 ?? 0),
    priceChange24h: 0, // not provided on this endpoint
    txns24h: { buys: 0, sells: 0 },
    pairCreatedAt: 0,
    dexId: null,
    url: null,
    pairAddress: null,
    chartNetwork: network,
  };
}

export async function fetchMarket(
  caRaw: string,
  chain?: string,
): Promise<TokenMarket> {
  const ca = caRaw.trim();
  const key = `${ca.toLowerCase()}:${chain ?? "auto"}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let data: TokenMarket;
  try {
    data = await fromDexScreener(ca, chain);
  } catch (e) {
    // Graceful degrade to GeckoTerminal (e.g. brand-new token not yet on DS).
    data = await fromGecko(ca, chain ?? "eth");
  }

  cache.set(key, { at: Date.now(), data });
  return data;
}

// Basic shape validation so we reject garbage before spending a Gemini call.
export function isValidCa(ca: string): boolean {
  const s = ca.trim();
  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(s);
  const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s); // base58, no 0OIl
  return isEvm || isSol;
}
