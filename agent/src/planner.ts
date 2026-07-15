// investing planner — turns a plain-language goal into a diversified basket of Sherwood's
// tokenized stocks, grounded in LIVE on-chain data. Think Robinhood's "Vera": "I want AI
// exposure, $100, play it safe" -> a basket (QQQ 50 / NVDA 20 / GOOGL 15 / SPY 15) each with a
// $ amount, a one-sentence plain-language rationale, and a risk label.
//
// Two engines behind one contract:
//   • buildPlan()  — asks the Virtuals EconomyOS Compute LLM (callCompute) then VALIDATES/REPAIRS.
//   • ruleBasedPlan() — deterministic, NO LLM, ALWAYS returns a valid Plan (works with no API key).
// Liquidity gating uses quote.ts v4Liquidity so the planner never allocates a big clip into a
// pool too thin to absorb it. executePlan() funds each leg ETH->token via the AggRouter (quote.ts /
// sherwood-exec.ts), DRY-RUN unless send:true.
import { setDefaultResultOrder } from "node:dns";
import net from "node:net";
// This machine's resolver hands back a broken NAT64 IPv6 for sherwood.spot alongside the real IPv4
// (158.220.120.179). Prefer v4 AND disable happy-eyeballs family racing, or node fetch/viem RPC
// intermittently hangs on the dead IPv6. (quote.ts also sets ipv4first; the autoselect toggle is the
// piece that makes it deterministic.)
setDefaultResultOrder("ipv4first");
(net as any).setDefaultAutoSelectFamily?.(false);

import { formatEther, parseUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { STOCKS, v4Liquidity, resolveToken, quotePublic, USDG } from "./quote.js";
import { executeSwap } from "./sherwood-exec.js";

// ---- shared Plan JSON contract (the web frontend consumes this EXACT shape) ----
export type RiskTier = "cautious" | "balanced" | "bold";
export type Category = "AI" | "Tech" | "Chips" | "Index" | "Commodity" | "Other";
export interface Holding {
  symbol: string; address: string; category: Category;
  allocPct: number; usd: number; rationale: string;
}
export interface Plan {
  goal: string; budgetUsd: number; riskTier: RiskTier;
  holdings: Holding[];
  risk: { label: "Cautious" | "Balanced" | "Bold"; note: string };
  disclaimer: string;
}
export interface UniverseItem { symbol: string; address: Address; name: string; category: Category; fee: number; ts: number; }
export interface UniverseLive extends UniverseItem { liquidity: "deep" | "medium" | "thin"; }

export const DISCLAIMER = "Not financial advice. Prices move; only invest what you can leave for a while.";

// ---- the tradable universe: STOCKS (quote.ts, source of truth) enriched with name + category ----
const META: Record<string, { name: string; category: Category }> = {
  AAPL:  { name: "Apple",                 category: "Tech" },
  TSLA:  { name: "Tesla",                 category: "Tech" },
  NVDA:  { name: "NVIDIA",                category: "Chips" },
  AMD:   { name: "AMD",                   category: "Chips" },
  SPCX:  { name: "SpaceX",                category: "Other" },
  GOOGL: { name: "Alphabet (Google)",     category: "Tech" },
  AMZN:  { name: "Amazon",                category: "Tech" },
  APLD:  { name: "Applied Digital",       category: "AI" },
  COIN:  { name: "Coinbase",              category: "Other" },
  CRWV:  { name: "CoreWeave",             category: "AI" },
  F:     { name: "Ford Motor",            category: "Other" },
  GME:   { name: "GameStop",              category: "Other" },
  INTC:  { name: "Intel",                 category: "Chips" },
  MU:    { name: "Micron Technology",     category: "Chips" },
  NU:    { name: "Nu Holdings",           category: "Other" },
  ORCL:  { name: "Oracle",                category: "Tech" },
  PLTR:  { name: "Palantir Technologies", category: "AI" },
  QQQ:   { name: "Nasdaq-100",            category: "Index" },
  RKLB:  { name: "Rocket Lab",            category: "Other" },
  SLV:   { name: "Silver",                category: "Commodity" },
  SPY:   { name: "S&P 500",               category: "Index" },
  CRCL:  { name: "Circle Internet Group", category: "Other" },
  SNDK:  { name: "Sandisk",               category: "Chips" },
};

/** The tradable universe — 23 tokenized stocks with display name + category, keyed off quote.ts STOCKS. */
export const UNIVERSE: UniverseItem[] = STOCKS.map((s) => ({
  symbol: s.symbol, address: s.address, fee: s.fee, ts: s.ts,
  name: META[s.symbol]?.name ?? s.symbol, category: META[s.symbol]?.category ?? "Other",
}));
const BY_SYM: Record<string, UniverseItem> = Object.fromEntries(UNIVERSE.map((u) => [u.symbol, u]));

// one-sentence, factual rationales — no hype, no price predictions, no guarantees.
const RATIONALE: Record<string, string> = {
  QQQ:   "Tracks the Nasdaq-100, spreading exposure across the largest US tech companies in one holding.",
  SPY:   "Tracks the S&P 500, giving broad exposure to large US companies in a single holding.",
  SLV:   "Follows the price of silver, which often moves differently from stocks.",
  NVDA:  "Designs the GPUs widely used to train and run AI models.",
  AMD:   "Makes CPUs and GPUs that compete in data-center and AI compute.",
  GOOGL: "Alphabet runs Google Search, YouTube and cloud, with large AI research efforts.",
  AAPL:  "Apple sells iPhones and services to a large global customer base.",
  AMZN:  "Amazon operates online retail and AWS, a leading cloud platform.",
  TSLA:  "Tesla makes electric vehicles and energy-storage products.",
  PLTR:  "Palantir sells data-analytics and AI software to governments and enterprises.",
  CRWV:  "CoreWeave rents out GPU cloud capacity used for AI workloads.",
  APLD:  "Applied Digital builds and operates data centers for high-performance and AI computing.",
  ORCL:  "Oracle provides enterprise databases and a growing cloud-infrastructure business.",
  MU:    "Micron makes the memory and storage chips used across computing and AI hardware.",
  INTC:  "Intel designs and manufactures CPUs and is expanding its chip-foundry business.",
  SPCX:  "Tracks SpaceX, a private company building rockets and the Starlink network.",
  RKLB:  "Rocket Lab builds small launch vehicles and spacecraft components.",
  COIN:  "Coinbase operates a large US cryptocurrency exchange.",
  CRCL:  "Circle issues the USDC stablecoin and related payment infrastructure.",
  F:     "Ford makes trucks, cars and commercial vehicles.",
  GME:   "GameStop is a video-game and consumer-electronics retailer.",
  NU:    "Nu Holdings runs a digital bank serving customers across Latin America.",
  SNDK:  "Sandisk makes flash-memory storage products.",
};
const rationaleFor = (sym: string) =>
  RATIONALE[sym] ?? `${BY_SYM[sym]?.name ?? sym} is one of Sherwood's tokenized ${(BY_SYM[sym]?.category ?? "Other").toLowerCase()} stocks.`;

// ---- live liquidity tier (raw v4 L units) — same scale as economyos.ts liquidityCheck ----
const L_DEEP = 10n ** 17n, L_MED = 10n ** 14n;
const lClass = (l: bigint): "deep" | "medium" | "thin" => (l >= L_DEEP ? "deep" : l >= L_MED ? "medium" : "thin");
const THIN_MAX_USD = 25; // a "thin" pool can only absorb a small clip before price impact bites

/** UNIVERSE annotated with a LIVE v4 native-ETH liquidity tier (deep/medium/thin). */
export async function getUniverse(): Promise<UniverseLive[]> {
  // one retry per pool — the RPC can flake; a read failure defaults to "medium" (usable, not gated out).
  const readL = (u: UniverseItem) => v4Liquidity(u.address, u.fee, u.ts).catch(() => v4Liquidity(u.address, u.fee, u.ts));
  const liq = await Promise.all(UNIVERSE.map((u) => readL(u).catch(() => null)));
  return UNIVERSE.map((u, i) => ({ ...u, liquidity: liq[i] === null ? "medium" : lClass(liq[i]!) }));
}

// ---- Virtuals EconomyOS Compute (OpenAI-compatible) ----
const COMPUTE_URL = "https://compute.virtuals.io/v1/chat/completions";
const DEFAULT_MODEL = process.env.PLAN_MODEL || "anthropic-claude-sonnet-5";

/** POST to Virtuals Compute. Throws if VIRTUALS_API_KEY is unset, or on error/timeout (25s) — so
 * buildPlan falls back to the deterministic rule-based planner. (10s proved too tight in prod:
 * Compute + Sonnet routinely exceeded it, silently downgrading WOODIE to the regex parser.) */
export async function callCompute(messages: Array<{ role: string; content: string }>, model = DEFAULT_MODEL): Promise<string> {
  const key = process.env.VIRTUALS_API_KEY;
  if (!key) throw new Error("VIRTUALS_API_KEY unset — using rule-based planner");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const r = await fetch(COMPUTE_URL, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature: 0.4 }),
    });
    if (!r.ok) throw new Error(`compute ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const content = j?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") throw new Error("compute returned no content");
    return content;
  } finally { clearTimeout(t); }
}

// ---- allocation math ----
/** Normalize positive weights to integer percentages summing to exactly 100 (largest-remainder). */
function normalizePct(pcts: number[]): number[] {
  const sum = pcts.reduce((a, b) => a + b, 0) || 1;
  const scaled = pcts.map((p) => (Math.max(0, p) / sum) * 100);
  const floor = scaled.map(Math.floor);
  let rem = 100 - floor.reduce((a, b) => a + b, 0);
  const order = scaled.map((s, i) => ({ i, f: s - floor[i] })).sort((a, b) => b.f - a.f);
  for (let k = 0; k < rem && order.length; k++) floor[order[k % order.length].i]++;
  return floor;
}

/** Turn raw picks (symbol + weight [+ rationale]) into a validated, liquidity-gated holdings[]. */
function buildHoldings(
  picks: Array<{ symbol: string; pct: number; rationale?: string }>,
  budgetUsd: number,
  tier: Record<string, "deep" | "medium" | "thin">,
): Holding[] {
  // 1) keep known symbols, dedupe (first wins), drop non-positive weights
  const seen = new Set<string>();
  let rows = picks
    .map((p) => ({ symbol: String(p.symbol || "").toUpperCase().trim(), pct: Number(p.pct), rationale: p.rationale }))
    .filter((p) => BY_SYM[p.symbol] && p.pct > 0 && !seen.has(p.symbol) && seen.add(p.symbol));
  // 2) clamp to <=6 (largest weights)
  rows = rows.sort((a, b) => b.pct - a.pct).slice(0, 6);
  if (!rows.length) return [];
  // 3) provisional normalize -> provisional usd, then drop THIN pools that a big clip would move
  let pct = normalizePct(rows.map((r) => r.pct));
  rows = rows.filter((r, i) => !(tier[r.symbol] === "thin" && Math.round((budgetUsd * pct[i]) / 100) > THIN_MAX_USD));
  if (!rows.length) return [];
  // 4) final normalize (drop any that rounded to 0%, renormalize once more)
  pct = normalizePct(rows.map((r) => r.pct));
  rows = rows.filter((_, i) => pct[i] > 0);
  pct = normalizePct(rows.map((r) => r.pct));
  // 5) materialize holdings from UNIVERSE
  return rows.map((r, i) => {
    const u = BY_SYM[r.symbol];
    const rat = (r.rationale && r.rationale.trim().length > 4 && r.rationale.length <= 240) ? r.rationale.trim() : rationaleFor(r.symbol);
    return { symbol: u.symbol, address: u.address, category: u.category, allocPct: pct[i], usd: Math.round((budgetUsd * pct[i]) / 100), rationale: rat };
  });
}

const RISK_NOTE: Record<RiskTier, string> = {
  cautious: "Weighted toward broad index funds to keep swings smaller, though value can still fall.",
  balanced: "A mix of broad funds and individual names, so expect moderate ups and downs.",
  bold:     "Concentrated in a few higher-growth names, which can swing sharply in both directions.",
};
const RISK_LABEL: Record<RiskTier, "Cautious" | "Balanced" | "Bold"> = { cautious: "Cautious", balanced: "Balanced", bold: "Bold" };

function assemblePlan(goal: string, budgetUsd: number, riskTier: RiskTier, holdings: Holding[]): Plan {
  return { goal, budgetUsd, riskTier, holdings, risk: { label: RISK_LABEL[riskTier], note: RISK_NOTE[riskTier] }, disclaimer: DISCLAIMER };
}

// ---- deterministic fallback (no LLM) ----
type Tpl = Array<{ symbol: string; pct: number }>;
const TEMPLATES: Record<string, Record<RiskTier, Tpl>> = {
  ai: {
    cautious: [{ symbol: "SPY", pct: 40 }, { symbol: "QQQ", pct: 30 }, { symbol: "NVDA", pct: 15 }, { symbol: "GOOGL", pct: 15 }],
    balanced: [{ symbol: "QQQ", pct: 40 }, { symbol: "NVDA", pct: 25 }, { symbol: "GOOGL", pct: 20 }, { symbol: "SPY", pct: 15 }],
    bold:     [{ symbol: "NVDA", pct: 40 }, { symbol: "PLTR", pct: 25 }, { symbol: "GOOGL", pct: 20 }, { symbol: "AMD", pct: 15 }],
  },
  tech: {
    cautious: [{ symbol: "SPY", pct: 40 }, { symbol: "QQQ", pct: 30 }, { symbol: "AAPL", pct: 15 }, { symbol: "GOOGL", pct: 15 }],
    balanced: [{ symbol: "QQQ", pct: 35 }, { symbol: "AAPL", pct: 25 }, { symbol: "GOOGL", pct: 20 }, { symbol: "AMZN", pct: 20 }],
    bold:     [{ symbol: "AAPL", pct: 30 }, { symbol: "GOOGL", pct: 25 }, { symbol: "AMZN", pct: 25 }, { symbol: "ORCL", pct: 20 }],
  },
  chip: {
    cautious: [{ symbol: "SPY", pct: 40 }, { symbol: "QQQ", pct: 25 }, { symbol: "NVDA", pct: 20 }, { symbol: "AMD", pct: 15 }],
    balanced: [{ symbol: "NVDA", pct: 35 }, { symbol: "AMD", pct: 25 }, { symbol: "MU", pct: 20 }, { symbol: "QQQ", pct: 20 }],
    bold:     [{ symbol: "NVDA", pct: 40 }, { symbol: "AMD", pct: 30 }, { symbol: "MU", pct: 20 }, { symbol: "INTC", pct: 10 }],
  },
  index: {
    cautious: [{ symbol: "SPY", pct: 60 }, { symbol: "QQQ", pct: 40 }],
    balanced: [{ symbol: "SPY", pct: 50 }, { symbol: "QQQ", pct: 35 }, { symbol: "SLV", pct: 15 }],
    bold:     [{ symbol: "QQQ", pct: 55 }, { symbol: "SPY", pct: 45 }],
  },
  space: {
    cautious: [{ symbol: "SPY", pct: 45 }, { symbol: "QQQ", pct: 25 }, { symbol: "RKLB", pct: 15 }, { symbol: "SPCX", pct: 15 }],
    balanced: [{ symbol: "RKLB", pct: 35 }, { symbol: "SPCX", pct: 30 }, { symbol: "QQQ", pct: 20 }, { symbol: "SPY", pct: 15 }],
    bold:     [{ symbol: "SPCX", pct: 45 }, { symbol: "RKLB", pct: 40 }, { symbol: "QQQ", pct: 15 }],
  },
  broad: {
    cautious: [{ symbol: "SPY", pct: 50 }, { symbol: "QQQ", pct: 30 }, { symbol: "SLV", pct: 20 }],
    balanced: [{ symbol: "SPY", pct: 45 }, { symbol: "QQQ", pct: 35 }, { symbol: "SLV", pct: 20 }],
    bold:     [{ symbol: "QQQ", pct: 45 }, { symbol: "SPY", pct: 35 }, { symbol: "NVDA", pct: 20 }],
  },
  default: {
    cautious: [{ symbol: "SPY", pct: 50 }, { symbol: "QQQ", pct: 30 }, { symbol: "SLV", pct: 20 }],
    balanced: [{ symbol: "QQQ", pct: 40 }, { symbol: "SPY", pct: 30 }, { symbol: "NVDA", pct: 15 }, { symbol: "GOOGL", pct: 15 }],
    bold:     [{ symbol: "NVDA", pct: 35 }, { symbol: "QQQ", pct: 25 }, { symbol: "GOOGL", pct: 20 }, { symbol: "PLTR", pct: 20 }],
  },
};

/** Keyword-match the goal to a theme. "safe" is a modifier, not a theme — it nudges toward broad. */
function themeFor(goal: string): keyof typeof TEMPLATES {
  const g = goal.toLowerCase();
  if (/\bchip|semis?|semiconductor|gpu\b/.test(g)) return "chip";
  if (/\bai\b|artificial intelligence|machine learning/.test(g)) return "ai";
  if (/space|rocket|launch|satellite|mars/.test(g)) return "space";
  if (/index|s&p|nasdaq|etf|whole market/.test(g)) return "index";
  if (/tech|software|cloud/.test(g)) return "tech";
  if (/safe|broad|diversif|whole market|market|conservative|steady/.test(g)) return "broad";
  return "default";
}

/** Deterministic planner — NO LLM, ALWAYS returns a valid Plan. */
export function ruleBasedPlan(o: { goal: string; budgetUsd: number; riskTier: RiskTier }): Plan {
  const theme = themeFor(o.goal);
  const tpl = TEMPLATES[theme][o.riskTier] ?? TEMPLATES.default[o.riskTier];
  // template picks are all liquid by construction, so no live gating is needed here.
  const holdings = buildHoldings(tpl.map((p) => ({ ...p })), o.budgetUsd, {});
  return assemblePlan(o.goal.trim(), o.budgetUsd, o.riskTier, holdings);
}

// ---- LLM-backed planner ----
function planPrompt(goal: string, budgetUsd: number, riskTier: RiskTier, uni: UniverseLive[]): Array<{ role: string; content: string }> {
  const rows = uni.map((u) => `${u.symbol} | ${u.name} | ${u.category} | ${u.liquidity}`).join("\n");
  const system =
    "You are Sherwood's investing planner. Turn the user's goal into a diversified basket of Sherwood's " +
    "tokenized stocks. Respond with ONLY a JSON object, no prose, no markdown fences, in this EXACT shape:\n" +
    '{"holdings":[{"symbol":"NVDA","allocPct":40,"rationale":"one factual sentence"}]}\n\n' +
    "LIVE tradable universe (symbol | name | category | liquidity tier):\n" + rows + "\n\n" +
    "RULES:\n" +
    "- Use ONLY symbols from the list above. allocPct are integers that sum to exactly 100.\n" +
    "- At most 6 holdings. Avoid symbols whose liquidity tier is 'thin' for larger dollar amounts.\n" +
    "- cautious = more index/broad funds (SPY, QQQ) and fewer individual names; bold = more concentrated, " +
    "growth/AI-tilted. balanced sits between.\n" +
    "- Each rationale is ONE plain-language, factual sentence. NO hype, NO price predictions, NO guarantees.\n";
  const user = `Goal: ${goal}\nBudget: $${budgetUsd}\nRisk: ${riskTier}\nReturn ONLY the JSON.`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function parseHoldings(raw: string): Array<{ symbol: string; pct: number; rationale?: string }> {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in LLM output");
  const obj = JSON.parse(raw.slice(a, b + 1));
  const arr = Array.isArray(obj) ? obj : obj.holdings ?? obj.basket ?? obj.plan;
  if (!Array.isArray(arr)) throw new Error("no holdings array in LLM output");
  return arr.map((h: any) => ({ symbol: h.symbol ?? h.ticker ?? h.sym, pct: Number(h.allocPct ?? h.pct ?? h.weight ?? h.percent), rationale: h.rationale ?? h.reason }));
}

/** Build a Plan: try the LLM (callCompute) + validate/repair; fall back to ruleBasedPlan on any failure. */
export async function buildPlan(o: { goal: string; budgetUsd: number; riskTier: RiskTier }): Promise<Plan> {
  const goal = o.goal.trim();
  const uni = await getUniverse();
  const tier = Object.fromEntries(uni.map((u) => [u.symbol, u.liquidity])) as Record<string, "deep" | "medium" | "thin">;
  try {
    const raw = await callCompute(planPrompt(goal, o.budgetUsd, o.riskTier, uni));
    const holdings = buildHoldings(parseHoldings(raw), o.budgetUsd, tier);
    if (!holdings.length) throw new Error("LLM plan empty after validation");
    return assemblePlan(goal, o.budgetUsd, o.riskTier, holdings);
  } catch {
    return ruleBasedPlan({ goal, budgetUsd: o.budgetUsd, riskTier: o.riskTier });
  }
}

// ---- execution: fund each leg ETH -> token via the AggRouter (reuses sherwood-exec.ts) ----
export interface LegResult { symbol: string; status: string; txHash?: string; amountOut?: string; }
const DRYRUN_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

/** Execute a Plan: for each holding, quote how much ETH ~= its usd (via USDG) then swap ETH->token.
 * DRY-RUN unless send:true. If privateKey is given, that wallet is the recipient AND the broadcaster. */
export async function executePlan(plan: Plan, o: { privateKey?: string; send?: boolean }): Promise<LegResult[]> {
  let recipient = DRYRUN_RECIPIENT;
  if (o.privateKey) {
    const pk = (o.privateKey.startsWith("0x") ? o.privateKey : `0x${o.privateKey}`) as `0x${string}`;
    recipient = privateKeyToAccount(pk).address;
    process.env.EXEC_PRIVATE_KEY = pk; // sherwood-exec broadcasts from EXEC_PRIVATE_KEY
  }
  const [usdg, eth] = await Promise.all([resolveToken(USDG), resolveToken("ETH")]);
  const out: LegResult[] = [];
  for (const h of plan.holdings) {
    try {
      // price the dollar leg: how much ETH does h.usd of USDG buy?
      const ethRaw = await quotePublic(usdg, eth, parseUnits(String(h.usd), 6));
      if (!ethRaw || ethRaw <= 0n) throw new Error("could not price ETH for USD leg");
      const amount = formatEther(ethRaw);
      const r = await executeSwap({ inId: "ETH", outId: h.symbol, amount, recipient, slippagePct: 1, send: !!o.send });
      out.push({ symbol: h.symbol, status: o.send ? (r.swapTx ? "sent" : "submitted") : "dry-run", txHash: r.swapTx, amountOut: `${r.plan.expectedOut} ${h.symbol}` });
    } catch (e: any) {
      out.push({ symbol: h.symbol, status: `error: ${e?.message ?? e}` });
    }
  }
  return out;
}
