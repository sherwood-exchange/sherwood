// Private Bridge — cross-chain in/out that piggybacks on Relay.link. Sherwood adds the privacy
// on the Robinhood-Chain side:
//   OUT: unshield via the relayer (breaks the link to the shielded pool) → Relay bridges out.
//   IN:  Relay bridges into your RH wallet → auto-shield into the pool.
// MVP tokens: ETH + USDG (both Relay-supported on RH). Relay itself is a public bridge.
import { useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, createPublicClient, custom, http, defineChain, parseUnits, parseEther, formatUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainById, ERC20_ABI } from "@sherwood/client";
import type { NetworkConfig, TokenInfo } from "./config";
import { rpcTransport } from "./config";
import { relayChains, relayQuote, relayStatus, type RelayChain, type RelayQuote, type RelayTx } from "./relay";
import { TokenPicker, TokenAvatar } from "./TokenUI";
import { toast, dismiss } from "./Toast";
import { XChainPanel } from "./XChainPanel";

type St = { kind: "ok" | "err" | "busy"; msg: string } | null;
type Dir = "out" | "in";
const NATIVE = "0x0000000000000000000000000000000000000000";
const RH = 4663;
const trim = (s: string, n = 6) => { const [i, d] = s.split("."); return d ? `${i}.${d.slice(0, n)}` : i; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minChain = (id: number) => defineChain({ id, name: `chain ${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
/** Relay origin currency for a shielded token (native ETH is 0x0; ERC20 by address). */
const relayCurrency = (t: TokenInfo) => (t.native ? NATIVE : t.address);
const WETH_ABI = [{ type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }] as const;
const TRANSFER_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
type PendingEph = { pk: `0x${string}`; address: string; token: TokenInfo };

/** Custom dark-theme dropdown for the destination/source chain — matches TokenPicker instead of
 *  the OS-blue native <select>. Button opens a styled menu of chains (logo + name), Esc/outside close. */
function ChainDropdown({ chains, value, onChange, placeholder }: {
  chains: RelayChain[]; value: number; onChange: (id: number) => void; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const sorted = useMemo(() => chains.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)), [chains]);
  const cur = chains.find((c) => c.id === value);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, [open]);
  return (
    <div className="chain-select" ref={ref}>
      <button type="button" className="cs-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {cur ? <><TokenAvatar sym={cur.currencySymbol} logo={cur.logo} size={20} /><span className="cs-name">{cur.displayName}</span></> : <span className="cs-name muted">{placeholder ?? "Select"}</span>}
        <svg className="tok-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="cs-menu" role="listbox">
          {sorted.map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={c.id === value} className={`cs-item ${c.id === value ? "sel" : ""}`} onClick={() => { onChange(c.id); setOpen(false); }}>
              <TokenAvatar sym={c.currencySymbol} logo={c.logo} size={20} />
              <span className="cs-name">{c.displayName}</span>
              {c.id === value && <span className="cs-check" aria-hidden>✓</span>}
            </button>
          ))}
          {sorted.length === 0 && <div className="tp-empty">Loading chains…</div>}
        </div>
      )}
    </div>
  );
}

export function Bridge({ net, walletProvider, address, isConnected, onConnect, tokens, shielded, unshieldToken, shieldToken, embedded }: {
  net: NetworkConfig; walletProvider: any; address?: string; isConnected: boolean; onConnect: () => void;
  tokens: TokenInfo[]; shielded: Record<string, bigint>;
  unshieldToken: (token: TokenInfo, amount: bigint, recipient: Address) => Promise<void>;
  shieldToken: (token: TokenInfo, amount: bigint) => Promise<void>;
  /** Desk placement: render ONLY the Relay bridge card (the #/bridge page renders only the private route). */
  embedded?: boolean;
}) {
  const [dir, setDir] = useState<Dir>("out");
  const [chains, setChains] = useState<RelayChain[]>([]);
  const [otherId, setOtherId] = useState<number>(8453); // Base default
  const [sym, setSym] = useState(tokens[0]?.symbol ?? "ETH");
  const [amt, setAmt] = useState("");
  const [dest, setDest] = useState("");
  const [q, setQ] = useState<RelayQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [working, setWorking] = useState(false);
  const [maxPriv, setMaxPriv] = useState(true);
  const [pendingEph, setPendingEph] = useState<PendingEph | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setStatus = (s: St) => { if (s) toast({ id: "bridge", kind: s.kind === "err" ? "error" : s.kind, msg: s.msg, explorer: net.explorer }); else dismiss("bridge"); };

  // Recover any funds stranded at a temporary bridge address from an interrupted flow.
  useEffect(() => { try { const s = localStorage.getItem("sw-bridge-eph"); if (s) setPendingEph(JSON.parse(s)); } catch { /* ignore */ } }, []);
  async function recoverEph() {
    if (!pendingEph || !address) return;
    try {
      setWorking(true);
      setStatus({ kind: "busy", msg: "Recovering funds from the temporary address…" });
      const rhChain = chainById(RH);
      const pc = createPublicClient({ chain: rhChain, transport: rpcTransport(net) });
      const e = privateKeyToAccount(pendingEph.pk);
      const ewc = createWalletClient({ account: e, chain: rhChain, transport: rpcTransport(net) });
      const tk = pendingEph.token;
      const tokBal = (await pc.readContract({ address: tk.address as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [e.address as Address] })) as bigint;
      if (tokBal > 0n) { const h = await ewc.writeContract({ address: tk.address as Address, abi: TRANSFER_ABI, functionName: "transfer", args: [address as Address, tokBal] }); await pc.waitForTransactionReceipt({ hash: h }); }
      const bal = await pc.getBalance({ address: e.address as Address });
      const gas = parseEther("0.00003");
      if (bal > gas) { const h = await ewc.sendTransaction({ to: address as Address, value: bal - gas, chain: rhChain }); await pc.waitForTransactionReceipt({ hash: h }); }
      localStorage.removeItem("sw-bridge-eph"); setPendingEph(null);
      setStatus({ kind: "ok", msg: "Recovered funds from the temporary address to your wallet." });
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.shortMessage ?? e?.message ?? String(e) });
    } finally { setWorking(false); }
  }

  const token = tokens.find((t) => t.symbol === sym) ?? tokens[0];
  useEffect(() => { relayChains().then((cs) => setChains(cs.filter((c) => c.id !== RH))).catch(() => {}); }, []);
  useEffect(() => { if (address && !dest) setDest(address); }, [address]);
  const amount = useMemo(() => { try { return parseUnits(amt || "0", token.decimals); } catch { return 0n; } }, [amt, token]);
  const otherChain = chains.find((c) => c.id === otherId);
  const validDest = /^0x[0-9a-fA-F]{40}$/.test(dest);
  const shieldedBal = shielded[sym] ?? 0n;

  // quote params depend on direction
  const quoteArgs = useMemo(() => {
    if (!address) return null;
    if (dir === "out") {
      if (!validDest) return null;
      return { user: address as Address, recipient: dest as Address, originChainId: RH, destinationChainId: otherId, amount, originCurrency: relayCurrency(token), destinationCurrency: NATIVE };
    }
    // in: source(other) native ETH -> RH token, recipient = wallet
    return { user: address as Address, recipient: address as Address, originChainId: otherId, destinationChainId: RH, amount, originCurrency: NATIVE, destinationCurrency: relayCurrency(token) };
  }, [dir, address, dest, validDest, otherId, amount, token]);

  useEffect(() => {
    setQ(null);
    if (timer.current) clearTimeout(timer.current);
    if (amount <= 0n || !quoteArgs) return;
    setQuoting(true);
    timer.current = setTimeout(async () => {
      try { setQ(await relayQuote(quoteArgs)); } catch { setQ(null); } finally { setQuoting(false); }
    }, 450);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [amt, dir, otherId, dest, sym, address]);

  /** Make sure the wallet is on `chainId`, ADDING it first if the wallet doesn't know it
   *  (wallet_switchEthereumChain fails 4902 for unknown chains). Waits until it takes effect. */
  async function ensureChain(chainId: number) {
    const hex = "0x" + chainId.toString(16);
    const cur = await walletProvider.request({ method: "eth_chainId" }).catch(() => null);
    if (cur === hex) return;
    try {
      await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (err: any) {
      const meta = chains.find((c) => c.id === chainId) ?? (chainId === RH ? { displayName: "Robinhood Chain", rpcUrl: net.rpcUrl, currencyName: "Ether", currencySymbol: "ETH", currencyDecimals: 18, explorerUrl: net.explorer } as any : null);
      if (!meta?.rpcUrl) throw new Error(`Your wallet can't switch to chain ${chainId}. Add it manually and retry.`);
      await walletProvider.request({ method: "wallet_addEthereumChain", params: [{
        chainId: hex, chainName: meta.displayName, rpcUrls: [meta.rpcUrl],
        nativeCurrency: { name: meta.currencyName ?? meta.currencySymbol, symbol: meta.currencySymbol, decimals: meta.currencyDecimals ?? 18 },
        blockExplorerUrls: meta.explorerUrl ? [meta.explorerUrl] : [],
      }] });
      await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }).catch(() => {});
    }
    // confirm the switch actually took effect before sending
    for (let i = 0; i < 20; i++) {
      if ((await walletProvider.request({ method: "eth_chainId" }).catch(() => null)) === hex) return;
      await sleep(500);
    }
    throw new Error(`Please switch your wallet to ${chains.find((c) => c.id === chainId)?.displayName ?? "the required chain"} and retry.`);
  }

  /** Execute Relay txs (approve + deposit), switching the wallet to each tx's chain. */
  async function execTxs(txs: RelayTx[]) {
    const wc = createWalletClient({ account: address as Address, transport: custom(walletProvider) });
    for (const tx of txs) {
      await ensureChain(tx.chainId);
      const hash = await wc.sendTransaction({ to: tx.to, value: tx.value, data: tx.data, chain: minChain(tx.chainId) });
      const pc = createPublicClient({ chain: minChain(tx.chainId), transport: custom(walletProvider) });
      await pc.waitForTransactionReceipt({ hash });
    }
  }

  async function track(requestId: string, doneMsg: string): Promise<boolean> {
    for (let i = 0; i < 75; i++) {
      const s = await relayStatus(requestId);
      if (s.status === "success") { setStatus({ kind: "ok", msg: `${doneMsg}${s.destTxHash ? ` — tx ${s.destTxHash.slice(0, 10)}…` : ""}.` }); return true; }
      if (s.status === "failure" || s.status === "refund") { setStatus({ kind: "err", msg: `Bridge ${s.status}.` }); return false; }
      await sleep(4000);
    }
    return false;
  }

  /** Standard bridge-out: unshield to your wallet, bridge from there. Wallet is public. */
  async function bridgeOutWallet(human: string) {
    setStatus({ kind: "busy", msg: "Step 1/3 — unshielding privately via the relayer…" });
    await unshieldToken(token, amount, address as Address);
    setStatus({ kind: "busy", msg: "Step 2/3 — getting bridge route…" });
    const quote = await relayQuote(quoteArgs!);
    setStatus({ kind: "busy", msg: `Step 3/3 — bridging ${human}…` });
    await execTxs(quote.txs);
    setStatus({ kind: "busy", msg: `Bridging… waiting for delivery on ${otherChain?.displayName ?? "destination"}` });
    await track(quote.requestId, `Bridged ${human}. Delivered`);
  }

  /** Max-privacy bridge-out: unshield to a FRESH ephemeral address (never your main wallet),
   *  whose gas is seeded by the relayer, and bridge from there. Nothing links the bridge-out
   *  to your identity or your shielded pool. */
  async function bridgeOutEphemeral(human: string) {
    const rhChain = chainById(RH);
    const pc = createPublicClient({ chain: rhChain, transport: rpcTransport(net) });
    const pk = generatePrivateKey();
    const e = privateKeyToAccount(pk);
    // Persist the throwaway key for the flow's duration so a tab reload can't strand funds at
    // the temporary address (cleared on success). It only ever holds the in-flight bridge amount.
    localStorage.setItem("sw-bridge-eph", JSON.stringify({ pk, address: e.address, token, ts: Date.now() }));
    const ewc = createWalletClient({ account: e, chain: rhChain, transport: rpcTransport(net) });

    // 1) relayer seeds gas to the fresh address (unlinkable source)
    setStatus({ kind: "busy", msg: "Step 1/4 — seeding gas to a fresh address…" });
    if (!net.relayerUrl) throw new Error("relayer not configured");
    await fetch(net.relayerUrl.replace(/\/$/, "") + "/fund-gas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: e.address }) });
    for (let i = 0; i < 30; i++) { if ((await pc.getBalance({ address: e.address })) > 0n) break; await sleep(2000); }
    if ((await pc.getBalance({ address: e.address })) <= 0n) throw new Error("gas seed did not arrive");

    // 2) unshield the amount to the fresh address (relayer-submitted → unlinkable to the pool)
    setStatus({ kind: "busy", msg: "Step 2/4 — unshielding to the fresh address…" });
    await unshieldToken(token, amount, e.address);

    // 3) if native, the fresh address unwraps WETH → ETH so Relay can take native
    if (token.native) {
      setStatus({ kind: "busy", msg: "Step 3/4 — preparing funds…" });
      const uh = await ewc.writeContract({ address: token.address, abi: WETH_ABI, functionName: "withdraw", args: [amount] });
      await pc.waitForTransactionReceipt({ hash: uh });
    }

    // 4) fresh address bridges out via Relay
    setStatus({ kind: "busy", msg: `Step 4/4 — bridging ${human} from the fresh address…` });
    const quote = await relayQuote({ user: e.address, recipient: dest as Address, originChainId: RH, destinationChainId: otherId, amount, originCurrency: relayCurrency(token), destinationCurrency: NATIVE });
    for (const tx of quote.txs) {
      const h = await ewc.sendTransaction({ to: tx.to, value: tx.value, data: tx.data, chain: rhChain });
      await pc.waitForTransactionReceipt({ hash: h });
    }
    setStatus({ kind: "busy", msg: `Bridging… waiting for delivery on ${otherChain?.displayName ?? "destination"}` });
    await track(quote.requestId, `Bridged ${human} via a fresh address. Delivered`);
    localStorage.removeItem("sw-bridge-eph"); // flow complete — discard the throwaway key
  }

  async function doBridge() {
    if (!walletProvider || !address || !q) return;
    try {
      setWorking(true);
      if (dir === "out") {
        const human = `${amt} ${sym} → ${otherChain?.displayName ?? "chain " + otherId}`;
        if (maxPriv) await bridgeOutEphemeral(human); else await bridgeOutWallet(human);
      } else {
        const human = `${amt} → ${sym} on Robinhood Chain (shielded)`;
        // record RH wallet balance before delivery — read via RH's own RPC (the wallet's active
        // chain changes to the source chain during the bridge, so custom(walletProvider) would misread).
        const rhpc = createPublicClient({ chain: chainById(RH), transport: rpcTransport(net) });
        const balBefore = token.native
          ? await rhpc.getBalance({ address: address as Address })
          : (await rhpc.readContract({ address: token.address, abi: ERC20_ABI, functionName: "balanceOf", args: [address as Address] })) as bigint;
        setStatus({ kind: "busy", msg: `Step 1/3 — bridging from ${otherChain?.displayName ?? "source"} via Relay…` });
        await execTxs(q.txs);
        setStatus({ kind: "busy", msg: "Step 2/3 — waiting for delivery on Robinhood Chain…" });
        const ok = await track(q.requestId, "Delivered on Robinhood Chain");
        if (!ok) return;
        // shield the delta that arrived — switch the wallet back to Robinhood Chain first
        await ensureChain(RH);
        let received = 0n;
        for (let i = 0; i < 15; i++) {
          const now = token.native ? await rhpc.getBalance({ address: address as Address }) : (await rhpc.readContract({ address: token.address, abi: ERC20_ABI, functionName: "balanceOf", args: [address as Address] })) as bigint;
          if (now > balBefore) { received = now - balBefore; break; }
          await sleep(3000);
        }
        if (received <= 0n) { setStatus({ kind: "ok", msg: `Delivered on Robinhood Chain. Shield it from the Shield tab.` }); return; }
        // native shield = wrap + approve + a ZK-verify deposit (gas-heavy); keep a real reserve.
        const gasReserve = parseUnits("0.0006", 18);
        if (token.native && received <= gasReserve) { setStatus({ kind: "ok", msg: `Delivered ${trim(formatUnits(received, 18))} ETH on Robinhood Chain — too small to auto-shield after gas. Shield it from the Shield tab.` }); return; }
        const toShield = token.native ? received - gasReserve : received;
        setStatus({ kind: "busy", msg: `Step 3/3 — shielding ${trim(formatUnits(toShield, token.decimals))} ${sym} into the pool…` });
        await shieldToken(token, toShield);
        setStatus({ kind: "ok", msg: `Bridged in + shielded ${trim(formatUnits(toShield, token.decimals))} ${sym}. It's private now.` });
      }
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.shortMessage ?? e?.message ?? String(e) });
    } finally {
      setWorking(false);
    }
  }

  const overBal = dir === "out" && amount > shieldedBal;
  const disabled = working || amount <= 0n || !q || otherId === RH || (dir === "out" && (!validDest || overBal));
  const label = overBal ? `Insufficient shielded ${sym}` : working ? "Bridging…" : dir === "out" ? "Bridge out privately" : "Bridge in + shield";

  // the Relay bridge content — lives INSIDE the Desk card as the "Bridge" tab
  const relayCard = (
        <div className="bridge-embed">
          <div className="bridge-dir">
            <div className="xc-dir" role="tablist">
              <button type="button" role="tab" aria-selected={dir === "out"} className={`xc-dirbtn ${dir === "out" ? "sel" : ""}`} onClick={() => { setDir("out"); setStatus(null); }}>OUT</button>
              <button type="button" role="tab" aria-selected={dir === "in"} className={`xc-dirbtn ${dir === "in" ? "sel" : ""}`} onClick={() => { setDir("in"); setSym("ETH"); setStatus(null); }}>IN</button>
            </div>
            <span className="mono-sm muted">{dir === "out" ? "Shielded → any chain, via Relay" : "Any chain → wallet → auto-shield"}</span>
          </div>

          {pendingEph && (
            <div className="status err" style={{ marginTop: 0, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <span>An interrupted bridge left funds at a temporary address ({pendingEph.address.slice(0, 8)}…{pendingEph.address.slice(-4)}).</span>
              <button className="btn sm" onClick={recoverEph} disabled={working || !isConnected}>Recover to wallet</button>
            </div>
          )}

          <div className="public-note">
            {dir === "out"
              ? <>Your <b>{sym}</b> is unshielded via the relayer (breaking the link to your shielded pool), then bridged out via Relay.</>
              : <>Bridge from another chain into your wallet via Relay, then it's <b>shielded</b> into the pool. The inbound transfer is public; your shielded activity after is private.</>}
          </div>

          <div className="asset-panel">
            <div className="ap-top">
              <span className="ap-label">{dir === "out" ? "You bridge (shielded)" : `You send (on ${otherChain?.displayName ?? "source"})`}</span>
              {dir === "out" && <span className="ap-bal">Shielded: {trim(formatUnits(shieldedBal, token.decimals))} {sym}{shieldedBal > 0n && <button type="button" className="max-chip" onClick={() => setAmt(formatUnits(shieldedBal, token.decimals))}>MAX</button>}</span>}
            </div>
            <div className="ap-main">
              <input className="ap-amount" inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} />
              {/* Bridge-in is locked to ETH (only Relay-supported native in) — show a static pill;
                  bridge-out reuses the app's searchable TokenPicker over the small ETH/USDG set. */}
              {dir === "in" ? (
                <span className="token-pill" style={{ cursor: "default" }}>
                  <TokenAvatar sym={token.symbol} logo={token.logo} size={26} />
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{token.symbol}</span>
                </span>
              ) : (
                <TokenPicker tokens={tokens} value={token} onChange={(t) => setSym(t.symbol)} />
              )}
            </div>
          </div>

          <div className="field">
            <label>{dir === "out" ? "Destination chain" : "Source chain"}</label>
            <ChainDropdown chains={chains} value={otherId} onChange={setOtherId} placeholder="Select chain" />
          </div>

          {dir === "out" && (
            <div className="field">
              <label>Recipient on {otherChain?.displayName ?? "destination"}</label>
              <input placeholder="0x…" value={dest} onChange={(e) => setDest(e.target.value)} />
            </div>
          )}

          {dir === "out" && (
            <label className="priv-toggle">
              <input type="checkbox" checked={maxPriv} onChange={(e) => setMaxPriv(e.target.checked)} />
              <span><b>Max privacy</b> — bridge via a fresh, relayer-gas-seeded address so nothing links the bridge-out to your wallet. Off = bridge from your connected wallet.</span>
            </label>
          )}

          <div className="swap-meta">
            <div className="sm-row"><span>You receive</span><span>{quoting ? "fetching…" : q ? `${trim(formatUnits(q.outAmount, q.outDecimals), 8)} ${q.outSymbol}${dir === "out" ? ` on ${otherChain?.displayName}` : " (shielded)"}` : "—"}</span></div>
            {q?.timeEstimateSec != null && <div className="sm-row dim"><span>Est. time</span><span>~{q.timeEstimateSec}s</span></div>}
            <div className="sm-row dim"><span>Route</span><span>{dir === "out" ? `Shielded → ${maxPriv ? "fresh address" : "wallet"} → Relay → ${otherChain?.displayName ?? "—"}` : `${otherChain?.displayName ?? "—"} → Relay → wallet → shield`}</span></div>
          </div>

          {!isConnected ? (
            <button className="btn block" style={{ marginTop: 14 }} onClick={onConnect}>Connect wallet</button>
          ) : (
            <button className="btn block" style={{ marginTop: 14 }} disabled={disabled} onClick={doBridge}>{label}</button>
          )}
        </div>
  );

  if (embedded) return relayCard;

  return (
    <div className="app">
      <div className="app-head">
        <div>
          <h2 style={{ fontFamily: "var(--display)", fontSize: 26, margin: 0 }}>Private Route</h2>
          <p className="muted mono-sm" style={{ margin: "4px 0 0" }}>Swap anything, anywhere — 1000+ tokens across 100 chains, with the trail broken en route. The Relay bridge lives on your Desk.</p>
        </div>
      </div>
      <XChainPanel net={net} address={address} isConnected={isConnected} onConnect={onConnect} walletProvider={walletProvider} />
    </div>
  );
}
