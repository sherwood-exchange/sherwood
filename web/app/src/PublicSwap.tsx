// Public aggregator ("Swap" tab) — a plain, non-shielded on-chain swap over the whole
// Robinhood Chain ETH-paired token universe (public/tokenlist.json). Routes any token to any
// other through the ETH hub via PublicRouter.sol. This is NOT private — clearly labelled.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, maxUint256, getAddress, type Address } from "viem";
import { chainById, ERC20_ABI } from "@sherwood/client";
import type { NetworkConfig } from "./config";
import { quotePublic, resolveSpoke, isHub, type AggToken, type Spoke, NATIVE, WETH } from "./aggregator";
import { RouteChips, TokenPicker } from "./TokenUI";
import { toast } from "./Toast";

type St = { kind: "ok" | "err" | "busy"; msg: string; hash?: string } | null;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_SPOKE = { kind: 0, pool: ZERO, fee: 0, ts: 0, via: ZERO, pool2: ZERO } as const;

const SPOKE_C = [{ name: "kind", type: "uint8" }, { name: "pool", type: "address" }, { name: "fee", type: "uint24" }, { name: "ts", type: "int24" }, { name: "via", type: "address" }, { name: "pool2", type: "address" }] as const;
const AGG_ABI = [
  { type: "function", name: "swap", stateMutability: "payable", inputs: [
    { name: "tokenIn", type: "address" }, { name: "spokeIn", type: "tuple", components: SPOKE_C },
    { name: "tokenOut", type: "address" }, { name: "spokeOut", type: "tuple", components: SPOKE_C },
    { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "recipient", type: "address" },
  ], outputs: [{ type: "uint256" }] },
] as const;
const spokeArg = (t: AggToken) => { const s: any = t.spoke ?? ZERO_SPOKE; return { kind: s.kind, pool: s.pool, fee: s.fee, ts: s.ts, via: s.via ?? ZERO, pool2: s.pool2 ?? ZERO }; };
/** DEX version a token's ETH leg executes on (display-only; hub tokens have no leg). */
const dexLabel = (t: AggToken) => (isHub(t.address) || !t.spoke ? undefined : ["v4", "v3", "v2", "v2²"][t.spoke.kind]);
/** Human-readable form of common wallet/router errors (display-only). */
const readableErr = (e: any): string => {
  const m: string = e?.shortMessage ?? e?.message ?? String(e);
  if (/user (rejected|denied)|rejected the request/i.test(m)) return "Transaction rejected in your wallet.";
  if (/insufficient funds/i.test(m)) return "Insufficient ETH to cover gas.";
  if (/TooLittleReceived|slippage|minOut/i.test(m)) return "Price moved beyond your slippage tolerance — retry or raise max slippage.";
  return m.length > 220 ? m.slice(0, 220) + "…" : m;
};
const ERC_META = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const HUB: AggToken[] = [
  { address: NATIVE as Address, symbol: "ETH", name: "Ether", decimals: 18, logo: "/tokens/eth.png", spoke: null },
  { address: WETH as Address, symbol: "WETH", name: "Wrapped Ether", decimals: 18, logo: "/tokens/weth.png", spoke: null },
];

const trim = (s: string, n = 6) => { const [i, d] = s.split("."); return d ? `${i}.${d.slice(0, n)}` : i; };

export function PublicSwap({ net, walletProvider, address, isConnected, onConnect }: {
  net: NetworkConfig; walletProvider: any; address?: string; isConnected: boolean; onConnect: () => void;
}) {
  const [tokens, setTokens] = useState<AggToken[]>(HUB);
  const [inTok, setInTok] = useState<AggToken>(HUB[0]);
  const [outTok, setOutTok] = useState<AggToken | null>(null);
  const [amt, setAmt] = useState("");
  const [slip, setSlip] = useState("1");
  const [q, setQ] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [bal, setBal] = useState<bigint>(0n);
  const [status, setStatus] = useState<St>(null);
  const [working, setWorking] = useState(false);
  const [feeBps, setFeeBps] = useState(30); // $SWOOD-tiered protocol fee (bps), read from the router

  const pc = useMemo(() => createPublicClient({ chain: chainById(net.chainId), transport: http(net.rpcUrl) }), [net]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep local `status` for the in-button "Approving…/Swapping…" label, but surface it as a toast.
  const notify = (s: St) => { setStatus(s); if (s) toast({ id: "swap", kind: s.kind === "err" ? "error" : s.kind, msg: s.msg, hash: s.hash, explorer: net.explorer }); };

  // read the caller's $SWOOD fee tier from the router (0.30% default, less/free for holders)
  useEffect(() => {
    if (!isConnected || !address || !net.aggRouter) { setFeeBps(30); return; }
    let live = true;
    pc.readContract({ address: net.aggRouter, abi: [{ name: "feeBpsFor", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "feeBpsFor", args: [address as Address] })
      .then((b) => { if (live) setFeeBps(Number(b)); }).catch(() => {});
    return () => { live = false; };
  }, [address, isConnected, net]);

  // favorites + recents (persisted)
  const [fav, setFav] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem("agg-fav") || "[]")); } catch { return new Set(); } });
  const [recentAddrs, setRecentAddrs] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("agg-recent") || "[]"); } catch { return []; } });
  const toggleFav = (addr: string) => setFav((f) => { const n = new Set(f); if (n.has(addr)) n.delete(addr); else n.add(addr); localStorage.setItem("agg-fav", JSON.stringify([...n])); return n; });
  const byAddr = useMemo(() => { const m = new Map<string, AggToken>(); for (const t of tokens) m.set(t.address.toLowerCase(), t); return m; }, [tokens]);
  const recent = useMemo(() => recentAddrs.map((a) => byAddr.get(a)).filter(Boolean) as AggToken[], [recentAddrs, byAddr]);
  // display-only overlay: config logos/names + the tokenized-stock grouping. Address-based,
  // so a same-symbol token from the open 500-token list can't impersonate a stock.
  const cfgMeta = useMemo(() => { const m = new Map<string, { logo?: string; name?: string }>(); for (const t of net.tokens) m.set(t.address.toLowerCase(), { logo: t.logo, name: t.name }); return m; }, [net]);
  const stockSet = useMemo(() => new Set(net.tokens.filter((t) => t.stock).map((t) => t.address.toLowerCase())), [net]);
  const isStockTok = (t: { address: string }) => stockSet.has(t.address.toLowerCase());
  // "popular" quick picks — stocks resolved by config address, the rest by symbol
  const popular = useMemo(() => {
    const byCfg = (s: string) => { const c = net.tokens.find((t) => t.symbol === s); return c && byAddr.get(c.address.toLowerCase()); };
    return ["ETH", "USDG", "SWOOD", "AAPL", "TSLA", "NVDA", "SPY"].map((s) => byCfg(s) || tokens.find((t) => t.symbol === s)).filter(Boolean) as AggToken[];
  }, [tokens, byAddr, net]);
  const remember = (t: AggToken) => setRecentAddrs((r) => { const n = [t.address.toLowerCase(), ...r.filter((a) => a !== t.address.toLowerCase())].slice(0, 8); localStorage.setItem("agg-recent", JSON.stringify(n)); return n; });
  const [resolving, setResolving] = useState(false);

  /** Ensure a token has its `spoke` resolved (how to route it via ETH). Hub tokens need none. */
  async function withSpoke(t: AggToken): Promise<AggToken> {
    if (isHub(t.address) || t.spoke !== undefined) return t;
    const sp = await resolveSpoke(pc, t.address, t.decimals, { fee: t.fee, ts: t.ts });
    return { ...t, spoke: sp };
  }
  async function selectToken(t: AggToken, set: (t: AggToken) => void) {
    remember(t);
    set(t);
    if (isHub(t.address) || t.spoke !== undefined) return;
    setResolving(true);
    try { const r = await withSpoke(t); set(r); } catch { set({ ...t, spoke: null }); } finally { setResolving(false); }
  }
  const chooseIn = (t: AggToken) => selectToken(t, setInTok);
  const chooseOut = (t: AggToken) => selectToken(t, setOutTok);

  /** Import an arbitrary token by address: fetch metadata on-chain, resolve its route, select it. */
  async function importToken(addr: string, set: (t: AggToken) => void) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
    const a = getAddress(addr);
    const existing = tokens.find((t) => t.address.toLowerCase() === a.toLowerCase());
    if (existing) return selectToken(existing, set);
    setResolving(true);
    try {
      const [sym, nm, dec] = await Promise.all([
        pc.readContract({ address: a, abi: ERC_META, functionName: "symbol" }).catch(() => a.slice(2, 8)),
        pc.readContract({ address: a, abi: ERC_META, functionName: "name" }).catch(() => "Imported token"),
        pc.readContract({ address: a, abi: ERC_META, functionName: "decimals" }).catch(() => 18),
      ]);
      const base: AggToken = { address: a, symbol: String(sym).slice(0, 16), name: String(nm), decimals: Number(dec) };
      const full: AggToken = { ...base, spoke: await resolveSpoke(pc, a, base.decimals) };
      setTokens((prev) => (prev.find((x) => x.address.toLowerCase() === a.toLowerCase()) ? prev : [...prev, full]));
      remember(full); set(full);
    } catch { /* ignore */ } finally { setResolving(false); }
  }

  // USD pricing via USDG (≈ $1 per unit)
  const usdg = useMemo(() => tokens.find((t) => t.symbol === "USDG"), [tokens]);
  const [priceIn, setPriceIn] = useState<number | null>(null);
  const [priceOut, setPriceOut] = useState<number | null>(null);
  async function priceOf(t: AggToken, set: (n: number | null) => void) {
    if (!usdg) return set(null);
    if (t.address.toLowerCase() === usdg.address.toLowerCase()) return set(1);
    try { const p = await quotePublic(pc, t, usdg, parseUnits("1", t.decimals)); set(p ? Number(formatUnits(p, usdg.decimals)) : null); } catch { set(null); }
  }
  useEffect(() => { setPriceIn(null); priceOf(inTok, setPriceIn); }, [inTok, usdg]);
  useEffect(() => { setPriceOut(null); if (outTok) priceOf(outTok, setPriceOut); }, [outTok, usdg]);
  const fmtUsd = (n: number) => (n <= 0 ? "" : n < 0.01 ? "≈ $" + n.toFixed(4) : "≈ $" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  useEffect(() => {
    fetch("/tokenlist.json").then((r) => r.json()).then(async (l: AggToken[]) => {
      // overlay config metadata — curated config logos WIN over tokenlist URLs (the
      // tokenlist's cdn.robinhood.com logos are generic feathers and ISP-blocked for some users)
      const merged = l.map((t) => { const c = cfgMeta.get(t.address.toLowerCase()); return c ? { ...t, logo: c.logo ?? t.logo, name: c.name || t.name || t.symbol } : t; });
      setTokens([...HUB, ...merged]);
      const initial = merged.find((t) => t.symbol === "USDG") ?? merged[0];
      if (initial) { setOutTok(initial); try { setOutTok(await withSpoke(initial)); } catch { /* leave unresolved */ } }
    }).catch(() => {});
  }, []);

  const value = useMemo(() => { try { return parseUnits(amt || "0", inTok.decimals); } catch { return 0n; } }, [amt, inTok]);

  // wallet balance of the input token
  useEffect(() => {
    if (!isConnected || !address) { setBal(0n); return; }
    let live = true;
    (async () => {
      try {
        const b = inTok.address === NATIVE
          ? await pc.getBalance({ address: address as Address })
          : (await pc.readContract({ address: inTok.address, abi: ERC20_ABI, functionName: "balanceOf", args: [address as Address] })) as bigint;
        if (live) setBal(b);
      } catch { if (live) setBal(0n); }
    })();
    return () => { live = false; };
  }, [inTok, address, isConnected, status]);

  const spokeReady = (t: AggToken | null) => !!t && (isHub(t.address) || t.spoke !== undefined);
  // debounced live quote (waits until both tokens' spokes are resolved)
  useEffect(() => {
    setQ(null);
    if (timer.current) clearTimeout(timer.current);
    if (value <= 0n || !outTok || inTok.address === outTok.address) return;
    if (!spokeReady(inTok) || !spokeReady(outTok)) return;
    setQuoting(true);
    timer.current = setTimeout(async () => {
      try { setQ(await quotePublic(pc, inTok, outTok, value)); } catch { setQ(null); } finally { setQuoting(false); }
    }, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [amt, inTok, outTok, inTok.spoke, outTok?.spoke]);

  // net output after the $SWOOD-tiered protocol fee (the router deducts it from the output)
  const netOut = q != null ? (q * BigInt(10000 - feeBps)) / 10000n : null;
  const minOut = netOut != null ? netOut - (netOut * BigInt(Math.round((parseFloat(slip) || 1) * 100)) / 10000n) : 0n;
  const rate = netOut != null && value > 0n ? (netOut * 10n ** BigInt(inTok.decimals)) / value : 0n;
  const usdIn = priceIn != null && amt ? priceIn * (parseFloat(amt) || 0) : null;
  const usdOut = priceOut != null && netOut != null && outTok ? priceOut * Number(formatUnits(netOut, outTok.decimals)) : null;
  const [flips, setFlips] = useState(0); // drives the flip-button rotation (visual only)
  const [details, setDetails] = useState(false);
  const flip = () => { if (!outTok) return; const a = inTok, b = outTok; setInTok(b); setOutTok(a); setAmt(""); setFlips((f) => f + 1); };

  // route path rendered as chips: in ·dex → ETH → out ·dex (hub legs collapse)
  const routeStops = useMemo(() => {
    if (!outTok) return [];
    const stops: { sym: string; logo?: string; tag?: string }[] = [{ sym: inTok.symbol, logo: inTok.logo, tag: dexLabel(inTok) }];
    if (!isHub(inTok.address) && !isHub(outTok.address)) stops.push({ sym: "ETH", logo: "/tokens/eth.png" });
    stops.push({ sym: outTok.symbol, logo: outTok.logo, tag: dexLabel(outTok) });
    return stops;
  }, [inTok, outTok]);

  async function doSwap() {
    if (!walletProvider || !address || !outTok || !net.aggRouter) return;
    const router = net.aggRouter;
    const human = `${amt} ${inTok.symbol} → ${outTok.symbol}`;
    try {
      setWorking(true);
      const chain = chainById(net.chainId);
      const wc = createWalletClient({ account: address as Address, chain, transport: custom(walletProvider) });
      try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + net.chainId.toString(16) }] }); } catch { /* manual */ }
      if (inTok.address !== NATIVE) {
        const allow = (await pc.readContract({ address: inTok.address, abi: ERC20_ABI, functionName: "allowance", args: [address as Address, router] })) as bigint;
        if (allow < value) {
          notify({ kind: "busy", msg: `Approving ${inTok.symbol}…` });
          const ah = await wc.writeContract({ address: inTok.address, abi: ERC20_ABI, functionName: "approve", args: [router, maxUint256] });
          await pc.waitForTransactionReceipt({ hash: ah });
        }
      }
      notify({ kind: "busy", msg: `Swapping ${human}…` });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      const h = await wc.writeContract({
        address: router, abi: AGG_ABI, functionName: "swap",
        args: [inTok.address as Address, spokeArg(inTok), outTok.address as Address, spokeArg(outTok), value, minOut, deadline, address as Address],
        value: inTok.address === NATIVE ? value : 0n,
      });
      await pc.waitForTransactionReceipt({ hash: h });
      notify({ kind: "ok", msg: `Swapped ${human}.`, hash: h });
      setAmt("");
    } catch (e: any) {
      notify({ kind: "err", msg: readableErr(e) });
    } finally {
      setWorking(false);
    }
  }

  const sameTok = !!outTok && inTok.address === outTok.address;
  const noRoute = (!isHub(inTok.address) && inTok.spoke === null) || (!!outTok && !isHub(outTok.address) && outTok.spoke === null);
  const disabled = working || resolving || value <= 0n || !outTok || sameTok || noRoute || (isConnected && value > bal);

  return (
    <div className="app">
      <div className="app-head">
        <div>
          <h2 style={{ fontFamily: "var(--display)", fontSize: 26, margin: 0 }}>Swap</h2>
          <p className="muted mono-sm" style={{ margin: "4px 0 0" }}>Public swap across every Robinhood Chain token — not shielded.</p>
        </div>
        <span className="muted mono-sm">{tokens.length - HUB.length} tokens</span>
      </div>

      <div className="desk-one">
        <section className="card">
          <div className="public-note">Public swap — this trade is on-chain and <b>not private</b>. For shielded trading use the private desk.</div>

          <div className="asset-panel">
            <div className="ap-top">
              <span className="ap-label">You pay</span>
              {isConnected && <span className="ap-bal">Balance: {trim(formatUnits(bal, inTok.decimals))}{bal > 0n && <button type="button" className="max-chip" onClick={() => setAmt(formatUnits(bal, inTok.decimals))}>MAX</button>}</span>}
            </div>
            <div className="ap-main">
              <input className="ap-amount" inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} />
              <TokenPicker tokens={tokens} value={inTok} onChange={chooseIn} exclude={outTok?.address} fav={fav} onFav={toggleFav} recent={recent} onImport={(a) => importToken(a, setInTok)} popular={popular} isStock={isStockTok} />
            </div>
            {usdIn != null && usdIn > 0 && <div className="ap-usd">{fmtUsd(usdIn)}</div>}
          </div>

          <div className="swap-dir-wrap">
            <button type="button" className="swap-dir" onClick={flip} aria-label="Switch direction" style={{ transform: `rotate(${flips * 180}deg)` }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" /></svg>
            </button>
          </div>

          <div className="asset-panel">
            <div className="ap-top"><span className="ap-label">You receive</span></div>
            <div className="ap-main">
              <div className={`ap-amount ap-readonly ${netOut != null ? "" : "muted"}`}>{quoting ? <span className="skel skel-amt" /> : netOut != null && outTok ? trim(formatUnits(netOut, outTok.decimals), 8) : "0.0"}</div>
              {outTok && <TokenPicker tokens={tokens} value={outTok} onChange={chooseOut} exclude={inTok.address} fav={fav} onFav={toggleFav} recent={recent} onImport={(a) => importToken(a, setOutTok)} popular={popular} isStock={isStockTok} />}
            </div>
            {usdOut != null && usdOut > 0 && <div className="ap-usd">{fmtUsd(usdOut)}</div>}
          </div>

          <div className={`sw-details ${details ? "open" : ""}`}>
            <button type="button" className="sw-summary" onClick={() => setDetails((d) => !d)} aria-expanded={details}>
              <span className="sw-rate">
                {quoting ? <span className="skel skel-line" /> : rate > 0n && outTok ? `1 ${inTok.symbol} ≈ ${trim(formatUnits(rate, outTok.decimals), 6)} ${outTok.symbol}` : "Rate —"}
              </span>
              <span className="sw-sum-right">
                {feeBps === 0 ? <b className="fee-free">0% fee</b> : <span className="muted">{(feeBps / 100).toFixed(2)}% fee</span>}
                <svg className="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
              </span>
            </button>
            {details && (
              <div className="sw-body">
                <div className="sm-row"><span>Protocol fee</span><span>{feeBps === 0 ? <b style={{ color: "var(--lime)" }}>0% — $SWOOD holder</b> : <>{(feeBps / 100).toFixed(2)}%<span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>· hold $SWOOD to cut it</span></>}</span></div>
                <div className="sm-row"><span>Max slippage</span><span className="slip-input"><input inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} />%</span></div>
                {q && outTok && <div className="sm-row dim"><span>Minimum received</span><span>{trim(formatUnits(minOut, outTok.decimals), 8)} {outTok.symbol}</span></div>}
                <div className="sm-row route-row"><span>Route</span>{routeStops.length ? <RouteChips stops={routeStops} /> : <span>—</span>}</div>
              </div>
            )}
          </div>

          {!isConnected ? (
            <button className="btn block" style={{ marginTop: 14 }} onClick={onConnect}>Connect wallet</button>
          ) : (
            <button className="btn block" style={{ marginTop: 14 }} disabled={disabled} onClick={doSwap}>
              {working ? <><span className="spin dark" />{status?.kind === "busy" && status.msg.startsWith("Approving") ? "Approving…" : "Swapping…"}</>
                : resolving ? "Finding best route…" : sameTok ? "Select different tokens" : noRoute ? "No route found" : value > bal ? `Insufficient ${inTok.symbol}` : "Swap"}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
