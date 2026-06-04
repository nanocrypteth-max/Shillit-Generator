// x/scheduler.ts
// Mode 2 worker. Every tick it pulls due jobs from the DB and, for each, runs the
// SAME chain as Mode 1 — fetchMarket -> generatePost (fresh each time, so no
// duplicate spam) -> post to X — then advances/finishes the job. Persisted in DB,
// so it survives process restarts.
//
// Single-instance design. For multiple instances, add a DB-level claim (e.g.
// SELECT ... FOR UPDATE SKIP LOCKED or a `claimed_at` column) so two workers
// don't run the same job.

import { fetchMarket } from "../market.js";
import { generatePost, type Lang, type Tone } from "../gemini.js";
import { completeRun, failJob, getDueJobs, type Job } from "./store.js";
import { postTextForSession } from "./poster.js";

const TICK_MS = 30_000;
const running = new Set<string>(); // in-memory lock against overlapping ticks
let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;
  console.log("  scheduler: started (tick 30s)");
  setInterval(tick, TICK_MS).unref?.();
}

async function tick(): Promise<void> {
  let jobs: Job[];
  try {
    jobs = await getDueJobs();
  } catch (e) {
    console.error("[scheduler] due query failed:", (e as Error).message);
    return;
  }
  for (const job of jobs) {
    if (running.has(job.id)) continue;
    running.add(job.id);
    runJob(job).finally(() => running.delete(job.id));
  }
}

async function runJob(job: Job): Promise<void> {
  try {
    const market = await fetchMarket(job.ca, job.chain ?? undefined);
    const post = await generatePost(market, {
      tone: job.tone as Tone,
      language: job.language as Lang,
      withHashtags: job.withHashtags,
    });
    const { url } = await postTextForSession(job.sessionId, post);
    await completeRun(job.id, job.intervalSec, url);
    console.log(`[scheduler] job ${job.id} posted (${job.remaining - 1} left): ${url}`);
  } catch (e: any) {
    // Auto-pause on ANY failure — never hammer X/Gemini in a retry loop.
    const reason =
      e?.status === 402
        ? "X API credits depleted"
        : e?.code
          ? `${e.code}: ${(e.detail ?? e.message ?? "").toString().slice(0, 200)}`
          : (e?.message ?? "error").toString();
    await failJob(job.id, reason).catch(() => {});
    console.error(`[scheduler] job ${job.id} paused:`, reason);
  }
}
