// gemini.ts
// Generate a promo post / reply grounded STRICTLY in real market data.
// Guardrails (intentional, do not remove):
//   - model may only use numbers we pass in (no invented price/partnership/roadmap)
//   - no guaranteed-return / financialized hype claims
//   - always appends a "Not financial advice. DYOR." disclaimer
// These keep output factual and reduce legal/ToS exposure.

import { GoogleGenAI } from "@google/genai";
import type { TokenMarket } from "./market.js";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

export type Tone =
  | "hype"
  | "degen"
  | "professional"
  | "ct"
  | "reply"
  | "analysis"
  | "risk";
export type Lang = "en" | "zh" | "ja" | "de";

export interface PostOptions {
  tone?: Tone;
  language?: Lang;
  withHashtags?: boolean; // true -> include relevant crypto/token hashtags
  replyTo?: string; // original tweet/post text (used when tone = "reply")
}

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

function fmtUsd(n: number | null): string {
  if (n == null || !isFinite(n) || n <= 0) return "n/a";
  if (n >= 1) return "$" + Math.round(n).toLocaleString("en-US");
  return "$" + n.toPrecision(4);
}

function ageString(epochMs: number): string {
  if (!epochMs) return "unknown";
  const h = (Date.now() - epochMs) / 3_600_000;
  if (h < 24) return `${Math.max(1, Math.round(h))}h old`;
  return `${Math.round(h / 24)}d old`;
}

// Per-tone voice guidance. Kept declarative so it's easy to tune.
const TONE_GUIDE: Record<Tone, string> = {
  hype: "Energetic and promotional, but grounded. Confident, not desperate.",
  degen:
    "Crypto-degen voice: casual, bold, a bit irreverent. Still no fake claims.",
  professional: "Measured, analytical, neutral. Reads like a market update.",
  ct: "Crypto Twitter (CT) native: punchy, lowercase-leaning, short lines. CT slang ok (gm, ser, anon, ape in, wagmi) used sparingly. Lead with the ticker.",
  reply:
    "A short REPLY/COMMENT to the post in REPLY_CONTEXT. React naturally to that post and tie in this token. Do NOT restate the whole post. 1-2 short sentences.",
  analysis:
    "Objective analyst voice. Break down what the on-chain numbers actually say (market cap/FDV, liquidity, 24h volume, buy/sell pressure, age). Neutral and factual — state observations, not hype or price predictions. No targets, no 'to the moon'.",
  risk: "Risk-assessment voice. Soberly flag the RISKS implied by the data: low liquidity, thin/again-st volume, lopsided buys vs sells, very new pair/age, concentration. Be cautionary and balanced, not fear-mongering and not promotional. Make clear these are observations, not advice.",
};

export async function generatePost(
  m: TokenMarket,
  opts: PostOptions = {},
): Promise<string> {
  const tone: Tone = opts.tone ?? "hype";
  const language: Lang = opts.language ?? "en";
  const withHashtags = opts.withHashtags ?? false;
  const replyTo = (opts.replyTo ?? "").trim();

  const facts = [
    `symbol: $${m.symbol}`,
    `name: ${m.name}`,
    `chain: ${m.chain}`,
    `price: ${fmtUsd(m.priceUsd)}`,
    `marketCap: ${fmtUsd(m.marketCap)}`,
    `FDV: ${fmtUsd(m.fdv)}`,
    `24h volume: ${fmtUsd(m.volume24h)}`,
    `liquidity: ${fmtUsd(m.liquidityUsd)}`,
    `24h change: ${m.priceChange24h.toFixed(1)}%`,
    `24h txns: ${m.txns24h.buys} buys / ${m.txns24h.sells} sells`,
    `pair age: ${ageString(m.pairCreatedAt)}`,
  ].join("\n");

  const hashtagRule = withHashtags
    ? `- Include 2-4 RELEVANT hashtags: the ticker (#${m.symbol}), the chain, and broad crypto tags (e.g. #crypto #DeFi #memecoin) only if they fit. No spammy hashtag walls.`
    : "- Do NOT use any hashtags.";

  const langName =
    language === "zh"
      ? "Chinese (简体中文)"
      : language === "ja"
        ? "Japanese (日本語)"
        : language === "de"
          ? "German (Deutsch)"
          : "English";

  const rules = [
    `OUTPUT LANGUAGE: Write the ENTIRE post in ${langName}. Every word must be in ${langName}, EXCEPT the token ticker ($${m.symbol}) and hashtags. This rule overrides all others.`,
    `You write content for X/Twitter about a crypto token. Voice: ${TONE_GUIDE[tone]}`,
    "HARD RULES:",
    "- Use ONLY the numbers in DATA. Never invent price, partnerships, exchange listings, roadmap, audits, or holder counts.",
    "- Never promise or imply guaranteed returns, 'x100', 'cannot lose', or price targets.",
    tone === "reply"
      ? "- Keep the whole reply UNDER 200 characters."
      : "- LENGTH LIMIT: the ENTIRE post — including hashtags AND the disclaimer — MUST be 280 characters or fewer. Aim for 200-260. NEVER exceed 280 characters total. If needed, drop hashtags or shorten wording to fit.",
    "- At most 3 emojis.",
    hashtagRule,
    `- End with a short "not financial advice / do your own research" disclaimer written in ${langName} (English 'NFA. DYOR.' is also acceptable).`,
  ].join("\n");

  const replyBlock =
    tone === "reply" && replyTo
      ? `\n\nREPLY_CONTEXT (the post you are replying to):\n"""${replyTo.slice(0, 600)}"""`
      : tone === "reply"
        ? "\n\n(No REPLY_CONTEXT provided — write a generic but natural reply that could fit a crypto post.)"
        : "";

  const res = await getClient().models.generateContent({
    model: MODEL,
    contents: `${rules}\n\nDATA:\n${facts}${replyBlock}\n\nWrite it now:`,
    config: {
      temperature:
        tone === "professional" || tone === "analysis" || tone === "risk"
          ? 0.55
          : 0.9,
      // 2.5-flash has thinking ON by default; thinking tokens eat maxOutputTokens
      // and truncate the post (cutting off hashtags + disclaimer). Disable it.
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 800,
    },
  });

  const text = (res.text ?? "").trim();
  if (!text) throw new Error("empty_generation");
  // Safety net: guarantee <= 280 chars so the X post never gets rejected.
  if (text.length > 280) {
    return (
      text
        .slice(0, 279)
        .replace(/\s+\S*$/, "")
        .trim() + "…"
    );
  }
  return text;
}
