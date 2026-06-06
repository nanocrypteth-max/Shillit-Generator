// chart.ts
// Fetch recent price points (close) for a pool from GeckoTerminal OHLCV.
// Endpoint: /networks/{network}/pools/{pool}/ohlcv/{timeframe}?aggregate=&limit=
// ohlcv_list rows are: [timestamp_sec, open, high, low, close, volume]

export interface ChartPoint {
  t: number; // epoch ms
  c: number; // close price USD
}

const GECKO = "https://api.geckoterminal.com/api/v2/networks";

type TF = "minute" | "hour" | "day";
const AGG: Record<TF, number> = { minute: 5, hour: 1, day: 1 }; // 5m / 1h / 1d candles

const CACHE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; data: ChartPoint[] }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// GeckoTerminal free tier rate-limits (~30/min) and occasionally times out, which
// surfaced as 502s on the chart. Retry transient failures with backoff.
async function fetchJson(url: string, ms = 6000): Promise<any> {
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
    if (!RETRYABLE.has(res.status))
      throw new Error(`gecko_ohlcv ${res.status}`);
  }
  throw new Error(`gecko_ohlcv ${lastStatus || "timeout"}`);
}

export async function fetchOhlcv(
  network: string,
  pool: string,
  timeframe: TF = "hour",
  limit = 48,
): Promise<ChartPoint[]> {
  const key = `${network}:${pool}:${timeframe}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const url =
    `${GECKO}/${network}/pools/${pool}/ohlcv/${timeframe}` +
    `?aggregate=${AGG[timeframe]}&limit=${limit}&currency=usd`;

  const json = (await fetchJson(url)) as any;
  const list: number[][] = json?.data?.attributes?.ohlcv_list ?? [];
  // API returns newest-first; reverse to chronological for a left-to-right chart.
  const points: ChartPoint[] = list
    .map((row) => ({ t: Number(row[0]) * 1000, c: Number(row[4]) }))
    .filter((p) => isFinite(p.c) && p.c > 0)
    .reverse();

  cache.set(key, { at: Date.now(), data: points });
  return points;
}
