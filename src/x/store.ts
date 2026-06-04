// x/store.ts
// Token storage backed by MySQL, encrypted at rest. Tokens are NEVER sent to the
// frontend. Encryption (AES-256-GCM) is kept even though it's in a DB: the DB
// stores only ciphertext, so a DB leak alone does not expose tokens.
//
// Diagnostics: every DB op logs "[x/store] ..." with the MySQL error code + message
// on failure, and the pool pings on first connect so connection problems (access
// denied, auth plugin, wrong host/db) surface immediately and clearly.

import crypto from "node:crypto";
import mysql from "mysql2/promise";
import type { TokenSet } from "./oauth.js";

// ---------- encryption ----------
function key(): Buffer {
  const b64 = process.env.TOKEN_ENC_KEY;
  if (!b64) throw new Error("TOKEN_ENC_KEY missing (base64-encoded 32 bytes)");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32)
    throw new Error("TOKEN_ENC_KEY must decode to exactly 32 bytes");
  return k;
}
function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}
function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ---------- MySQL pool (lazy; created on first DB op) ----------
let poolPromise: Promise<mysql.Pool> | null = null;

function getPool(): Promise<mysql.Pool> {
  if (!poolPromise) {
    poolPromise = init().catch((e) => {
      // IMPORTANT: drop the rejected promise so the next call can retry
      // (otherwise a one-time startup failure would wedge the pool forever).
      poolPromise = null;
      throw e;
    });
  }
  return poolPromise;
}

async function init(): Promise<mysql.Pool> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing !");

  // Redacted log so you can confirm host/port/db without leaking the password.
  try {
    const u = new URL(url);
    console.log(
      `[x/store] connecting to MySQL ${u.hostname}:${u.port || "3306"}${u.pathname} as ${u.username}…`,
    );
  } catch {
    console.error(
      "[x/store] DATABASE_URL is not a valid URL. Expected mysql://user:pass@host:3306/db",
    );
  }

  const pool = mysql.createPool(url);

  // Fail fast with the real reason (access denied / auth plugin / refused / bad db).
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
  console.log("[x/store] MySQL connected ✓");

  await ensureTables(pool);
  return pool;
}

async function ensureTables(pool: mysql.Pool): Promise<void> {
  // Convenience for dev; in prod run schema.sql via migrations and drop DDL rights.
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS x_tokens (
         session_id VARCHAR(64)  NOT NULL PRIMARY KEY,
         username   VARCHAR(255) NOT NULL,
         user_id    VARCHAR(64)  NOT NULL,
         token_blob TEXT         NOT NULL,
         updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         INDEX idx_user_id (user_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS x_app_config (
         session_id   VARCHAR(64)  NOT NULL PRIMARY KEY,
         client_id    VARCHAR(255) NOT NULL,
         secret_blob  TEXT         NOT NULL,
         callback_url VARCHAR(512) NOT NULL,
         scopes       VARCHAR(512) NOT NULL,
         updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS x_jobs (
         id            VARCHAR(36)  NOT NULL PRIMARY KEY,
         session_id    VARCHAR(64)  NOT NULL,
         ca            VARCHAR(128) NOT NULL,
         chain         VARCHAR(32)  NULL,
         tone          VARCHAR(16)  NOT NULL,
         language      VARCHAR(8)   NOT NULL,
         with_hashtags TINYINT(1)   NOT NULL DEFAULT 0,
         interval_sec  INT          NOT NULL,
         remaining     INT          NOT NULL,
         total         INT          NOT NULL,
         status        ENUM('active','paused','done') NOT NULL DEFAULT 'active',
         next_run      DATETIME     NOT NULL,
         last_post_url VARCHAR(255) NULL,
         last_error    VARCHAR(300) NULL,
         created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
         updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         INDEX idx_due (status, next_run),
         INDEX idx_session (session_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    console.log("[x/store] tables ready ✓");
  } catch (e: any) {
    console.error(
      `[x/store] table setup failed (${e?.code ?? "?"}): ${e?.sqlMessage ?? e?.message}. ` +
        `If the DB user lacks CREATE rights, run schema.sql manually.`,
    );
    throw e;
  }
}

// Run a DB op with contextual logging. Logs the MySQL error code + message so you
// can see exactly which operation failed and why, then rethrows for the caller.
async function withConn<T>(
  label: string,
  fn: (pool: mysql.Pool) => Promise<T>,
): Promise<T> {
  let pool: mysql.Pool;
  try {
    pool = await getPool();
  } catch (e: any) {
    console.error(
      `[x/store] connection failed (${label}) [${e?.code ?? "?"}]: ${e?.sqlMessage ?? e?.message ?? e}`,
    );
    throw e;
  }
  try {
    return await fn(pool);
  } catch (e: any) {
    console.error(
      `[x/store] query failed (${label}) [${e?.code ?? "?"}]: ${e?.sqlMessage ?? e?.message ?? e}`,
    );
    throw e;
  }
}

// Optional explicit connectivity check (e.g. for a health route).
export async function pingDb(): Promise<void> {
  await getPool();
}

interface Row {
  username: string;
  user_id: string;
  token_blob: string;
}

// ---------- token records ----------
export async function saveTokens(
  sid: string,
  username: string,
  userId: string,
  tokens: TokenSet,
): Promise<void> {
  await withConn("saveTokens", async (pool) => {
    const blob = encrypt(JSON.stringify(tokens));
    await pool.execute(
      `INSERT INTO x_tokens (session_id, username, user_id, token_blob)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE username = VALUES(username), user_id = VALUES(user_id), token_blob = VALUES(token_blob)`,
      [sid, username, userId, blob],
    );
  });
}

export async function loadTokens(
  sid: string,
): Promise<{ username: string; userId: string; tokens: TokenSet } | null> {
  return withConn("loadTokens", async (pool) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT username, user_id, token_blob FROM x_tokens WHERE session_id = ? LIMIT 1`,
      [sid],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    try {
      return {
        username: row.username,
        userId: row.user_id,
        tokens: JSON.parse(decrypt(row.token_blob)) as TokenSet,
      };
    } catch {
      console.error(
        "[x/store] token decrypt failed (key rotated/tampered) — dropping record",
      );
      await clearTokens(sid);
      return null;
    }
  });
}

export async function clearTokens(sid: string): Promise<void> {
  await withConn("clearTokens", (pool) =>
    pool
      .execute(`DELETE FROM x_tokens WHERE session_id = ?`, [sid])
      .then(() => {}),
  );
}

// ---------- per-user X app credentials ----------
export interface XAppConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: string;
}

export async function saveConfig(sid: string, c: XAppConfig): Promise<void> {
  await withConn("saveConfig", async (pool) => {
    await pool.execute(
      `INSERT INTO x_app_config (session_id, client_id, secret_blob, callback_url, scopes)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE client_id = VALUES(client_id), secret_blob = VALUES(secret_blob),
         callback_url = VALUES(callback_url), scopes = VALUES(scopes)`,
      [sid, c.clientId, encrypt(c.clientSecret), c.callbackUrl, c.scopes],
    );
  });
}

export async function loadConfig(sid: string): Promise<XAppConfig | null> {
  return withConn("loadConfig", async (pool) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT client_id, secret_blob, callback_url, scopes FROM x_app_config WHERE session_id = ? LIMIT 1`,
      [sid],
    );
    const row = rows[0] as
      | {
          client_id: string;
          secret_blob: string;
          callback_url: string;
          scopes: string;
        }
      | undefined;
    if (!row) return null;
    try {
      return {
        clientId: row.client_id,
        clientSecret: decrypt(row.secret_blob),
        callbackUrl: row.callback_url,
        scopes: row.scopes,
      };
    } catch {
      console.error("[x/store] config secret decrypt failed — dropping record");
      await clearConfig(sid);
      return null;
    }
  });
}

export async function loadPublicConfig(
  sid: string,
): Promise<{ clientId: string; callbackUrl: string; scopes: string } | null> {
  const cfg = await loadConfig(sid);
  if (!cfg) return null;
  return {
    clientId: cfg.clientId,
    callbackUrl: cfg.callbackUrl,
    scopes: cfg.scopes,
  };
}

export async function clearConfig(sid: string): Promise<void> {
  await withConn("clearConfig", (pool) =>
    pool
      .execute(`DELETE FROM x_app_config WHERE session_id = ?`, [sid])
      .then(() => {}),
  );
}

// ---------- Mode 2: scheduled jobs ----------
export type JobStatus = "active" | "paused" | "done";
export interface Job {
  id: string;
  sessionId: string;
  ca: string;
  chain: string | null;
  tone: string;
  language: string;
  withHashtags: boolean;
  intervalSec: number;
  remaining: number;
  total: number;
  status: JobStatus;
  nextRun: string;
  lastPostUrl: string | null;
  lastError: string | null;
}

function mapJob(r: any): Job {
  return {
    id: r.id,
    sessionId: r.session_id,
    ca: r.ca,
    chain: r.chain,
    tone: r.tone,
    language: r.language,
    withHashtags: !!r.with_hashtags,
    intervalSec: r.interval_sec,
    remaining: r.remaining,
    total: r.total,
    status: r.status,
    nextRun: new Date(r.next_run).toISOString(),
    lastPostUrl: r.last_post_url,
    lastError: r.last_error,
  };
}

export interface NewJob {
  sid: string;
  ca: string;
  chain: string | null;
  tone: string;
  language: string;
  withHashtags: boolean;
  intervalSec: number;
  total: number;
}

export async function createJob(j: NewJob): Promise<string> {
  return withConn("createJob", async (pool) => {
    const id = crypto.randomUUID();
    await pool.execute(
      `INSERT INTO x_jobs (id, session_id, ca, chain, tone, language, with_hashtags, interval_sec, remaining, total, status, next_run)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'active', UTC_TIMESTAMP())`,
      [
        id,
        j.sid,
        j.ca,
        j.chain,
        j.tone,
        j.language,
        j.withHashtags ? 1 : 0,
        j.intervalSec,
        j.total,
        j.total,
      ],
    );
    return id;
  });
}

export async function listJobs(sid: string): Promise<Job[]> {
  return withConn("listJobs", async (pool) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT * FROM x_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT 50`,
      [sid],
    );
    return rows.map(mapJob);
  });
}

export async function getDueJobs(limit = 20): Promise<Job[]> {
  return withConn("getDueJobs", async (pool) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT * FROM x_jobs WHERE status = 'active' AND next_run <= UTC_TIMESTAMP() ORDER BY next_run ASC LIMIT ${Number(limit)}`,
    );
    return rows.map(mapJob);
  });
}

export async function completeRun(
  id: string,
  intervalSec: number,
  postUrl: string,
): Promise<void> {
  await withConn("completeRun", (pool) =>
    pool
      .execute(
        `UPDATE x_jobs
           SET remaining = remaining - 1, last_post_url = ?, last_error = NULL,
               status   = IF(remaining - 1 <= 0, 'done', 'active'),
               next_run = IF(remaining - 1 <= 0, next_run, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND))
         WHERE id = ?`,
        [postUrl, intervalSec, id],
      )
      .then(() => {}),
  );
}

export async function failJob(id: string, err: string): Promise<void> {
  await withConn("failJob", (pool) =>
    pool
      .execute(
        `UPDATE x_jobs SET status = 'paused', last_error = ? WHERE id = ?`,
        [err.slice(0, 300), id],
      )
      .then(() => {}),
  );
}

export async function setJobStatus(
  id: string,
  sid: string,
  status: "active" | "paused",
): Promise<boolean> {
  return withConn("setJobStatus", async (pool) => {
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      `UPDATE x_jobs
         SET status = ?, next_run = IF(? = 'active', UTC_TIMESTAMP(), next_run), last_error = IF(? = 'active', NULL, last_error)
       WHERE id = ? AND session_id = ? AND status <> 'done'`,
      [status, status, status, id, sid],
    );
    return res.affectedRows > 0;
  });
}

export async function deleteJob(id: string, sid: string): Promise<boolean> {
  return withConn("deleteJob", async (pool) => {
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      `DELETE FROM x_jobs WHERE id = ? AND session_id = ?`,
      [id, sid],
    );
    return res.affectedRows > 0;
  });
}

// ---------- transient OAuth flow state (in-memory, 10 min TTL) ----------
interface Flow {
  state: string;
  verifier: string;
  at: number;
}
const flows = new Map<string, Flow>();
const FLOW_TTL = 10 * 60_000;

export function setFlow(sid: string, state: string, verifier: string): void {
  flows.set(sid, { state, verifier, at: Date.now() });
}
export function takeFlow(sid: string, state: string): string | null {
  const f = flows.get(sid);
  flows.delete(sid);
  if (!f || Date.now() - f.at > FLOW_TTL) return null;
  if (f.state !== state) return null;
  return f.verifier;
}
