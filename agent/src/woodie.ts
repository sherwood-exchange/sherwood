// WOODIE — Sherwood Exchange's conversational on-chain copilot. Turns a plain-language message
// into ONE structured Action that the web app executes with the user's own wallet. WOODIE does
// NOT build investment baskets and gives NO financial advice — it drives Sherwood's real
// operations: shield (deposit into the private pool), private transfer (to a shielded address),
// unshield (withdraw to a clear 0x address), shielded swap, plus routing to stake/bridge/
// public-swap/governance/points pages. Persona: precise, calm, "leave no trace".
//
// One engine, one contract:
//   • chat()      — asks the Virtuals Compute LLM (callCompute) then VALIDATES/REPAIRS the Action.
//   • ruleChat()  — deterministic regex fallback, NO LLM (works with no API key / on any error).
// The web frontend consumes the { say, action } shape EXACTLY (see SHARED ACTION CONTRACT).
import { callCompute, UNIVERSE } from "./planner.js";

// ---- shared Action contract (web executes this) ----
export type RouteTo = "stake" | "bridge" | "swap" | "govern" | "points";
export type Action =
  | { kind: "shield"; symbol: string; amount: string }
  | { kind: "private_transfer"; symbol: string; amount: string; to: string }
  | { kind: "unshield"; symbol: string; amount: string; to: string }
  | { kind: "shielded_swap"; symbolIn: string; symbolOut: string; amount: string }
  | { kind: "public_swap"; symbolIn: string; symbolOut: string; amount: string }
  | { kind: "portfolio" }
  | { kind: "quote"; symbolIn: string; symbolOut: string; amount: string }
  | { kind: "bridge_quote"; amount: string; chain: string }
  | { kind: "xchain_quote"; symbol: string; amount: string }
  | { kind: "xchain_out"; symbol: string; amount: string }
  | { kind: "universe" }
  | { kind: "route"; to: RouteTo; note?: string }
  | { kind: "answer" }
  | { kind: "clarify" };
export interface Reply { say: string; action?: Action }
/** One prior chat turn; `kind` is the action kind WOODIE answered with (lets the fallback see clarifies). */
export interface ChatTurn { role: "user" | "woodie"; text: string; kind?: string }
export interface ChatCtx { shielded?: string[]; history?: ChatTurn[] }

// ---- the live token universe (symbols only) — ETH, USDG, SWOOD + the 5 curated meme tokens +
// the 23 tokenized stocks. Mirrors the Sherwood allowlist (web/app/src/config.ts), so WOODIE
// quotes/shields exactly what the pool + aggregator actually support (the raw chain tokenlist has
// hundreds of ambiguous look-alikes — we deliberately do NOT open the universe to those). ----
const MEME: string[] = ["CASHCAT", "JUGGERNAUT", "HOODRAT", "VIRTUAL", "VEX"];
export const TOKENS: string[] = ["ETH", "USDG", "SWOOD", ...MEME, ...UNIVERSE.map((u) => u.symbol)];
const TOKEN_SET = new Set(TOKENS);
// a few forgiving aliases so "eth"/"ether"/"usdc"/"apple" resolve to a live symbol.
const ALIAS: Record<string, string> = {
  ETHER: "ETH", WETH: "ETH", USDC: "USDG", USD: "USDG", DOLLAR: "USDG", DOLLARS: "USDG",
  GUSD: "USDG", SHERWOOD: "SWOOD", APPLE: "AAPL", TESLA: "TSLA", NVIDIA: "NVDA", GOOGLE: "GOOGL",
  ALPHABET: "GOOGL", AMAZON: "AMZN", SILVER: "SLV", NASDAQ: "QQQ", SP500: "SPY",
};
/** Resolve a loose token word to a live symbol, or null if it isn't in the universe. */
function resolveSym(s: unknown): string | null {
  const k = String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
  if (!k) return null;
  if (TOKEN_SET.has(k)) return k;
  if (ALIAS[k] && TOKEN_SET.has(ALIAS[k])) return ALIAS[k];
  return null;
}
/** A positive human amount string ("0.01") or null. */
function cleanAmount(a: unknown): string | null {
  const s = String(a ?? "").replace(/[, _]/g, "").trim();
  if (!/^\d*\.?\d+$/.test(s)) return null;
  return Number(s) > 0 ? s : null;
}
const is0x = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
const ROUTES: RouteTo[] = ["stake", "bridge", "swap", "govern", "points"];

// ================================ LLM engine ================================
function systemPrompt(): string {
  return (
    "You are WOODIE, Sherwood Exchange's on-chain copilot. You DO NOT build investment baskets and " +
    "you give NO financial advice, price predictions, or guarantees. You NEVER invent balances or " +
    "numbers. Persona: precise, calm, discreet — 'leave no trace'. You turn the user's message into " +
    "exactly ONE structured action that the app executes with the user's own wallet.\n\n" +
    "Respond with ONLY a JSON object (no prose, no markdown fences) in this EXACT shape:\n" +
    '{"say":"one short line to the user","action":{...}}\n\n' +
    "Token universe (use ONLY these symbols): " + TOKENS.join(", ") + "\n\n" +
    "ACTION KINDS (pick ONE; amounts are human strings like \"0.01\"):\n" +
    '  {"kind":"shield","symbol":"ETH","amount":"0.01"}                 — deposit wallet funds into the private pool\n' +
    '  {"kind":"private_transfer","symbol":"USDG","amount":"100","to":"<shielded address>"} — private transfer to a Sherwood shielded address\n' +
    '  {"kind":"unshield","symbol":"USDG","amount":"50","to":"0x…"}      — withdraw to a clear 0x address\n' +
    '  {"kind":"shielded_swap","symbolIn":"ETH","symbolOut":"AAPL","amount":"0.005"} — private swap inside the pool\n' +
    '  {"kind":"public_swap","symbolIn":"ETH","symbolOut":"USDG","amount":"1"}       — ordinary on-chain swap (NOT private) via the public aggregator\n' +
    '  {"kind":"portfolio"}                                             — user asks to see their balances\n' +
    '  {"kind":"quote","symbolIn":"ETH","symbolOut":"USDG","amount":"1"} — price a swap without executing\n' +
    '  {"kind":"bridge_quote","amount":"0.05","chain":"base"}            — price bridging ETH out of Robinhood Chain to another chain (amount is ETH)\n' +
    '  {"kind":"xchain_quote","symbol":"BTC","amount":"0.01"}            — price bringing an OUTSIDE asset (BTC, XMR, SOL, LTC, DOGE, USDT) into Sherwood via the private cross-chain route\n' +
    '  {"kind":"xchain_out","symbol":"XMR","amount":"0.1"}               — price cashing OUT of Sherwood: amount is ETH (on Base) leaving, symbol is the outside asset received (BTC/XMR/SOL/LTC/DOGE/USDT)\n' +
    '  {"kind":"universe"}                                               — user asks what they can trade/shield here (token list + live liquidity)\n' +
    '  {"kind":"route","to":"stake|bridge|swap|govern|points","note":"why"} — deep-link a page; do NOT execute here\n' +
    '  {"kind":"answer"}                                                — greeting / "what can you do" / how-it-works / explain\n' +
    '  {"kind":"clarify"}                                               — a required detail is missing; ask for it in say\n\n' +
    "RULES:\n" +
    "- Resolve every token to a symbol from the universe. If a token isn't in the universe, use clarify.\n" +
    "- If a required field is missing (amount, token, destination), use kind 'clarify' and ask for it in 'say'.\n" +
    "- EXCEPTION for prices/quotes: 'check <TOKEN> price', 'quote X-Y', 'price of AAPL' etc. → ALWAYS use kind 'quote', " +
    "never clarify. If no amount is given, use amount \"1\". If only one token is named, price it against USDG " +
    "(so 'check AAPL price' → quote {symbolIn:\"AAPL\",symbolOut:\"USDG\",amount:\"1\"}). Match 'say' to the action.\n" +
    "- CONVERSATION: earlier turns may be included. If your previous turn asked a clarifying question, " +
    "treat the user's new message as the missing detail and emit the now-complete action. Pronouns like " +
    "'it'/'that one' refer to the token or amount discussed in the previous turns.\n" +
    "- 'Bridge 0.05 ETH to Base', 'what does it cost to move ETH to Arbitrum' → bridge_quote (chain is the " +
    "destination name; amount defaults to \"0.1\" if unstated). Executing a bridge still goes through route(bridge).\n" +
    "- 'bring in 0.01 BTC privately', 'on-ramp monero', 'deposit SOL from solana' → xchain_quote with the OUTSIDE " +
    "symbol (BTC/XMR/SOL/LTC/DOGE/USDT — these live on other chains, NOT in the token universe above). " +
    "Amount defaults to \"1\" (\"0.01\" for BTC). The Bridge page executes it.\n" +
    "- 'cash out 0.1 ETH to monero', 'exit to BTC', 'off-ramp into SOL' → xchain_out: symbol = the outside asset " +
    "received, amount = the ETH leaving (default \"0.1\" if unstated). The Bridge page (OUT) executes it.\n" +
    "- 'What can I trade', 'which tokens do you support', 'list the markets' → universe.\n" +
    "- Staking $SWOOD → route(stake). Bridging / on-ramp / deposit from another chain → route(bridge). " +
    "PUBLIC (non-private) swaps → route(swap). Governance / voting → route(govern). Points / rewards → route(points).\n" +
    "- A swap is 'shielded_swap' ONLY when the user asks to keep it private/shielded. A plain 'swap X to Y' " +
    "with amount + both tokens → public_swap (executed right here, clearly marked NOT private). If details " +
    "are missing, clarify. Only use route(swap) when the user asks to open/see the Swap page itself.\n" +
    "- Greetings, 'what can you do', 'how does shielding work' → answer.\n" +
    "- 'say' is ONE short, calm line. Never claim an action already happened — the user still confirms & signs."
  );
}

/** Extract the first JSON object from raw LLM text. */
function parseJson(raw: string): any {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in LLM output");
  return JSON.parse(raw.slice(a, b + 1));
}

/** Validate + repair an LLM action into the strict contract. Returns a fully-valid Reply. */
function repair(obj: any, message: string): Reply {
  const say = typeof obj?.say === "string" && obj.say.trim() ? obj.say.trim().slice(0, 400) : "";
  const a = obj?.action ?? {};
  const kind = String(a?.kind ?? "").toLowerCase();

  const clarify = (ask: string): Reply => ({ say: say || ask, action: { kind: "clarify" } });
  const withSay = (fallback: string, action: Action): Reply => ({ say: say || fallback, action });

  switch (kind) {
    case "shield": {
      const symbol = resolveSym(a.symbol), amount = cleanAmount(a.amount);
      if (!symbol) return clarify("Which token should I shield, and how much?");
      if (!amount) return clarify(`How much ${symbol} should I shield?`);
      return withSay(`Shield ${amount} ${symbol} into your private pool.`, { kind: "shield", symbol, amount });
    }
    case "private_transfer": {
      const symbol = resolveSym(a.symbol), amount = cleanAmount(a.amount);
      const to = String(a.to ?? "").trim();
      if (!symbol) return clarify("Which token should I send privately?");
      if (!amount) return clarify(`How much ${symbol} should I send?`);
      if (!to) return clarify("What's the recipient's Sherwood shielded address?");
      return withSay(`Privately send ${amount} ${symbol}.`, { kind: "private_transfer", symbol, amount, to });
    }
    case "unshield":
    case "withdraw": {
      const symbol = resolveSym(a.symbol), amount = cleanAmount(a.amount);
      const to = String(a.to ?? "").trim();
      if (!symbol) return clarify("Which token should I unshield, and to which 0x address?");
      if (!amount) return clarify(`How much ${symbol} should I unshield?`);
      if (!is0x(to)) return clarify(`What 0x address should I send the ${symbol} to?`);
      return withSay(`Unshield ${amount} ${symbol} to ${to.slice(0, 6)}…${to.slice(-4)}.`, { kind: "unshield", symbol, amount, to });
    }
    case "shielded_swap": {
      const symbolIn = resolveSym(a.symbolIn ?? a.symbol_in ?? a.from);
      const symbolOut = resolveSym(a.symbolOut ?? a.symbol_out ?? a.to);
      const amount = cleanAmount(a.amount);
      if (!symbolIn || !symbolOut) return clarify("Which two tokens should I swap, privately?");
      if (symbolIn === symbolOut) return clarify("Pick two different tokens for the swap.");
      if (!amount) return clarify(`How much ${symbolIn} should I swap into ${symbolOut}?`);
      return withSay(`Privately swap ${amount} ${symbolIn} into ${symbolOut}.`, { kind: "shielded_swap", symbolIn, symbolOut, amount });
    }
    case "public_swap": {
      const symbolIn = resolveSym(a.symbolIn ?? a.symbol_in ?? a.from);
      const symbolOut = resolveSym(a.symbolOut ?? a.symbol_out ?? a.to);
      const amount = cleanAmount(a.amount);
      if (!symbolIn || !symbolOut) return clarify("Which two tokens should I swap?");
      if (symbolIn === symbolOut) return clarify("Pick two different tokens for the swap.");
      if (!amount) return clarify(`How much ${symbolIn} should I swap into ${symbolOut}?`);
      return withSay(`Swap ${amount} ${symbolIn} into ${symbolOut} — public, not shielded.`, { kind: "public_swap", symbolIn, symbolOut, amount });
    }
    case "quote": {
      // Price checks: a single token means "price it in USDG" (≈ USD); a missing amount means 1 unit.
      let symbolIn = resolveSym(a.symbolIn ?? a.symbol_in ?? a.from);
      let symbolOut = resolveSym(a.symbolOut ?? a.symbol_out ?? a.to);
      if (symbolIn && !symbolOut) symbolOut = symbolIn === "USDG" ? "ETH" : "USDG";
      else if (!symbolIn && symbolOut) symbolIn = symbolOut === "USDG" ? "ETH" : symbolOut, symbolOut = "USDG";
      const amount = cleanAmount(a.amount) ?? "1";
      if (!symbolIn || !symbolOut || symbolIn === symbolOut) return clarify("Which token should I price? e.g. 'price AAPL' or 'quote 1 ETH to USDG'.");
      return withSay(`Here's the quote for ${amount} ${symbolIn} → ${symbolOut}.`, { kind: "quote", symbolIn, symbolOut, amount });
    }
    case "portfolio":
      return withSay("Here's your portfolio.", { kind: "portfolio" });
    case "bridge_quote": {
      const amount = cleanAmount(a.amount) ?? "0.1";
      const chain = String(a.chain ?? "").trim().slice(0, 40);
      if (!chain) return clarify("Which chain should I price the bridge to? e.g. Base or Arbitrum.");
      return withSay(`Here's what bridging ${amount} ETH to ${chain} looks like.`, { kind: "bridge_quote", amount, chain });
    }
    case "universe":
      return withSay("Here's everything tradable on Sherwood right now.", { kind: "universe" });
    case "xchain_quote": {
      const symbol = String(a.symbol ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
      const OUTSIDE = new Set(["BTC", "XMR", "SOL", "LTC", "DOGE", "USDT", "USDC", "ETH"]);
      if (!OUTSIDE.has(symbol)) return clarify("Which outside asset should I price? I can route BTC, XMR, SOL, LTC, DOGE or USDT in privately.");
      const amount = cleanAmount(a.amount) ?? (symbol === "BTC" ? "0.01" : "1");
      return withSay(`Here's the private route for ${amount} ${symbol} into Sherwood.`, { kind: "xchain_quote", symbol, amount });
    }
    case "xchain_out": {
      const symbol = String(a.symbol ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
      const OUTSIDE = new Set(["BTC", "XMR", "SOL", "LTC", "DOGE", "USDT", "USDC"]);
      if (!OUTSIDE.has(symbol)) return clarify("Cash out to which asset? I can route to BTC, XMR, SOL, LTC, DOGE or USDT privately.");
      const amount = cleanAmount(a.amount) ?? "0.1";
      return withSay(`Here's the private exit: ${amount} ETH → ${symbol}.`, { kind: "xchain_out", symbol, amount });
    }
    case "route": {
      const to = ROUTES.includes(String(a.to).toLowerCase() as RouteTo) ? (String(a.to).toLowerCase() as RouteTo) : null;
      if (!to) return { say: say || "Let me point you to the right page.", action: { kind: "answer" } };
      const note = typeof a.note === "string" ? a.note.slice(0, 200) : undefined;
      return withSay(`I'll take you to ${to}.`, { kind: "route", to, note });
    }
    case "answer":
      return { say: say || helpText(), action: { kind: "answer" } };
    case "clarify":
      return clarify("Could you add a bit more detail?");
    default:
      // unknown / missing kind — fall back to the deterministic parser on the raw message.
      return say ? { say, action: { kind: "answer" } } : ruleChat(message);
  }
}

// ================================ rule-based fallback (no LLM) ================================
const HELP =
  "I'm WOODIE — Sherwood's on-chain copilot. I can shield funds into the private pool, send them " +
  "privately, unshield to a clear address, run shielded swaps, price anything (\"price of NVDA\"), " +
  "quote a bridge out (\"bridge 0.05 ETH to Base\"), and list what's tradable (\"what can I trade?\") — " +
  "or point you to Stake, Bridge, Swap, Govern and Points. I leave no trace, and I never give financial advice.";
function helpText() { return HELP; }

/** Deterministic intent parser — NO LLM, always returns a valid Reply. */
export function ruleChat(message: string): Reply {
  const raw = message.trim();
  const m = raw.toLowerCase();
  const clarify = (say: string): Reply => ({ say, action: { kind: "clarify" } });

  if (!raw) return { say: HELP, action: { kind: "answer" } };

  // greetings / help / how-it-works → answer
  if (/^(hi|hey|hello|yo|gm|sup|help|what can you do|who are you|how (does|do)|explain|what is)/.test(m))
    return { say: HELP, action: { kind: "answer" } };

  // universe: "what can I trade" / "which tokens do you support" / "list markets"
  if (/what can i (trade|buy|swap|shield)|which (tokens|assets|coins|stocks)|list (the )?(tokens|markets|assets)|token list|universe|supported (tokens|assets)/.test(m))
    return { say: "Here's everything tradable on Sherwood right now.", action: { kind: "universe" } };

  // routing intents (checked before generic "swap")
  if (/\bstake|staking|unstake\b/.test(m)) return { say: "Staking lives on the Stake page — I'll take you there.", action: { kind: "route", to: "stake", note: "stake $SWOOD" } };
  // bridge with an amount + destination → indicative bridge quote ("bridge 0.05 eth to base")
  {
    const bq = m.match(/bridge\s+([\d.]+)\s*(?:eth\s+)?(?:to|into|→|->)\s+([a-z][a-z0-9 ]{1,30})/);
    if (bq && cleanAmount(bq[1])) {
      const chain = bq[2].trim().replace(/[.?!].*$/, "");
      return { say: `Here's what bridging ${bq[1]} ETH to ${chain} looks like.`, action: { kind: "bridge_quote", amount: bq[1], chain } };
    }
  }
  // outside assets: "bring in 0.01 btc" (IN) · "cash out 0.1 eth to monero" (OUT)
  {
    const out = m.match(/\b(btc|bitcoin|xmr|monero|sol|solana|ltc|litecoin|doge|dogecoin|usdt|tether)\b/);
    if (out) {
      const symbol = ({ bitcoin: "BTC", monero: "XMR", solana: "SOL", litecoin: "LTC", dogecoin: "DOGE", tether: "USDT" } as Record<string, string>)[out[1]] ?? out[1].toUpperCase();
      const num = cleanAmount((m.match(/[\d.]+/) ?? [])[0]);
      if (/\b(cash ?out|off.?ramp|exit|leave|withdraw (to|into)|convert (to|into)|swap (to|into)|sell (to|into|for))\b/.test(m))
        return { say: `Here's the private exit: ${num ?? "0.1"} ETH → ${symbol}.`, action: { kind: "xchain_out", symbol, amount: num ?? "0.1" } };
      if (/\b(bring|ramp|on.?ramp|deposit|receive|send in|from|into)\b/.test(m))
        return { say: `Here's the private route for ${num ?? (symbol === "BTC" ? "0.01" : "1")} ${symbol} into Sherwood.`, action: { kind: "xchain_quote", symbol, amount: num ?? (symbol === "BTC" ? "0.01" : "1") } };
    }
  }
  if (/\bbridge|on.?ramp|deposit from|top ?up\b/.test(m)) return { say: "Bridging & on-ramp are on the Bridge page.", action: { kind: "route", to: "bridge", note: "bridge / on-ramp" } };
  if (/\bgovern|governance|vote|proposal\b/.test(m)) return { say: "Governance is on the Govern page.", action: { kind: "route", to: "govern", note: "governance" } };
  if (/\bpoints|rewards|referral\b/.test(m)) return { say: "Your points live on the Points page.", action: { kind: "route", to: "points", note: "points" } };

  if (/\b(portfolio|balances?|holdings?|my (funds|money|assets))\b/.test(m))
    return { say: "Here's your portfolio.", action: { kind: "portfolio" } };

  // quote: "quote 1 eth to usdg" | "price of NVDA" (amount defaults to 1; single token prices vs USDG)
  if (/\b(quote|price|worth)\b|\bhow much is\b/.test(m)) {
    const nums = m.match(/[\d.]+/);
    const syms = [...new Set((m.match(/\b[a-z]{1,10}\b/g) ?? []).map(resolveSym).filter(Boolean) as string[])];
    const amount = cleanAmount(nums?.[0]) ?? "1";
    let symbolIn = syms[0] ?? null, symbolOut = syms[1] ?? null;
    if (symbolIn && !symbolOut) symbolOut = symbolIn === "USDG" ? "ETH" : "USDG";
    if (symbolIn && symbolOut && symbolIn !== symbolOut)
      return { say: `Quote for ${amount} ${symbolIn} → ${symbolOut}.`, action: { kind: "quote", symbolIn, symbolOut, amount } };
    return clarify("Which token should I price? e.g. 'price AAPL' or 'quote 1 ETH to USDG'.");
  }

  // shielded swap: "private swap 0.005 eth to aapl" | "privately trade 0.005 eth into aapl"
  if (/\b(swap|convert|exchange|trade)\b/.test(m) && /(privat|shield)/.test(m)) {
    const amount = cleanAmount((m.match(/[\d.]+/) ?? [])[0]);
    const pair = m.match(/([a-z]{1,10})\s+(?:to|into|for|→|->)\s+([a-z]{1,10})/);
    const symbolIn = resolveSym(pair?.[1]), symbolOut = resolveSym(pair?.[2]);
    if (symbolIn && symbolOut && amount && symbolIn !== symbolOut)
      return { say: `Privately swap ${amount} ${symbolIn} into ${symbolOut}.`, action: { kind: "shielded_swap", symbolIn, symbolOut, amount } };
    return clarify("Tell me the amount and the two tokens, e.g. 'privately swap 0.005 ETH into AAPL'.");
  }
  // plain swap with full details → executable public swap; otherwise deep-link the Swap page
  if (/\b(swap|convert|exchange|trade)\b/.test(m)) {
    const amount = cleanAmount((m.match(/[\d.]+/) ?? [])[0]);
    const pair = m.match(/([a-z]{1,10})\s+(?:to|into|for|→|->)\s+([a-z]{1,10})/);
    const symbolIn = resolveSym(pair?.[1]), symbolOut = resolveSym(pair?.[2]);
    if (symbolIn && symbolOut && amount && symbolIn !== symbolOut)
      return { say: `Swap ${amount} ${symbolIn} into ${symbolOut} — public, not shielded. Say 'privately swap' if you want it shielded.`, action: { kind: "public_swap", symbolIn, symbolOut, amount } };
    return { say: "Tell me the amount and pair (e.g. 'swap 1 ETH to USDG') and I'll set it up — public. For a shielded trade, say 'privately swap'.", action: { kind: "route", to: "swap", note: "public swap" } };
  }

  // unshield / withdraw: "withdraw 50 usdg to 0x.." (must have a 0x address)
  if (/\b(withdraw|unshield|redeem)\b/.test(m)) {
    const amount = cleanAmount((m.match(/[\d.]+/) ?? [])[0]);
    const sym = resolveSym((m.match(/\b([a-z]{2,10})\b(?=\s+to\b|\s|$)/g) ?? []).map((x) => x.trim()).find((x) => resolveSym(x)));
    const to = (raw.match(/0x[0-9a-fA-F]{40}/) ?? [])[0];
    if (!sym) return clarify("Which token should I unshield?");
    if (!amount) return clarify(`How much ${sym} should I unshield?`);
    if (!to) return clarify(`What 0x address should I send the ${sym} to?`);
    return { say: `Unshield ${amount} ${sym} to ${to.slice(0, 6)}…${to.slice(-4)}.`, action: { kind: "unshield", symbol: sym, amount, to } };
  }

  // private transfer / send: "send 100 usdg to <shielded addr>"
  if (/\b(send|transfer|pay)\b/.test(m)) {
    const amount = cleanAmount((m.match(/[\d.]+/) ?? [])[0]);
    const sym = resolveSym((m.match(/\b([a-z]{2,10})\b/g) ?? []).map((x) => x.trim()).find((x) => resolveSym(x)));
    const to = raw.split(/\bto\b/i).slice(1).join("to").trim() || undefined;
    if (!sym) return clarify("Which token should I send privately?");
    if (!amount) return clarify(`How much ${sym} should I send?`);
    if (!to) return clarify("What's the recipient's Sherwood shielded address?");
    return { say: `Privately send ${amount} ${sym}.`, action: { kind: "private_transfer", symbol: sym, amount, to } };
  }

  // shield / deposit: "shield 0.01 eth"
  if (/\b(shield|deposit|hide|private(ize)?|protect)\b/.test(m)) {
    const amount = cleanAmount((m.match(/[\d.]+/) ?? [])[0]);
    const sym = resolveSym((m.match(/\b([a-z]{2,10})\b/g) ?? []).map((x) => x.trim()).find((x) => resolveSym(x)));
    if (!sym) return clarify("Which token should I shield?");
    if (!amount) return clarify(`How much ${sym} should I shield?`);
    return { say: `Shield ${amount} ${sym} into your private pool.`, action: { kind: "shield", symbol: sym, amount } };
  }

  return { say: HELP, action: { kind: "answer" } };
}

// ================================ public entry ================================
/** Turn a plain-language message into ONE validated Action. Tries the LLM, repairs its output,
 *  and falls back to the deterministic parser if VIRTUALS_API_KEY is unset or the call errors. */
export async function chat(message: string, ctx?: ChatCtx): Promise<Reply> {
  const msg = String(message ?? "").trim();
  if (!msg) return { say: HELP, action: { kind: "answer" } };
  const history = (ctx?.history ?? []).slice(-10);
  try {
    const ctxLine = ctx?.shielded?.length ? `\n(For reference, the user currently holds shielded: ${ctx.shielded.join(", ")}. Never invent amounts.)` : "";
    const msgs: Array<{ role: string; content: string }> = [{ role: "system", content: systemPrompt() }];
    for (const t of history) msgs.push({ role: t.role === "user" ? "user" : "assistant", content: t.text.slice(0, 400) });
    msgs.push({ role: "user", content: msg + ctxLine });
    return repair(parseJson(await callCompute(msgs)), msg);
  } catch (e: any) {
    // visible in docker logs — an LLM failure here silently downgrades UX to the regex parser.
    console.warn(`woodie: LLM path failed (${e?.message ?? e}) — using ruleChat for: ${msg.slice(0, 80)}`);
    // no LLM: if WOODIE just asked a clarifying question, the new message is probably the missing
    // detail — re-parse it merged onto the previous user message ("shield eth" + "0.5").
    const lastWoodie = [...history].reverse().find((t) => t.role === "woodie");
    const lastUser = [...history].reverse().find((t) => t.role === "user");
    if (lastWoodie?.kind === "clarify" && lastUser) {
      const merged = ruleChat(`${lastUser.text} ${msg}`);
      if (merged.action && merged.action.kind !== "clarify" && merged.action.kind !== "answer") return merged;
    }
    return ruleChat(msg);
  }
}
