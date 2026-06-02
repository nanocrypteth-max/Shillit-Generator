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

export async function fetchOhlcv(
  network: string,
  pool: string,
  timeframe: TF = "hour",
  limit = 48
): Promise<ChartPoint[]> {
  const key = `${network}:${pool}:${timeframe}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const url =
    `${GECKO}/${network}/pools/${pool}/ohlcv/${timeframe}` +
    `?aggregate=${AGG[timeframe]}&limit=${limit}&currency=usd`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`gecko_ohlcv ${res.status}`);

  const json = (await res.json()) as any;
  const list: number[][] = json?.data?.attributes?.ohlcv_list ?? [];
  // API returns newest-first; reverse to chronological for a left-to-right chart.
  const points: ChartPoint[] = list
    .map((row) => ({ t: Number(row[0]) * 1000, c: Number(row[4]) }))
    .filter((p) => isFinite(p.c) && p.c > 0)
    .reverse();

  cache.set(key, { at: Date.now(), data: points });
  return points;
}
