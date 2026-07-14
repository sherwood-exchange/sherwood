// WOODIE — Sherwood Exchange's conversational on-chain copilot. The user types a plain-language
// message; a backend /chat endpoint (agent/src/woodie.ts) returns { say, action }. WOODIE renders
// `say` as a chat bubble and, when the action is executable, a CONFIRM card the user signs from
// their own wallet. It drives the REAL shielded desk ops — shield / private transfer / unshield /
// shielded swap — plus quotes, a portfolio view, and deep-links to stake/bridge/swap/govern/points.
// WOODIE never invents balances and never gives financial advice.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, http, parseUnits, formatUnits, getAddress, type Address } from "viem";
import type { NetworkConfig, TokenInfo } from "./config";
import { quoteRoute } from "./routing";
import { TokenAvatar } from "./TokenUI";
import { toast, dismiss } from "./Toast";

const ERC8004_IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const PLAN_BASE = ((import.meta as any).env?.VITE_PLAN_URL as string | undefined) || "https://sherwood.spot/agent";
// shielded pools are thinner than a single public swap — keep a generous floor on the minOut.
const SLIP_BPS = 300n; // 3%

// ---- shared action contract (mirrors agent/src/woodie.ts) ----
type RouteTo = "stake" | "bridge" | "swap" | "govern" | "points";
type Action =
  | { kind: "shield"; symbol: string; amount: string }
  | { kind: "private_transfer"; symbol: string; amount: string; to: string }
  | { kind: "unshield"; symbol: string; amount: string; to: string }
  | { kind: "shielded_swap"; symbolIn: string; symbolOut: string; amount: string }
  | { kind: "portfolio" }
  | { kind: "quote"; symbolIn: string; symbolOut: string; amount: string }
  | { kind: "route"; to: RouteTo; note?: string }
  | { kind: "answer" }
  | { kind: "clarify" };
interface Reply { say: string; action?: Action }

type Msg = { role: "user"; text: string } | { role: "woodie"; text: string; action?: Action };

const EXECUTABLE = new Set(["shield", "private_transfer", "unshield", "shielded_swap"]);
const chainOf = (net: NetworkConfig): any => ({
  id: net.chainId, name: net.label,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [net.rpcUrl] } },
});
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const readableErr = (e: any): string => {
  const m: string = e?.shortMessage ?? e?.message ?? String(e);
  if (/user (rejected|denied)|rejected the request/i.test(m)) return "Transaction rejected in your wallet.";
  if (/insufficient/i.test(m)) return "Insufficient balance to cover this.";
  if (/TooLittleReceived|slippage|minOut/i.test(m)) return "Price moved beyond the slippage floor — try again.";
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
};

const EXAMPLES = ["Shield 0.01 ETH", "Private swap 0.005 ETH → AAPL", "Withdraw 50 USDG to 0x…", "My portfolio"];
const ROUTE_LABEL: Record<RouteTo, string> = { stake: "Stake", bridge: "Bridge", swap: "Swap", govern: "Govern", points: "Points" };

export interface WoodieProps {
  net: NetworkConfig;
  walletProvider: any; address?: string; isConnected: boolean; onConnect: () => void;
  shielded: Record<string, bigint>; clear: Record<string, bigint>;
  shieldToken: (t: TokenInfo, amount: bigint) => Promise<void>;
  sendMulti: (t: TokenInfo, amount: bigint, to: any) => void | Promise<void>;
  swapMulti: (tin: TokenInfo, amount: bigint, tout: TokenInfo, minOut: bigint) => void | Promise<void>;
  withdrawMulti: (t: TokenInfo, amount: bigint, recipient: any) => void | Promise<void>;
  tokenBySymbol: (s: string) => TokenInfo | undefined;
  /** App's parseAddress(JSON.parse(str)) — turns a shielded address string into a transfer target. */
  parseShieldedAddress: (s: string) => any;
}

export function Woodie(props: WoodieProps) {
  const { net, isConnected, onConnect } = props;
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "woodie", text: "I'm WOODIE — Sherwood's on-chain copilot. I can shield funds, send or swap them privately, unshield to a public address, or point you to the right page. Tell me what you'd like — I leave no trace.", action: { kind: "answer" } },
  ]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const explorer = net.explorer || "https://robinhoodchain.blockscout.com";

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [msgs, thinking]);

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || thinking) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: msg }]);
    setThinking(true);
    try {
      const res = await fetch(`${PLAN_BASE}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (!res.ok) throw new Error(`WOODIE returned ${res.status}`);
      const r = (await res.json()) as Reply;
      setMsgs((m) => [...m, { role: "woodie", text: r.say || "…", action: r.action }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "woodie", text: `I couldn't reach the copilot just now. ${readableErr(e)}`, action: { kind: "answer" } }]);
    } finally {
      setThinking(false);
    }
  }

  return (
    <div className="app app-narrow woodie">
      {/* Verified-agent header */}
      <div className="agent-head">
        <div className="agent-avatar" aria-hidden><img src="/woodie.png" alt="" width={44} height={44} /></div>
        <div className="agent-id">
          <div className="agent-name-row">
            <h2 className="agent-name">WOODIE</h2>
            <a className="verified-badge" href={`${explorer}/address/${ERC8004_IDENTITY}`} target="_blank" rel="noreferrer"
               title="ERC-8004 Identity registry on Robinhood Chain">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5z" /><path d="m9 12 2 2 4-4" /></svg>
              Verified agent · ERC-8004
            </a>
          </div>
          <p className="agent-tag muted mono-sm">Sherwood's on-chain copilot · registered on ERC-8004 Identity ↗</p>
        </div>
      </div>

      {/* Chat log */}
      <div className="woodie-log" ref={scroller}>
        {msgs.map((m, i) => (
          <div key={i} className={`chat-row ${m.role}`}>
            {m.role === "woodie" && <div className="chat-ava" aria-hidden><img src="/woodie.png" alt="" width={26} height={26} /></div>}
            <div className="chat-col">
              <div className={`bubble ${m.role}`}>{m.text}</div>
              {m.role === "woodie" && m.action && <ActionView action={m.action} {...props} explorer={explorer} />}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="chat-row woodie">
            <div className="chat-ava" aria-hidden><img src="/woodie.png" alt="" width={26} height={26} /></div>
            <div className="chat-col"><div className="bubble woodie typing"><span /><span /><span /></div></div>
          </div>
        )}
      </div>

      {/* Example prompt chips */}
      <div className="woodie-chips">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="woodie-chip" disabled={thinking} onClick={() => send(ex.replace("→", "to").replace("0x…", ""))}>{ex}</button>
        ))}
      </div>

      {/* Composer */}
      <form className="woodie-composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input
          className="woodie-input"
          placeholder="Ask WOODIE — e.g. 'shield 0.01 ETH' or 'privately swap 0.005 ETH into AAPL'"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={thinking}
        />
        <button className="btn woodie-send" type="submit" disabled={thinking || !input.trim()} aria-label="Send">
          {thinking ? <span className="spin dark" /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>}
        </button>
      </form>
      {!isConnected && <p className="woodie-foot mono-sm muted">Connect your wallet to execute — WOODIE shows a confirm card and you sign every action yourself.</p>}
    </div>
  );
}

// ---- action renderers ----
function ActionView({ action, explorer, ...p }: WoodieProps & { action: Action; explorer: string }) {
  if (action.kind === "route") {
    return (
      <a className="woodie-route" href={`#/${action.to}`}>
        <span className="wr-ico" aria-hidden>↗</span>
        <span>Open {ROUTE_LABEL[action.to]}{action.note ? ` — ${action.note}` : ""}</span>
      </a>
    );
  }
  if (action.kind === "portfolio") return <PortfolioCard net={p.net} shielded={p.shielded} clear={p.clear} />;
  if (action.kind === "quote") return <QuoteCard net={p.net} action={action} tokenBySymbol={p.tokenBySymbol} />;
  if (EXECUTABLE.has(action.kind)) return <ConfirmCard action={action} explorer={explorer} {...p} />;
  return null; // answer / clarify — say bubble is enough
}

/** Compact shielded + clear balances table (non-zero rows). */
function PortfolioCard({ net, shielded, clear }: { net: NetworkConfig; shielded: Record<string, bigint>; clear: Record<string, bigint> }) {
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return net.tokens.filter((t) => {
      if (seen.has(t.symbol)) return false; seen.add(t.symbol);
      return (shielded[t.symbol] ?? 0n) > 0n || (clear[t.symbol] ?? 0n) > 0n;
    });
  }, [net, shielded, clear]);
  const fmt = (v: bigint, d: number) => { const s = formatUnits(v, d); return s.length > 12 ? Number(s).toPrecision(6) : s; };
  if (!rows.length) return <div className="woodie-card"><p className="muted mono-sm" style={{ margin: 0 }}>No balances yet. Shield some funds and they'll show here.</p></div>;
  return (
    <div className="woodie-card">
      <div className="pf-table">
        <div className="pf-th"><span>Asset</span><span>Shielded</span><span>Wallet</span></div>
        {rows.map((t) => (
          <div className="pf-tr" key={t.symbol}>
            <span className="pf-asset"><TokenAvatar sym={t.symbol} logo={t.logo} size={22} />{t.symbol}</span>
            <span className="pf-val shielded">{fmt(shielded[t.symbol] ?? 0n, t.decimals)}</span>
            <span className="pf-val">{fmt(clear[t.symbol] ?? 0n, t.decimals)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Live quote via quoteRoute (public liquidity, same hub the desk uses). */
function QuoteCard({ net, action, tokenBySymbol }: { net: NetworkConfig; action: Extract<Action, { kind: "quote" }>; tokenBySymbol: (s: string) => TokenInfo | undefined }) {
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const pc = useMemo(() => createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) }), [net]);
  useEffect(() => {
    let live = true;
    (async () => {
      const tin = tokenBySymbol(action.symbolIn), tout = tokenBySymbol(action.symbolOut);
      if (!tin || !tout) { if (live) setErr(true); return; }
      try {
        const amt = parseUnits(action.amount, tin.decimals);
        const q = await quoteRoute(pc as any, tin.address as Address, tout.address as Address, amt);
        if (!live) return;
        if (q == null || q <= 0n) setErr(true);
        else setOut(formatUnits(q, tout.decimals));
      } catch { if (live) setErr(true); }
    })();
    return () => { live = false; };
  }, [pc, action.symbolIn, action.symbolOut, action.amount]);
  const trim = (s: string) => (s.includes(".") ? s.replace(/(\.\d{6})\d+$/, "$1").replace(/\.?0+$/, "") : s);
  return (
    <div className="woodie-card quote">
      <span className="wc-pair">{action.amount} {action.symbolIn} <em>→</em> {action.symbolOut}</span>
      <span className="wc-out">{err ? "no route" : out == null ? "quoting…" : `≈ ${trim(out)} ${action.symbolOut}`}</span>
    </div>
  );
}

/** Confirm card for the 4 executable shielded ops: icon + human summary + Confirm & sign. */
function ConfirmCard({ action, explorer, ...p }: WoodieProps & { action: Action; explorer: string }) {
  const { net, isConnected, onConnect, tokenBySymbol } = p;
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const pc = useMemo(() => createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) }), [net]);

  const summary = describe(action);
  const badSym = summary.symbols.some((s) => !tokenBySymbol(s));

  async function confirm() {
    if (!isConnected) { onConnect(); return; }
    setRunning(true);
    const id = toast({ kind: "busy", msg: `${summary.verb}…` });
    try {
      if (action.kind === "shield") {
        const t = need(tokenBySymbol(action.symbol), action.symbol);
        await p.shieldToken(t, parseUnits(action.amount, t.decimals));
        toast({ id, kind: "ok", msg: `Shielded ${action.amount} ${t.symbol}.` });
      } else if (action.kind === "private_transfer") {
        const t = need(tokenBySymbol(action.symbol), action.symbol);
        let to: any;
        try { to = p.parseShieldedAddress(action.to); } catch { throw new Error("That doesn't look like a Sherwood shielded address."); }
        await p.sendMulti(t, parseUnits(action.amount, t.decimals), to);
        dismiss(id); // sendMulti drives the authoritative desk toast (with tx link)
      } else if (action.kind === "unshield") {
        const t = need(tokenBySymbol(action.symbol), action.symbol);
        await p.withdrawMulti(t, parseUnits(action.amount, t.decimals), getAddress(action.to));
        dismiss(id);
      } else if (action.kind === "shielded_swap") {
        const tin = need(tokenBySymbol(action.symbolIn), action.symbolIn);
        const tout = need(tokenBySymbol(action.symbolOut), action.symbolOut);
        const amt = parseUnits(action.amount, tin.decimals);
        const expected = await quoteRoute(pc as any, tin.address as Address, tout.address as Address, amt);
        const minOut = expected != null && expected > 0n ? (expected * (10000n - SLIP_BPS)) / 10000n : 0n;
        await p.swapMulti(tin, amt, tout, minOut);
        dismiss(id);
      }
      setDone(true);
    } catch (e: any) {
      toast({ id, kind: "error", msg: readableErr(e) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={`confirm-card ${done ? "done" : ""}`}>
      <div className="cc-head">
        <span className="cc-ico" aria-hidden>{summary.icon}</span>
        <div className="cc-meta">
          <span className="cc-title">{summary.title}</span>
          <span className="cc-sub muted mono-sm">{summary.sub}</span>
        </div>
        <span className="cc-amt">{summary.amount}</span>
      </div>
      {badSym ? (
        <p className="cc-warn mono-sm">One of those tokens isn't on Sherwood. Try a listed symbol.</p>
      ) : done ? (
        <div className="cc-done mono-sm">✓ Submitted — track it in the notification and your portfolio.</div>
      ) : !isConnected ? (
        <button className="btn block cc-btn" onClick={onConnect}>Connect wallet to sign</button>
      ) : (
        <button className="btn block cc-btn" disabled={running} onClick={confirm}>
          {running ? <><span className="spin dark" />Signing…</> : "Confirm & sign"}
        </button>
      )}
    </div>
  );
}

function need<T>(v: T | undefined, sym: string): T { if (!v) throw new Error(`${sym} isn't a Sherwood token.`); return v; }

/** Human summary of an executable action for the confirm card. */
function describe(a: Action): { icon: string; title: string; sub: string; amount: string; verb: string; symbols: string[] } {
  switch (a.kind) {
    case "shield":
      return { icon: "🛡", title: `Shield ${a.symbol}`, sub: "Deposit into your private pool", amount: `${a.amount} ${a.symbol}`, verb: `Shielding ${a.amount} ${a.symbol}`, symbols: [a.symbol] };
    case "private_transfer":
      return { icon: "✦", title: `Private transfer ${a.symbol}`, sub: `To ${short(a.to)}`, amount: `${a.amount} ${a.symbol}`, verb: `Sending ${a.amount} ${a.symbol}`, symbols: [a.symbol] };
    case "unshield":
      return { icon: "↧", title: `Unshield ${a.symbol}`, sub: `To ${short(a.to)}`, amount: `${a.amount} ${a.symbol}`, verb: `Unshielding ${a.amount} ${a.symbol}`, symbols: [a.symbol] };
    case "shielded_swap":
      return { icon: "⇄", title: `Shielded swap`, sub: `${a.symbolIn} → ${a.symbolOut}, re-shielded`, amount: `${a.amount} ${a.symbolIn}`, verb: `Swapping ${a.amount} ${a.symbolIn} → ${a.symbolOut}`, symbols: [a.symbolIn, a.symbolOut] };
    default:
      return { icon: "•", title: "", sub: "", amount: "", verb: "Working", symbols: [] };
  }
}
