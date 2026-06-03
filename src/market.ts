// market.ts
// Market data comes from a SINGLE source: DexScreener (no API key, ~300 req/min).
// No GeckoTerminal fallback -> the "source" field is always consistent.
// (The price CHART is a separate feed sourced from GeckoTerminal OHLCV, because
//  DexScreener has no public candle endpoint. That is not "mixing" market data.)

export interface TokenMarket {
  source: "dexscreener";
  ca: string;
  chain: string;
  symbol: string;
  name: string;
  priceUsd: number;
  // FDV = price * total supply. marketCap uses circulating supply when known.
  fdv: number;
  marketCap: number | null;
  liquidityUsd: number;
  volume24h: number;
  priceChange24h: number;
  txns24h: { buys: number; sells: number };
  pairCreatedAt: number; // epoch ms; 0 if unknown. Token/pair age.
  dexId: string | null;
  url: string | null;
  pairAddress: string | null; // pool address -> used for the OHLCV chart
  chartNetwork: string; // GeckoTerminal network slug for the chart endpoint
}

// DexScreener chainId -> GeckoTerminal network slug (chart endpoint needs the slug).
const GECKO_NETWORK: Record<string, string> = {
  ethereum: "eth",
  bsc: "bsc",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  solana: "solana",
};

const DS_TOKENS = "https://api.dexscreener.com/latest/dex/tokens";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; data: TokenMarket }>();

async function getJson(url: string, ms = 5000): Promise<any> {
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

  // Pick the deepest-liquidity pair, optionally constrained to the requested chain.
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
    pairAddress: p.pairAddress ?? null,
    chartNetwork: GECKO_NETWORK[p.chainId] ?? p.chainId,
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

  // Single source. On failure we throw (server maps "no_pairs" -> 404). No fallback.
  const data = await fromDexScreener(ca, chain);
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function isValidCa(ca: string): boolean {
  const s = ca.trim();
  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(s);
  const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  return isEvm || isSol;
}
