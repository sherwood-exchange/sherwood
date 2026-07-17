// WOODIE — Sherwood Exchange's conversational on-chain copilot. The user types a plain-language
// message; a backend /chat endpoint (agent/src/woodie.ts) returns { say, action }. WOODIE renders
// `say` as a chat bubble and, when the action is executable, a CONFIRM card the user signs from
// their own wallet. It drives the REAL shielded desk ops — shield / private transfer / unshield /
// shielded swap — plus quotes, a portfolio view, and deep-links to stake/bridge/swap/govern/points.
// WOODIE never invents balances and never gives financial advice.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseUnits, parseEther, formatUnits, getAddress, maxUint256, type Address } from "viem";
import { chainById, ERC20_ABI } from "@sherwood/client";
import type { NetworkConfig, TokenInfo } from "./config";
import { rpcTransport } from "./config";
import { quoteRoute } from "./routing";
import { relayChains, relayQuote } from "./relay";
import { quotePublic, resolveSpoke, isHub, NATIVE as AGG_NATIVE, type AggToken } from "./aggregator";
import { AGG_ABI, spokeArg } from "./PublicSwap";
import { X_ASSETS, ETH_BASE_ID, xchainQuote, xchainCreate, xchainWatch, xchainStatusLabel, xchainDone, xchainValidAddress, type XQuote, type XOrder } from "./xchain";
import { fetchPoints, type PointsInfo } from "./points";
import { TokenAvatar } from "./TokenUI";
import { toast, dismiss } from "./Toast";
import { useWoodieIdentity, isStandalone, isIOS, canPromptInstall, promptInstall } from "./pwa";

const ERC8004_IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const PLAN_BASE = ((import.meta as any).env?.VITE_PLAN_URL as string | undefined) || "https://sherwood.spot/agent";
// shielded pools are thinner than a single public swap — keep a generous floor on the minOut.
const SLIP_BPS = 300n; // 3%
const RH_CHAIN_ID = 4663; // Robinhood Chain — the only origin WOODIE bridges out of
const PUB_SLIP_BPS = 100n; // public aggregator pools are deep — 1%, same default as the Swap page

// ---- shared action contract (mirrors agent/src/woodie.ts) ----
type RouteTo = "stake" | "bridge" | "swap" | "govern" | "points";
type Action =
  | { kind: "shield"; symbol: string; amount: string }
  | { kind: "private_transfer"; symbol: string; amount: string; to: string }
  | { kind: "unshield"; symbol: string; amount: string; to: string }
  | { kind: "shielded_swap"; symbolIn: string; symbolOut: string; amount: string }
  | { kind: "public_swap"; symbolIn: string; symbolOut: string; amount: string }
  | { kind: "stake"; amount: string }
  | { kind: "unstake"; amount?: string }
  | { kind: "claim" }
  | { kind: "portfolio" }
  | { kind: "quote"; symbolIn: string; symbolOut: string; amount: string }
  | { kind: "bridge_quote"; amount: string; chain: string }
  | { kind: "xchain_quote"; symbol: string; amount: string }
  | { kind: "xchain_out"; symbol: string; amount: string }
  | { kind: "universe" }
  | { kind: "points" }
  | { kind: "govern" }
  | { kind: "route"; to: RouteTo; note?: string }
  | { kind: "answer" }
  | { kind: "clarify" };
interface Reply { say: string; action?: Action; plan?: Action[] }

type Msg = { role: "user"; text: string } | { role: "woodie"; text: string; action?: Action; plan?: Action[] };

const EXECUTABLE = new Set(["shield", "private_transfer", "unshield", "shielded_swap", "public_swap", "stake", "unstake", "claim"]);
const SWOOD_ADDR = "0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60" as Address;
const STAKE_ABI = [
  { type: "function", name: "stake", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "getReward", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "stakedOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "earned", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
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

const EXAMPLES = ["Shield 0.01 ETH", "Private swap 0.005 ETH → AAPL", "Swap 0.01 ETH → USDG", "Price of NVDA", "What can I trade?", "Bridge 0.05 ETH to Base", "My portfolio"];
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

  // Install-as-app: while on this page, "Add to Home Screen" installs WOODIE (own icon/name/start).
  const [installable, setInstallable] = useState(canPromptInstall());
  const [iosHint, setIosHint] = useState(false);
  const installed = isStandalone();
  useEffect(() => {
    const restore = useWoodieIdentity();
    const on = () => setInstallable(canPromptInstall());
    window.addEventListener("woodie-installable", on);
    return () => { window.removeEventListener("woodie-installable", on); restore(); };
  }, []);
  async function install() {
    if (installable) { const r = await promptInstall(); if (r !== "accepted" && isIOS()) setIosHint(true); return; }
    setIosHint(true); // no native prompt (iOS Safari / already-dismissed) → show the manual steps
  }

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [msgs, thinking]);

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || thinking) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: msg }]);
    setThinking(true);
    try {
      // recent turns + shielded symbols travel with the message, so WOODIE resolves
      // clarify follow-ups ("How much ETH?" → "0.5") and knows what the user holds.
      const history = msgs.slice(-8).map((m) => ({
        role: m.role, text: m.text, kind: m.role === "woodie" ? m.action?.kind : undefined,
      }));
      const shieldedSyms = Object.entries(props.shielded).filter(([, v]) => v > 0n).map(([s]) => s);
      const res = await fetch(`${PLAN_BASE}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, history, shielded: shieldedSyms.length ? shieldedSyms : undefined }),
      });
      if (!res.ok) throw new Error(`WOODIE returned ${res.status}`);
      const r = (await res.json()) as Reply;
      setMsgs((m) => [...m, { role: "woodie", text: r.say || "…", action: r.action, plan: r.plan }]);
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
        {!installed && (
          <button className="btn ghost sm woodie-install" onClick={install} title="Install WOODIE as an app">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" /></svg>
            Install app
          </button>
        )}
      </div>

      {iosHint && (
        <div className="woodie-ios" onClick={() => setIosHint(false)}>
          <div className="woodie-ios-card" onClick={(e) => e.stopPropagation()}>
            <img src="/woodie.png" alt="" width={48} height={48} style={{ borderRadius: 12 }} />
            <b>Install WOODIE</b>
            <p className="mono-sm muted">Add WOODIE to your home screen for a full-screen app:</p>
            <ol className="mono-sm">
              <li>Tap the <b>Share</b> button {isIOS() ? "↑" : "in your browser menu"}</li>
              <li>Choose <b>Add to Home Screen</b></li>
              <li>Tap <b>Add</b> — WOODIE lands on your home screen 🌲</li>
            </ol>
            <button className="btn block sm" onClick={() => setIosHint(false)}>Got it</button>
          </div>
        </div>
      )}

      {/* Chat log */}
      <div className="woodie-log" ref={scroller}>
        {msgs.map((m, i) => (
          <div key={i} className={`chat-row ${m.role}`}>
            {m.role === "woodie" && <div className="chat-ava" aria-hidden><img src="/woodie-head.png" alt="" width={26} height={26} /></div>}
            <div className="chat-col">
              <div className={`bubble ${m.role}`}>{m.text}</div>
              {m.role === "woodie" && m.plan && m.plan.length > 0 && <PlanView plan={m.plan} {...props} explorer={explorer} />}
              {m.role === "woodie" && !m.plan && m.action && <ActionView action={m.action} {...props} explorer={explorer} />}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="chat-row woodie">
            <div className="chat-ava" aria-hidden><img src="/woodie-head.png" alt="" width={26} height={26} /></div>
            <div className="chat-col"><div className="bubble woodie typing"><span /><span /><span /></div></div>
          </div>
        )}
      </div>

      {/* Composer — pinned to the bottom of the viewport (chat-app style) */}
      <div className="woodie-dock">
        <div className="woodie-dock-inner">
          {/* Example prompt chips */}
          <div className="woodie-chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="woodie-chip" disabled={thinking} onClick={() => send(ex.replace("→", "to").replace("0x…", ""))}>{ex}</button>
            ))}
          </div>
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
        </div>
      </div>
    </div>
  );
}

// ---- action renderers ----
/** Multi-step plan: a numbered stack of confirm cards. Each step is still signed individually
 *  (zero-custody); WOODIE just decomposed the goal and laid out the sequence. */
function PlanView({ plan, explorer, ...p }: WoodieProps & { plan: Action[]; explorer: string }) {
  return (
    <div className="woodie-plan">
      <div className="woodie-plan-head mono-sm muted">Plan · {plan.length} steps · confirm each in order</div>
      {plan.map((action, i) => (
        <div className="woodie-plan-step" key={i}>
          <span className="woodie-plan-num">{i + 1}</span>
          <div className="woodie-plan-body"><ConfirmCard action={action} explorer={explorer} {...p} /></div>
        </div>
      ))}
    </div>
  );
}

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
  if (action.kind === "bridge_quote") return <BridgeQuoteCard action={action} />;
  if (action.kind === "xchain_quote") return <XChainRampCard net={p.net} dir="in" symbol={action.symbol} amount={action.amount} address={p.address} />;
  if (action.kind === "xchain_out") return <XChainRampCard net={p.net} dir="out" symbol={action.symbol} amount={action.amount} address={p.address} />;
  if (action.kind === "universe") return <UniverseCard net={p.net} />;
  if (action.kind === "points") return <PointsCard net={p.net} address={p.address} />;
  if (action.kind === "govern") return <GovernCard net={p.net} address={p.address} walletProvider={p.walletProvider} onConnect={p.onConnect} explorer={explorer} />;
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

const trimNum = (s: string) => (s.includes(".") ? s.replace(/(\.\d{6})\d+$/, "$1").replace(/\.?0+$/, "") : s);

/** Live quote via quoteRoute (public liquidity, same hub the desk uses) + implied rate and USD value. */
function QuoteCard({ net, action, tokenBySymbol }: { net: NetworkConfig; action: Extract<Action, { kind: "quote" }>; tokenBySymbol: (s: string) => TokenInfo | undefined }) {
  const [out, setOut] = useState<string | null>(null);
  const [usd, setUsd] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const pc = useMemo(() => createPublicClient({ chain: chainOf(net), transport: rpcTransport(net) }), [net]);
  useEffect(() => {
    let live = true;
    (async () => {
      const tin = tokenBySymbol(action.symbolIn), tout = tokenBySymbol(action.symbolOut);
      if (!tin || !tout) { if (live) setErr(true); return; }
      try {
        const amt = parseUnits(action.amount, tin.decimals);
        const q = await quoteRoute(pc as any, tin.address as Address, tout.address as Address, amt);
        if (!live) return;
        if (q == null || q <= 0n) { setErr(true); return; }
        setOut(formatUnits(q, tout.decimals));
        // best-effort USD: one side is USDG, or value the input through USDG.
        if (tin.symbol === "USDG") setUsd(Number(action.amount).toFixed(2));
        else if (tout.symbol === "USDG") setUsd(Number(formatUnits(q, tout.decimals)).toFixed(2));
        else {
          const usdg = tokenBySymbol("USDG");
          if (usdg) {
            const u = await quoteRoute(pc as any, tin.address as Address, usdg.address as Address, amt);
            if (live && u && u > 0n) setUsd(Number(formatUnits(u, usdg.decimals)).toFixed(2));
          }
        }
      } catch { if (live) setErr(true); }
    })();
    return () => { live = false; };
  }, [pc, action.symbolIn, action.symbolOut, action.amount]);
  const rate = out != null && Number(action.amount) > 0 ? Number(out) / Number(action.amount) : null;
  return (
    <div className="woodie-card quote">
      <div className="wc-row">
        <span className="wc-pair">{action.amount} {action.symbolIn} <em>→</em> {action.symbolOut}</span>
        <span className="wc-out">{err ? "no route" : out == null ? "quoting…" : `≈ ${trimNum(out)} ${action.symbolOut}`}</span>
      </div>
      {!err && out != null && (rate != null || usd != null) && (
        <div className="wc-sub mono-sm muted">
          {rate != null && <span>1 {action.symbolIn} ≈ {trimNum(rate.toLocaleString("en-US", { maximumFractionDigits: 6, useGrouping: false }))} {action.symbolOut}</span>}
          {usd != null && <span>≈ ${usd}</span>}
        </div>
      )}
    </div>
  );
}

/** Indicative Relay bridge quote for ETH out of Robinhood Chain (execution stays on the Bridge page). */
function BridgeQuoteCard({ action }: { action: Extract<Action, { kind: "bridge_quote" }> }) {
  const [state, setState] = useState<{ label: string; fee?: string; eta?: string; chain?: string } | { err: string } | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const chains = await relayChains();
        const q = action.chain.trim().toLowerCase();
        const dest = chains.find((c) => String(c.id) === q || c.name.toLowerCase() === q || c.displayName.toLowerCase() === q)
          ?? chains.find((c) => c.displayName.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
        if (!dest) { if (live) setState({ err: `I don't know a chain called "${action.chain}".` }); return; }
        const PLACEHOLDER = "0x1111111111111111111111111111111111111111" as const; // indicative only
        const rq = await relayQuote({
          user: PLACEHOLDER, recipient: PLACEHOLDER, originChainId: RH_CHAIN_ID, destinationChainId: dest.id,
          amount: parseEther(action.amount),
        });
        if (!live) return;
        setState({
          label: `≈ ${trimNum(formatUnits(rq.outAmount, rq.outDecimals))} ${rq.outSymbol}`,
          fee: rq.feeUsd != null ? `$${rq.feeUsd.toFixed(2)} fee` : undefined,
          eta: rq.timeEstimateSec != null ? `~${rq.timeEstimateSec}s` : undefined,
          chain: dest.displayName,
        });
      } catch (e: any) { if (live) setState({ err: readableErr(e) }); }
    })();
    return () => { live = false; };
  }, [action.amount, action.chain]);
  return (
    <div className="woodie-card quote">
      <div className="wc-row">
        <span className="wc-pair">{action.amount} ETH <em>→</em> {("chain" in (state ?? {}) && (state as any).chain) || action.chain}</span>
        <span className="wc-out">{state == null ? "quoting…" : "err" in state ? "no quote" : state.label}</span>
      </div>
      {state != null && ("err" in state ? (
        <div className="wc-sub mono-sm muted"><span>{state.err}</span></div>
      ) : (
        <div className="wc-sub mono-sm muted">
          {state.fee && <span>{state.fee}</span>}
          {state.eta && <span>{state.eta}</span>}
          <a href="#/bridge">Open Bridge to execute ↗</a>
        </div>
      ))}
    </div>
  );
}
/** Private cross-chain ramp card — quotes AND executes the Houdini leg right in the chat.
 *  dir "in": <symbol> → ETH@Base at the user's 0x. dir "out": ETH@Base → <symbol> at a pasted address.
 *  Created orders land in the same localStorage slot the Bridge panel watches, so they carry over. */
function XChainRampCard({ net, dir, symbol, amount, address }: { net: NetworkConfig; dir: "in" | "out"; symbol: string; amount: string; address?: string }) {
  const [quote, setQuote] = useState<XQuote | null | "loading" | "none">("loading");
  const [dest, setDest] = useState(dir === "in" ? (address ?? "") : "");
  const [destOk, setDestOk] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [order, setOrder] = useState<XOrder | null>(null);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const asset = X_ASSETS.find((a) => a.symbol === symbol);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (!asset) { if (live) setQuote("none"); return; }
        const [from, to] = dir === "in" ? [asset.id, ETH_BASE_ID] : [ETH_BASE_ID, asset.id];
        const q = await xchainQuote(net, from, to, Number(amount));
        if (live) setQuote(q.private ?? q.standard ?? "none");
      } catch { if (live) setQuote("none"); }
    })();
    return () => { live = false; };
  }, [symbol, amount, dir, net]);

  useEffect(() => { if (dir === "in" && !dest && address) setDest(address); }, [address]);
  useEffect(() => {
    const a = dest.trim();
    if (!a || !asset) { setDestOk(null); return; }
    if (dir === "in") { setDestOk(/^0x[0-9a-fA-F]{40}$/.test(a)); return; }
    let live = true;
    xchainValidAddress(net, asset.chain, a).then((ok) => { if (live) setDestOk(ok); });
    return () => { live = false; };
  }, [dest, dir, asset?.chain, net]);

  useEffect(() => {
    if (!order || xchainDone(status)) return;
    return xchainWatch(net, order.houdiniId, (s) => setStatus(s.displayStatus));
  }, [order?.houdiniId, xchainDone(status), net]);

  async function create() {
    if (quote == null || typeof quote === "string" || !destOk) return;
    setCreating(true); setErr(null);
    try {
      const o = await xchainCreate(net, quote.quoteId, dest.trim());
      setOrder(o); setStatus(o.displayStatus);
      try { localStorage.setItem("sherwood-xchain-order", JSON.stringify({ ...o, dir })); } catch { /* private mode */ }
    } catch (e: any) { setErr(readableErr(e)); }
    finally { setCreating(false); }
  }
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); toast({ kind: "ok", msg: "Copied." }); } catch { /* blocked */ } };

  const pair = dir === "in" ? <>{amount} {symbol} <em>→</em> Sherwood</> : <>{amount} ETH <em>→</em> {symbol}</>;
  const outLabel = quote === "loading" ? "quoting…" : quote === "none" || quote == null ? "no route"
    : `≈ ${quote.amountOut.toFixed(6)} ${dir === "in" ? "ETH on Base" : symbol}`;

  if (order) {
    return (
      <div className="woodie-card quote">
        <div className="wc-row"><span className="wc-pair">{pair}</span><span className="wc-out">{xchainStatusLabel(status)}</span></div>
        <div className="wc-sub mono-sm muted" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
          <span>Send exactly <b>{order.inAmount} {order.inSymbol}{dir === "out" ? " (on Base)" : ""}</b> to:</span>
          <button type="button" className="xc-copy mono-sm" onClick={() => copy(order.depositAddress)}>{order.depositAddress} ⧉</button>
          {order.depositTag && <span>memo/tag (required!): <b>{order.depositTag}</b></span>}
          <span>order {order.houdiniId}{order.expires ? ` · deposit before ${new Date(order.expires).toLocaleTimeString()}` : ""} · progress also shows on the Bridge page</span>
          {status === "SWAP_COMPLETED" && dir === "in" && <a href="#/bridge">✓ Landed on Base — open Bridge to Relay it in + shield ↗</a>}
        </div>
      </div>
    );
  }
  return (
    <div className="woodie-card quote">
      <div className="wc-row"><span className="wc-pair">{pair}</span><span className="wc-out">{outLabel}</span></div>
      {quote !== "loading" && quote !== "none" && quote != null && (
        <>
          <div className="wc-sub mono-sm muted">
            <span>private multi-hop CEX route{quote.duration ? ` · ~${quote.duration} min` : ""}</span>
            {dir === "in" ? <span>then Relay in + shield</span> : <span>funded with ETH on Base (bridge OUT above)</span>}
          </div>
          <input className={`xc-payout mono-sm ${destOk === false ? "bad" : ""}`}
            placeholder={dir === "in" ? "0x… payout address on Base (your wallet)" : `${symbol} destination address`}
            value={dest} onChange={(e) => setDest(e.target.value)} />
          {err && <p className="xc-err mono-sm" style={{ margin: 0 }}>{err}</p>}
          <button className="btn block cc-btn" disabled={creating || !destOk} onClick={create}>
            {creating ? <><span className="spin dark" />Creating order…</> : "Get deposit address"}
          </button>
        </>
      )}
      {quote === "none" && <div className="wc-sub mono-sm muted"><span>No route for that amount right now — try a larger amount, or the panel on the Bridge page.</span></div>}
    </div>
  );
}

const GOV_ABI = [
  { type: "function", name: "proposalCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "proposals", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
    { name: "proposer", type: "address" }, { name: "description", type: "string" }, { name: "start", type: "uint64" }, { name: "end", type: "uint64" }, { name: "forVotes", type: "uint256" }, { name: "againstVotes", type: "uint256" }] },
  { type: "function", name: "voteOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "vote", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "bool" }], outputs: [] },
] as const;
type Prop = { id: number; description: string; end: number; forVotes: bigint; againstVotes: bigint; myVote: number };

/** Active governance proposals inline — vote For/Against ($SWOOD-weighted) without leaving chat. */
function GovernCard({ net, address, walletProvider, onConnect, explorer }: { net: NetworkConfig; address?: string; walletProvider: any; onConnect: () => void; explorer: string }) {
  const gov = net.swoodGovernor;
  const pc = useMemo(() => createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) }), [net]);
  const [props, setProps] = useState<Prop[] | null>(null);
  const [voting, setVoting] = useState<number | null>(null);
  const now = Math.floor(Date.now() / 1000);
  async function load() {
    if (!gov) { setProps([]); return; }
    try {
      const count = Number(await pc.readContract({ address: gov, abi: GOV_ABI, functionName: "proposalCount" }));
      const out: Prop[] = [];
      for (let i = count - 1; i >= 0 && i >= count - 20 && out.length < 5; i--) {
        const p = (await pc.readContract({ address: gov, abi: GOV_ABI, functionName: "proposals", args: [BigInt(i)] })) as any;
        const end = Number(p.end ?? p[3]);
        if (end <= now) continue; // active only
        const myVote = address ? Number(await pc.readContract({ address: gov, abi: GOV_ABI, functionName: "voteOf", args: [BigInt(i), address as Address] })) : 0;
        out.push({ id: i, description: p.description ?? p[1], end, forVotes: p.forVotes ?? p[4], againstVotes: p.againstVotes ?? p[5], myVote });
      }
      setProps(out);
    } catch { setProps([]); }
  }
  useEffect(() => { load(); }, [gov, address]);
  async function castVote(id: number, support: boolean) {
    if (!walletProvider || !address) { onConnect(); return; }
    setVoting(id);
    const tid = toast({ kind: "busy", msg: `Voting ${support ? "For" : "Against"}…` });
    try {
      const wc = createWalletClient({ account: address as Address, chain: chainById(net.chainId), transport: custom(walletProvider) });
      try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + net.chainId.toString(16) }] }); } catch { /* */ }
      const h = await wc.writeContract({ address: gov!, abi: GOV_ABI, functionName: "vote", args: [BigInt(id), support] });
      await pc.waitForTransactionReceipt({ hash: h });
      toast({ id: tid, kind: "ok", msg: `Voted ${support ? "For" : "Against"} proposal #${id}.`, hash: h, explorer });
      await load();
    } catch (e: any) { toast({ id: tid, kind: "error", msg: readableErr(e) }); }
    finally { setVoting(null); }
  }
  if (props == null) return <div className="woodie-card"><p className="muted mono-sm" style={{ margin: 0 }}>Loading proposals…</p></div>;
  if (!props.length) return <div className="woodie-card"><p className="muted mono-sm" style={{ margin: 0 }}>No active proposals right now. <a href="#/govern" style={{ color: "var(--lime)" }}>Open Govern ↗</a></p></div>;
  const fmtV = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return (
    <div className="woodie-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {props.map((pr) => (
        <div className="gov-row" key={pr.id}>
          <p className="gov-desc">{pr.description}</p>
          <div className="gov-tally mono-sm muted"><span>For {fmtV(pr.forVotes)}</span><span>Against {fmtV(pr.againstVotes)}</span></div>
          <div className="gov-vote">
            <button className={`btn ghost sm ${pr.myVote === 1 ? "gov-on" : ""}`} disabled={voting === pr.id} onClick={() => castVote(pr.id, true)}>For</button>
            <button className={`btn ghost sm ${pr.myVote === 2 ? "gov-on" : ""}`} disabled={voting === pr.id} onClick={() => castVote(pr.id, false)}>Against</button>
            {pr.myVote > 0 && <span className="mono-sm muted">you voted {pr.myVote === 1 ? "For" : "Against"}</span>}
          </div>
        </div>
      ))}
      <span className="mono-sm muted">Vote weight = your staked $SWOOD. Signaling votes.</span>
    </div>
  );
}

/** Points / rank / streak / referrals inline (same feed as the Points page). */
function PointsCard({ net, address }: { net: NetworkConfig; address?: string }) {
  const [p, setP] = useState<PointsInfo | null | "loading">("loading");
  useEffect(() => {
    let live = true;
    if (!address) { setP(null); return; }
    fetchPoints(net, address).then((r) => { if (live) setP(r); }).catch(() => { if (live) setP(null); });
    return () => { live = false; };
  }, [address, net]);
  if (!address) return <div className="woodie-card"><p className="muted mono-sm" style={{ margin: 0 }}>Connect your wallet to see your points.</p></div>;
  if (p === "loading") return <div className="woodie-card"><p className="muted mono-sm" style={{ margin: 0 }}>Loading your points…</p></div>;
  const pts = p?.points ?? 0;
  return (
    <div className="woodie-card">
      <div className="pf-hero2" style={{ marginBottom: 12 }}>
        <span className="pf-hero-total">{pts.toLocaleString()}<span style={{ fontSize: 16, color: "var(--moon-dim)", fontFamily: "var(--sans)", marginLeft: 8 }}>points{p?.rank ? ` · rank #${p.rank}` : ""}</span></span>
      </div>
      <div className="uv-chips">
        <span className="uv-chip">{p?.shields ?? 0} shields</span>
        <span className="uv-chip">{p?.streak ?? 0}-day streak</span>
        <span className="uv-chip">{p?.referrals ?? 0} referrals</span>
      </div>
      <a className="wc-sub mono-sm" style={{ display: "inline-block", marginTop: 12, color: "var(--lime)" }} href="#/referral">Invite friends → +200 each ↗</a>
    </div>
  );
}

type UniverseRow = { symbol: string; name: string; category: string; liquidity: "deep" | "medium" | "thin" };
/** Everything tradable right now: core tokens from the app allowlist + the tokenized stocks with live liquidity tiers. */
function UniverseCard({ net }: { net: NetworkConfig }) {
  const [stocks, setStocks] = useState<UniverseRow[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`${PLAN_BASE}/universe`);
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as UniverseRow[];
        if (live) setStocks(Array.isArray(j) ? j : []);
      } catch { if (live) setErr(true); }
    })();
    return () => { live = false; };
  }, []);
  const core = useMemo(() => {
    const seen = new Set<string>();
    return net.tokens.filter((t) => !seen.has(t.symbol) && seen.add(t.symbol));
  }, [net]);
  const stockSyms = useMemo(() => new Set((stocks ?? []).map((s) => s.symbol)), [stocks]);
  return (
    <div className="woodie-card">
      <p className="uv-h mono-sm muted">Tokens — shield, send, swap privately</p>
      <div className="uv-chips">
        {core.filter((t) => !stockSyms.has(t.symbol)).map((t) => (
          <span className="uv-chip" key={t.symbol}><TokenAvatar sym={t.symbol} logo={t.logo} size={16} />{t.symbol}</span>
        ))}
      </div>
      <p className="uv-h mono-sm muted">Tokenized stocks — live pool depth</p>
      {err ? (
        <p className="muted mono-sm" style={{ margin: 0 }}>Couldn't load live liquidity right now — the full list is on the Swap page.</p>
      ) : stocks == null ? (
        <p className="muted mono-sm" style={{ margin: 0 }}>Checking pool depth…</p>
      ) : (
        <div className="uv-chips">
          {stocks.map((s) => (
            <span className={`uv-chip liq-${s.liquidity}`} key={s.symbol} title={`${s.name} — ${s.liquidity} liquidity`}>
              <i className="uv-dot" aria-hidden />{s.symbol}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Confirm card for the 4 executable shielded ops: icon + human summary + Confirm & sign. */
function ConfirmCard({ action, explorer, ...p }: WoodieProps & { action: Action; explorer: string }) {
  const { net, isConnected, onConnect, tokenBySymbol } = p;
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const pc = useMemo(() => createPublicClient({ chain: chainOf(net), transport: rpcTransport(net) }), [net]);

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
      } else if (action.kind === "public_swap") {
        // same router call as the Swap page (AggRouter, 1% slippage) — WOODIE just fills the form.
        const tin = need(tokenBySymbol(action.symbolIn), action.symbolIn);
        const tout = need(tokenBySymbol(action.symbolOut), action.symbolOut);
        if (!net.aggRouter) throw new Error("Public swaps aren't configured on this network.");
        if (!p.walletProvider || !p.address) throw new Error("Connect your wallet first.");
        const toAgg = async (t: TokenInfo): Promise<AggToken> => {
          const address = (t.native ? AGG_NATIVE : t.address) as Address;
          const base = { address, symbol: t.symbol, name: t.name ?? t.symbol, decimals: t.decimals };
          if (isHub(address)) return { ...base, spoke: null };
          const spoke = await resolveSpoke(pc as any, address, t.decimals);
          if (!spoke) throw new Error(`No public liquidity route for ${t.symbol}.`);
          return { ...base, spoke };
        };
        const [ain, aout] = await Promise.all([toAgg(tin), toAgg(tout)]);
        const value = parseUnits(action.amount, ain.decimals);
        const expected = await quotePublic(pc as any, ain, aout, value);
        if (expected == null || expected <= 0n) throw new Error("No route for that pair right now.");
        const wc = createWalletClient({ account: p.address as Address, chain: chainById(net.chainId), transport: custom(p.walletProvider) });
        try { await p.walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + net.chainId.toString(16) }] }); } catch { /* manual */ }
        if (ain.address !== AGG_NATIVE) {
          const allow = (await pc.readContract({ address: ain.address, abi: ERC20_ABI, functionName: "allowance", args: [p.address as Address, net.aggRouter] })) as bigint;
          if (allow < value) {
            toast({ id, kind: "busy", msg: `Approving ${tin.symbol}…` });
            const ah = await wc.writeContract({ address: ain.address, abi: ERC20_ABI, functionName: "approve", args: [net.aggRouter, maxUint256] });
            await pc.waitForTransactionReceipt({ hash: ah });
          }
        }
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
        const swapArgs = (minOut: bigint) =>
          [ain.address, spokeArg(ain), aout.address, spokeArg(aout), value, minOut, deadline, p.address as Address] as const;
        // The off-chain quote misses the router's $SWOOD-tiered protocol fee and any token
        // transfer tax (e.g. SWOOD keeps ~1% leaving its pair), so a quote-derived minOut can sit
        // above what the router can actually deliver. Simulate the exact call first — the result
        // IS the deliverable amount — and floor 0.5% under that for price movement.
        let minOut: bigint;
        try {
          const { result } = await pc.simulateContract({
            account: p.address as Address, address: net.aggRouter, abi: AGG_ABI, functionName: "swap",
            args: swapArgs(0n) as any, value: ain.address === AGG_NATIVE ? value : 0n,
          });
          minOut = ((result as bigint) * (10000n - 50n)) / 10000n;
        } catch {
          // simulation unavailable — fall back to the quote minus protocol fee, minus 1% slip.
          const feeBps = (await pc.readContract({
            address: net.aggRouter, abi: [{ name: "feeBpsFor", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
            functionName: "feeBpsFor", args: [p.address as Address],
          }).catch(() => 30n)) as bigint;
          const netOut = (expected * (10000n - feeBps)) / 10000n;
          minOut = (netOut * (10000n - PUB_SLIP_BPS)) / 10000n;
        }
        toast({ id, kind: "busy", msg: `Swapping ${action.amount} ${tin.symbol} → ${tout.symbol}…` });
        const h = await wc.writeContract({
          address: net.aggRouter, abi: AGG_ABI, functionName: "swap",
          args: swapArgs(minOut) as any,
          value: ain.address === AGG_NATIVE ? value : 0n,
        });
        await pc.waitForTransactionReceipt({ hash: h });
        toast({ id, kind: "ok", msg: `Swapped ${action.amount} ${tin.symbol} → ${tout.symbol}.`, hash: h, explorer });
      } else if (action.kind === "stake" || action.kind === "unstake" || action.kind === "claim") {
        const staking = net.swoodStaking;
        if (!staking) throw new Error("Staking isn't configured on this network.");
        if (!p.walletProvider || !p.address) throw new Error("Connect your wallet first.");
        const wc = createWalletClient({ account: p.address as Address, chain: chainById(net.chainId), transport: custom(p.walletProvider) });
        try { await p.walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + net.chainId.toString(16) }] }); } catch { /* manual */ }
        if (action.kind === "stake") {
          const amt = parseUnits(action.amount, 18);
          const allow = (await pc.readContract({ address: SWOOD_ADDR, abi: ERC20_ABI, functionName: "allowance", args: [p.address as Address, staking] })) as bigint;
          if (allow < amt) {
            toast({ id, kind: "busy", msg: "Approving $SWOOD…" });
            const ah = await wc.writeContract({ address: SWOOD_ADDR, abi: ERC20_ABI, functionName: "approve", args: [staking, maxUint256] });
            await pc.waitForTransactionReceipt({ hash: ah });
          }
          toast({ id, kind: "busy", msg: `Staking ${action.amount} $SWOOD…` });
          const h = await wc.writeContract({ address: staking, abi: STAKE_ABI, functionName: "stake", args: [amt] });
          await pc.waitForTransactionReceipt({ hash: h });
          toast({ id, kind: "ok", msg: `Staked ${action.amount} $SWOOD.`, hash: h, explorer });
        } else if (action.kind === "unstake") {
          const amt = action.amount ? parseUnits(action.amount, 18) : ((await pc.readContract({ address: staking, abi: STAKE_ABI, functionName: "stakedOf", args: [p.address as Address] })) as bigint);
          if (amt <= 0n) throw new Error("You have nothing staked.");
          toast({ id, kind: "busy", msg: "Unstaking $SWOOD…" });
          const h = await wc.writeContract({ address: staking, abi: STAKE_ABI, functionName: "withdraw", args: [amt] });
          await pc.waitForTransactionReceipt({ hash: h });
          toast({ id, kind: "ok", msg: `Unstaked ${trimNum(formatUnits(amt, 18))} $SWOOD.`, hash: h, explorer });
        } else {
          const earned = (await pc.readContract({ address: staking, abi: STAKE_ABI, functionName: "earned", args: [p.address as Address] })) as bigint;
          if (earned <= 0n) throw new Error("No rewards to claim yet.");
          toast({ id, kind: "busy", msg: "Claiming rewards…" });
          const h = await wc.writeContract({ address: staking, abi: STAKE_ABI, functionName: "getReward", args: [] });
          await pc.waitForTransactionReceipt({ hash: h });
          toast({ id, kind: "ok", msg: `Claimed ${Number(formatUnits(earned, 6)).toFixed(4)} USDG.`, hash: h, explorer });
        }
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
    case "public_swap":
      return { icon: "⇄", title: `Public swap`, sub: `${a.symbolIn} → ${a.symbolOut} — on-chain, NOT private`, amount: `${a.amount} ${a.symbolIn}`, verb: `Swapping ${a.amount} ${a.symbolIn} → ${a.symbolOut}`, symbols: [a.symbolIn, a.symbolOut] };
    case "stake":
      return { icon: "◈", title: "Stake $SWOOD", sub: "Earn a share of protocol fees, paid in USDG", amount: `${a.amount} SWOOD`, verb: `Staking ${a.amount} $SWOOD`, symbols: [] };
    case "unstake":
      return { icon: "◇", title: "Unstake $SWOOD", sub: a.amount ? "Withdraw from staking" : "Withdraw everything staked", amount: a.amount ? `${a.amount} SWOOD` : "all", verb: "Unstaking $SWOOD", symbols: [] };
    case "claim":
      return { icon: "✦", title: "Claim rewards", sub: "Your accrued staking rewards, in USDG", amount: "USDG", verb: "Claiming rewards", symbols: [] };
    default:
      return { icon: "•", title: "", sub: "", amount: "", verb: "Working", symbols: [] };
  }
}
