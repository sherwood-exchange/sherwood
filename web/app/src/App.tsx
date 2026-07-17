import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatUnits, parseUnits, getAddress, createPublicClient, http, type Address } from "viem";
import { initPoseidon, ERC20_ABI, parseAddress, chainById } from "@sherwood/client";
import { NETWORKS, DEFAULT_NETWORK, localFromDeploy, type NetworkConfig, type TokenInfo , rpcTransport } from "./config";
import { connectWithProvider, type Connection } from "./wallet";
import { useWallet } from "./wallet-connect";
import { makeClient, ensureApproval, submitSelf, submitRelayed, relayerAddress, quoteSwap, saveCache, isAsp, needsAspApproval, publishAssociationRoot, wrapEth, unwrapEth } from "./sherwood";
import { quoteRoute } from "./routing";
import { PointsPage } from "./PointsPage";
import { ReferralPage } from "./ReferralPage";
import { captureReferral } from "./points";
import { Background, Nav, Footer } from "./site";
import { Landing } from "./Landing";
import { PublicSwap } from "./PublicSwap";
import { Bridge } from "./Bridge";
import { Stake } from "./Stake";
import { Govern } from "./Govern";
import { Woodie } from "./Woodie";
import { RouteChips, TokenAvatar, TokenPicker, tokenGradient } from "./TokenUI";
import { ToastHost, toast, dismiss } from "./Toast";

type Tab = "shield" | "send" | "swap" | "withdraw" | "bridge";
type Status = { kind: "ok" | "err" | "busy"; msg: string; hash?: string } | null;
type Route = "points" | "referral" | "portfolio" | "swap" | "bridge" | "stake" | "govern" | "woodie" | "";

function parseRoute(): Route {
  const h = (location.hash || "").replace(/^#\/?/, "");
  if (h === "plan") return "woodie"; // legacy deep-link — WOODIE lived at #/plan before the announce
  return h === "points" || h === "referral" || h === "portfolio" || h === "swap" || h === "bridge" || h === "stake" || h === "govern" || h === "woodie" ? h : "";
}

export default function App() {
  const [net, setNet] = useState<NetworkConfig>(NETWORKS[DEFAULT_NETWORK]);
  const [conn, setConn] = useState<Connection | null>(null);
  const [client, setClient] = useState<ReturnType<typeof makeClient> | null>(null);
  const [tab, setTab] = useState<Tab>("shield");
  const [shielded, setShielded] = useState<Record<string, bigint>>({});
  const [clear, setClear] = useState<Record<string, bigint>>({});
  const [noteCount, setNoteCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [relayer, setRelayer] = useState<Address | null>(null);
  const [busy, setBusy] = useState(false);
  const [route, setRoute] = useState<Route>(parseRoute());
  const [amAsp, setAmAsp] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    initPoseidon();
    captureReferral(); // persist a ?ref=<address> invite until the user connects
    // if a fresh local deployment file was published, wire the local net to it
    fetch("/local-deploy.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.pool) setNet((n) => (n.key === "local" ? localFromDeploy(d) : n));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    relayerAddress(net).then(setRelayer);
  }, [net]);
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const myAddress = useMemo(() => (conn ? JSON.stringify(conn.keypair.address()) : ""), [conn]);

  // Surface desk flow status as a shared toast (busy persists; ok/error auto-dismiss + tx link).
  const setStatus = (s: Status) => {
    if (s) toast({ id: "desk", kind: s.kind === "err" ? "error" : s.kind, msg: s.msg, hash: s.hash, explorer: net.explorer });
    else dismiss("desk");
  };

  // Privy (email/social → embedded WOODIE wallet) with Reown kept for external wallets; both
  // feed the same signature-derived shielded account below. See wallet-connect.ts.
  const { address: akAddress, isConnected, walletProvider, connect: connectWallet, disconnect: disconnectWallet } = useWallet();
  const deriving = useRef(false);

  /** Open the login modal (Privy first, Reown fallback). Derivation runs in the effect below. */
  function doConnect() {
    try { connectWallet(); } catch (e: any) { setStatus({ kind: "err", msg: e?.message ?? String(e) }); }
  }

  // Derive (or re-derive) the shielded account whenever AppKit reports a fresh connection.
  useEffect(() => {
    if (!isConnected || !walletProvider || !akAddress || conn || deriving.current) return;
    deriving.current = true;
    (async () => {
      try {
        setBusy(true);
        setStatus({ kind: "busy", msg: "Deriving your shielded account from a signature…" });
        const c = await connectWithProvider(net, walletProvider as any, akAddress as Address);
        setConn(c);
        const cl = makeClient(c, net);
        setClient(cl);
        setStatus({ kind: "ok", msg: "Connected. Signature-derived account ready — your keys never left this browser." });
        await refresh(c, cl);
      } catch (e: any) {
        setStatus({ kind: "err", msg: e?.shortMessage ?? e?.message ?? String(e) });
        disconnectWallet().catch(() => {});
      } finally {
        setBusy(false);
        deriving.current = false;
      }
    })();
  }, [isConnected, walletProvider, akAddress, conn, net]);

  async function refresh(c = conn, cl = client) {
    if (!c || !cl) return;
    // 1) wallet balances FIRST — plain RPC reads, visible in ~a second. A fresh shielded
    //    account replays millions of pool blocks; users were staring at an empty desk until
    //    that finished ("my balance doesn't show up").
    const cel: Record<string, bigint> = {};
    await Promise.all(net.tokens.map(async (t) => {
      if (t.halted) { cel[t.symbol] = 0n; return; }
      cel[t.symbol] = t.native
        ? await c.publicClient.getBalance({ address: c.address }) // native ETH, not the WETH ERC20
        : ((await c.publicClient.readContract({ address: t.address, abi: ERC20_ABI, functionName: "balanceOf", args: [c.address] })) as bigint).valueOf();
    }));
    setClear(cel);
    // 2) then the shielded pool sync (chunked + concurrent), with a visible syncing state
    setSyncing(true);
    try {
      cl.invalidate();
      await cl.sync();
    } finally { setSyncing(false); }
    const sh: Record<string, bigint> = {};
    let notes = 0;
    const countedAssets = new Set<string>();
    for (const t of net.tokens) {
      if (t.halted) { sh[t.symbol] = 0n; continue; }
      sh[t.symbol] = cl.balance(t.address);
      const key = t.address.toLowerCase();
      if (!countedAssets.has(key)) { countedAssets.add(key); notes += cl.utxos(t.address).length; } // ETH & WETH share an assetId — count once
    }
    setShielded(sh);
    setNoteCount(notes);
    saveCache(cl, net, c.address); // persist incremental-sync cache
    try {
      setAmAsp(await isAsp(c, net));
      setPendingApproval(await needsAspApproval(c, net, cl));
    } catch {
      /* read failure — leave prior state */
    }
  }

  function doDisconnect() {
    disconnectWallet().catch(() => {});
    setConn(null);
    setClient(null);
    setShielded({});
    setClear({});
    setNoteCount(0);
    setStatus(null);
    setAmAsp(false);
    setPendingApproval(false);
    setTab("shield");
  }

  async function copyAddr() {
    try {
      await navigator.clipboard.writeText(myAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  async function doApprove() {
    if (!conn || !client) return;
    await run(async () => {
      const hash = await publishAssociationRoot(conn, net, client);
      return hash;
    }, "Approve deposits (ASP) — publish association root");
  }

  async function run(fn: () => Promise<string>, label: string) {
    if (!conn || !client) return;
    try {
      setBusy(true);
      setStatus({ kind: "busy", msg: `${label} — generating zero-knowledge proof (this can take a few seconds)…` });
      const hash = await fn();
      setStatus({ kind: "ok", msg: `${label} confirmed.`, hash });
      await refresh();
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.shortMessage ?? e?.message ?? String(e) });
      await refresh().catch(() => {}); // reconcile state (frees any reserved notes) so a retry works
    } finally {
      setBusy(false);
    }
  }

  /** Send `amount` privately, splitting across labels automatically. A join-split can only
   *  spend up to 2 notes sharing ONE label, so value spread over several deposits is sent as
   *  several transfers — resyncing between each so the next part sees the spent notes + change. */
  async function sendMulti(token: TokenInfo, amount: bigint, to: ReturnType<typeof parseAddress>) {
    if (!conn || !client) return;
    const human = `${formatUnits(amount, token.decimals)} ${token.symbol}`;
    try {
      setBusy(true);
      let remaining = amount;
      let part = 0;
      let lastHash = "";
      while (remaining > 0n) {
        const maxOne = client.maxSpendable(token.address);
        if (maxOne <= 0n) {
          if (part === 0) throw new Error(`no spendable ${token.symbol} notes`);
          throw new Error(`sent ${formatUnits(amount - remaining, token.decimals)} of ${human}, but the rest is fragmented — retry to continue`);
        }
        const chunk = remaining < maxOne ? remaining : maxOne;
        part++;
        const suffix = amount > maxOne ? ` — part ${part} (${formatUnits(chunk, token.decimals)})` : "";
        setStatus({ kind: "busy", msg: `Sending ${human}${suffix} — generating zero-knowledge proof…` });
        const tx = await client.buildTransfer(token.address, chunk, to, relayerOpts(relayer));
        lastHash = await submitRelayed(conn, net, tx);
        remaining -= chunk;
        if (remaining > 0n) {
          client.invalidate();
          await client.sync(); // reflect spent inputs + change note before choosing the next label
        }
      }
      setStatus({ kind: "ok", msg: `Sent ${human}${part > 1 ? ` in ${part} transfers` : ""}.`, hash: lastHash });
      await refresh();
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.shortMessage ?? e?.message ?? String(e) });
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  /** Swap `amount` privately, splitting across labels automatically (same label limit as a send).
   *  Each chunk gets a proportional slippage floor — smaller chunks have less price impact, so a
   *  floor derived from the full-size quote is conservative. Proceeds re-shield per chunk. */
  async function swapMulti(tokenIn: TokenInfo, amount: bigint, tokenOut: TokenInfo, minOut: bigint) {
    if (!conn || !client) return;
    const human = `${formatUnits(amount, tokenIn.decimals)} ${tokenIn.symbol}→${tokenOut.symbol}`;
    try {
      setBusy(true);
      let remaining = amount;
      let part = 0;
      let lastHash = "";
      while (remaining > 0n) {
        const maxOne = client.maxSpendable(tokenIn.address);
        if (maxOne <= 0n) {
          if (part === 0) throw new Error(`no spendable ${tokenIn.symbol} notes`);
          throw new Error(`swapped ${formatUnits(amount - remaining, tokenIn.decimals)} of ${human}, but the rest is fragmented — retry to continue`);
        }
        const chunk = remaining < maxOne ? remaining : maxOne;
        const minOutChunk = (minOut * chunk) / amount; // proportional floor (conservative)
        part++;
        const suffix = amount > maxOne ? ` — part ${part} (${formatUnits(chunk, tokenIn.decimals)})` : "";
        setStatus({ kind: "busy", msg: `Swapping ${human}${suffix} — generating zero-knowledge proof…` });
        const tx = await client.buildSwap(tokenIn.address, chunk, tokenOut.address, {
          minAmountOut: minOutChunk,
          poolFee: net.poolFee,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
          ...relayerOpts(relayer),
        });
        lastHash = await submitRelayed(conn, net, tx);
        remaining -= chunk;
        if (remaining > 0n) {
          client.invalidate();
          await client.sync();
        }
      }
      setStatus({ kind: "ok", msg: `Swapped ${human}${part > 1 ? ` in ${part} swaps` : ""}.`, hash: lastHash });
      await refresh();
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.shortMessage ?? e?.message ?? String(e) });
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  /** Unshield `amount` to `recipient`, splitting across labels automatically. For a native-ETH
   *  withdrawal to yourself the delivered WETH is unwrapped once at the end. */
  async function withdrawMulti(token: TokenInfo, amount: bigint, recipient: ReturnType<typeof getAddress>) {
    if (!conn || !client) return;
    const human = `${formatUnits(amount, token.decimals)} ${token.symbol}`;
    const isSelfNative = !!token.native && recipient.toLowerCase() === myAddress?.toLowerCase();
    let delivered = 0n;
    try {
      setBusy(true);
      let remaining = amount;
      let part = 0;
      let lastHash = "";
      while (remaining > 0n) {
        const maxOne = client.maxSpendable(token.address);
        if (maxOne <= 0n) {
          if (part === 0) throw new Error(`no spendable ${token.symbol} notes`);
          throw new Error(`withdrew ${formatUnits(delivered, token.decimals)} of ${human}, but the rest is fragmented — retry to continue`);
        }
        const chunk = remaining < maxOne ? remaining : maxOne;
        part++;
        const suffix = amount > maxOne ? ` — part ${part} (${formatUnits(chunk, token.decimals)})` : "";
        setStatus({ kind: "busy", msg: `Withdrawing ${human}${suffix} — generating zero-knowledge proof…` });
        const tx = await client.buildUnshield(token.address, chunk, recipient, relayerOpts(relayer));
        lastHash = await submitRelayed(conn, net, tx);
        delivered += chunk;
        remaining -= chunk;
        if (remaining > 0n) {
          client.invalidate();
          await client.sync();
        }
      }
      if (isSelfNative) await unwrapEth(conn, token.address, delivered); // WETH → ETH, once for the full amount
      setStatus({ kind: "ok", msg: `Withdrew ${human}${part > 1 ? ` in ${part} transfers` : ""}.`, hash: lastHash });
      await refresh();
    } catch (e: any) {
      // best-effort: unwrap whatever WETH was already delivered to self so it isn't stranded
      if (isSelfNative && delivered > 0n) { try { await unwrapEth(conn, token.address, delivered); } catch { /* leave as WETH */ } }
      setStatus({ kind: "err", msg: e?.shortMessage ?? e?.message ?? String(e) });
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  /** Private Bridge helper: unshield `amount` of `token` to `recipient` via the relayer (multi-tx
   *  across labels), unwrapping to native ETH when a native token lands in the user's own wallet. */
  async function unshieldToken(token: TokenInfo, amount: bigint, recipient: Address) {
    if (!conn || !client) throw new Error("not connected");
    const isSelfNative = !!token.native && recipient.toLowerCase() === conn.address.toLowerCase();
    let remaining = amount, delivered = 0n;
    while (remaining > 0n) {
      const maxOne = client.maxSpendable(token.address);
      if (maxOne <= 0n) throw new Error(`insufficient shielded ${token.symbol}`);
      const chunk = remaining < maxOne ? remaining : maxOne;
      const tx = await client.buildUnshield(token.address, chunk, recipient, relayerOpts(relayer));
      await submitRelayed(conn, net, tx);
      delivered += chunk; remaining -= chunk;
      if (remaining > 0n) { client.invalidate(); await client.sync(); }
    }
    if (isSelfNative) await unwrapEth(conn, token.address, delivered);
    await refresh();
  }

  /** Private Bridge helper (bridge-in): shield `amount` of `token` from the wallet into the pool. */
  async function shieldToken(token: TokenInfo, amount: bigint) {
    if (!conn || !client) throw new Error("not connected");
    if (token.native) await wrapEth(conn, token.address, amount); // ETH → WETH first
    await ensureApproval(conn, net, token.address, amount);
    const tx = await client.buildShield(token.address, amount);
    await submitSelf(conn, net, tx);
    await refresh();
  }

  const tokenBySymbol = (s: string) => net.tokens.find((t) => t.symbol === s)!;

  return (
    <>
      <Background still={route === "woodie"} />
      {route === "woodie" && <div className="woodie-backdrop" aria-hidden />}
      <Nav
        net={net}
        inApp={!!conn}
        onNet={(n) => {
          setNet(n);
          setConn(null);
          setClient(null);
        }}
        right={
          conn ? (
            <WalletMenu net={net} conn={conn} shielded={shielded} clear={clear} onDisconnect={doDisconnect} />
          ) : (
            <button className="btn sm" onClick={doConnect} disabled={busy}>
              Connect
            </button>
          )
        }
      />

      <div className="page-body">
      {route === "swap" ? (
        <PublicSwap net={net} walletProvider={walletProvider} address={akAddress} isConnected={isConnected} onConnect={doConnect} />
      ) : route === "bridge" ? (
        <Bridge
          net={net} walletProvider={walletProvider} address={akAddress} isConnected={isConnected} onConnect={doConnect}
          tokens={net.tokens.filter((t) => t.symbol === "ETH" || t.symbol === "USDG")}
          shielded={shielded} unshieldToken={unshieldToken} shieldToken={shieldToken}
        />
      ) : route === "stake" ? (
        <Stake net={net} walletProvider={walletProvider} address={akAddress} isConnected={isConnected} onConnect={doConnect} />
      ) : route === "woodie" ? (
        <Woodie
          net={net} walletProvider={walletProvider} address={akAddress} isConnected={isConnected} onConnect={doConnect}
          shielded={shielded} clear={clear}
          shieldToken={shieldToken} sendMulti={sendMulti} swapMulti={swapMulti} withdrawMulti={withdrawMulti}
          tokenBySymbol={tokenBySymbol}
          parseShieldedAddress={(s) => parseAddress(JSON.parse(s))}
        />
      ) : route === "govern" ? (
        <Govern net={net} walletProvider={walletProvider} address={akAddress} isConnected={isConnected} onConnect={doConnect} />
      ) : route === "points" ? (
        <PointsPage net={net} conn={conn} onConnect={doConnect} busy={busy} />
      ) : route === "referral" ? (
        <ReferralPage net={net} conn={conn} onConnect={doConnect} busy={busy} />
      ) : route === "portfolio" ? (
        <PortfolioPage
          net={net}
          conn={conn}
          shielded={shielded}
          clear={clear}
          noteCount={noteCount}
          myAddress={myAddress}
          copied={copied}
          onCopy={copyAddr}
          onConnect={doConnect}
          onRefresh={() => refresh()}
          busy={busy}
          relayer={relayer}
        />
      ) : !conn ? (
        <Landing onConnect={doConnect} busy={busy} />
      ) : (
        <div className="app">
          <div className="app-head">
            <div>
              <h2 style={{ fontFamily: "var(--display)", fontSize: 26, margin: 0 }}>Desk</h2>
              <p className="muted mono-sm" style={{ margin: "4px 0 0" }}>
                Shield, move and trade privately — keys never left your browser.
              </p>
            </div>
          </div>

          {/* shielded holdings at a glance */}
          <div className="desk-sum">
            {net.tokens
              .filter((t, i) => net.tokens.findIndex((x) => x.address === t.address) === i)
              .filter((t) => (shielded[t.symbol] ?? 0n) > 0n)
              .map((t) => (
                <span className="ds-chip" key={t.symbol} title={`${formatUnits(shielded[t.symbol]!, t.decimals)} ${t.symbol} shielded`}>
                  <TokenAvatar sym={t.symbol} logo={t.logo} size={18} />
                  {trimAmt(formatUnits(shielded[t.symbol]!, t.decimals), 4)} {t.symbol}
                </span>
              ))}
            {syncing ? (
              <span className="ds-chip empty"><span className="spin dark" style={{ width: 12, height: 12 }} />Syncing the shielded pool…</span>
            ) : Object.values(shielded).every((v) => (v ?? 0n) === 0n) && (
              <span className="ds-chip empty">Nothing shielded yet — start below 🛡</span>
            )}
            <a className="ds-chip link" href="#/portfolio">Portfolio →</a>
          </div>

          {pendingApproval && (
            <div className="status ok" style={{ marginTop: 0, marginBottom: 18, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              {amAsp ? (
                <>
                  <span>You are the ASP. New deposits are awaiting approval — publish the association root so notes can be spent.</span>
                  <button className="btn sm" onClick={doApprove} disabled={busy}>Approve deposits</button>
                </>
              ) : (
                <span>Your deposit's label is awaiting ASP approval. Spending is gated until the association root is published.</span>
              )}
            </div>
          )}

          <div className="desk-one">
          <section className="card">
            <div className="tabs">
              {(["shield", "send", "swap", "withdraw", "bridge"] as Tab[]).map((t) => (
                <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {tab === "shield" && (
              <ShieldForm
                net={net}
                busy={busy}
                balances={clear}
                onSubmit={(token, amount) =>
                  run(async () => {
                    if (token.native) await wrapEth(conn!, token.address, amount); // ETH → WETH first
                    await ensureApproval(conn!, net, token.address, amount);
                    const tx = await client!.buildShield(token.address, amount);
                    return submitSelf(conn!, net, tx);
                  }, `Shield ${formatUnits(amount, token.decimals)} ${token.symbol}`)
                }
              />
            )}
            {tab === "send" && (
              <SendForm
                net={net}
                busy={busy}
                balances={shielded}
                myAddress={myAddress}
                onSubmit={(token, amount, to) => sendMulti(token, amount, to)}
              />
            )}
            {tab === "swap" && (
              <SwapForm
                net={net}
                busy={busy}
                balances={shielded}
                quote={(tin, tout, amt, bps) => quoteSwap(conn!, net, tin, tout, amt, bps)}
                onSubmit={(tokenIn, amount, tokenOut, minOut) => swapMulti(tokenIn, amount, tokenOut, minOut)}
              />
            )}
            {tab === "withdraw" && (
              <WithdrawForm
                net={net}
                busy={busy}
                balances={shielded}
                onSubmit={(token, amount, recipient) => withdrawMulti(token, amount, recipient)}
              />
            )}
            {tab === "bridge" && (
              <Bridge
                embedded
                net={net} walletProvider={walletProvider} address={akAddress} isConnected={isConnected} onConnect={doConnect}
                tokens={net.tokens.filter((t) => t.symbol === "ETH" || t.symbol === "USDG")}
                shielded={shielded} unshieldToken={unshieldToken} shieldToken={shieldToken}
              />
            )}
          </section>

          </div>
        </div>
      )}
      </div>

      <Footer />
      <ToastHost />
    </>
  );
}

const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

/** Header wallet control: one pill showing the connected address that expands into a menu
 *  (full address + copy, total value in $, Portfolio link, Disconnect). Replaces the separate
 *  address-pill + Disconnect-button pair. */
function WalletMenu({ net, conn, shielded, clear, onDisconnect }: {
  net: NetworkConfig; conn: Connection; shielded: Record<string, bigint>; clear: Record<string, bigint>; onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const ref = useRef<HTMLDivElement>(null);
  const addr = conn.address;

  // Estimated USD price per token: quote 1 token → USDG (USDG ≈ $1).
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, number> = {};
      for (const t of net.tokens) {
        if (t.halted) continue;
        if (t.address.toLowerCase() === USDG_ADDR.toLowerCase()) { out[t.symbol] = 1; continue; }
        try {
          const usdg = await quoteRoute(conn.publicClient as any, t.address, USDG_ADDR as Address, parseUnits("1", t.decimals));
          if (usdg != null && usdg > 0n) out[t.symbol] = Number(usdg) / 1e6;
        } catch { /* skip */ }
      }
      if (alive) setPrices(out);
    })();
    return () => { alive = false; };
  }, [conn, net]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const usdOf = (sym: string, amount: bigint, decimals: number) => { const p = prices[sym]; return p == null ? 0 : p * Number(formatUnits(amount, decimals)); };
  const uniq = net.tokens.filter((t, i) => net.tokens.findIndex((x) => x.address === t.address) === i);
  const totalSh = uniq.reduce((s, t) => (t.halted ? s : s + usdOf(t.symbol, shielded[t.symbol] ?? 0n, t.decimals)), 0);
  const totalCl = net.tokens.reduce((s, t) => (t.halted ? s : s + usdOf(t.symbol, clear[t.symbol] ?? 0n, t.decimals)), 0);
  const total = totalSh + totalCl;

  const copy = async () => { try { await navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };

  return (
    <div className="wallet-menu" ref={ref}>
      <button className={`pill wallet-pill${open ? " open" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <em className="pf-dot wallet" aria-hidden />
        <span className="mono-sm">{addr.slice(0, 6)}…{addr.slice(-4)}</span>
        <span className="wm-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="wallet-pop" role="menu">
          <div className="wm-addr-row">
            <span className="wm-addr mono-sm">{addr.slice(0, 12)}…{addr.slice(-8)}</span>
            <button className="btn ghost xs" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
          </div>
          <div className="wm-value">
            <span className="wm-value-label">Wallet value</span>
            <span className="wm-value-total">{fmtUsd(total)}</span>
          </div>
          <div className="wm-split">
            <span><em className="pf-dot shielded" aria-hidden />Shielded {fmtUsd(totalSh)}</span>
            <span><em className="pf-dot wallet" aria-hidden />Wallet {fmtUsd(totalCl)}</span>
          </div>
          <div className="wm-actions">
            <a className="btn ghost sm" href="#/portfolio" onClick={() => setOpen(false)}>Portfolio →</a>
            <button className="btn ghost sm wm-disc" onClick={() => { setOpen(false); onDisconnect(); }}>Disconnect</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PortfolioPage({ net, conn, shielded, clear, noteCount, myAddress, copied, onCopy, onConnect, onRefresh, busy, relayer }: {
  net: NetworkConfig; conn: Connection | null; shielded: Record<string, bigint>; clear: Record<string, bigint>;
  noteCount: number; myAddress: string; copied: boolean; onCopy: () => void; onConnect: () => void; onRefresh: () => void; busy: boolean; relayer: Address | null;
}) {
  // Estimated USD price per token: quote 1 token → USDG (USDG ≈ $1). Computed on connect.
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [pfSeg, setPfSeg] = useState<"all" | "shielded" | "wallet">("all");
  useEffect(() => {
    if (!conn) return;
    let alive = true;
    (async () => {
      const out: Record<string, number> = {};
      for (const t of net.tokens) {
        if (t.halted) continue;
        if (t.address.toLowerCase() === USDG_ADDR.toLowerCase()) { out[t.symbol] = 1; continue; }
        try {
          const usdg = await quoteRoute(conn.publicClient as any, t.address, USDG_ADDR as Address, parseUnits("1", t.decimals));
          if (usdg != null && usdg > 0n) out[t.symbol] = Number(usdg) / 1e6;
        } catch { /* skip */ }
      }
      if (alive) setPrices(out);
    })();
    return () => { alive = false; };
  }, [conn, net]);

  const usdOf = (sym: string, amount: bigint, decimals: number): number | undefined => {
    const p = prices[sym];
    if (p == null) return undefined;
    return p * Number(formatUnits(amount, decimals));
  };

  if (!conn) {
    return (
      <div className="app app-narrow">
        <div className="app-head">
          <div>
            <h2 style={{ fontFamily: "var(--display)", fontSize: 26, margin: 0 }}>Portfolio</h2>
            <p className="muted mono-sm" style={{ margin: "4px 0 0" }}>Your shielded + wallet balances.</p>
          </div>
          <a className="btn ghost sm" href="#top">← Desk</a>
        </div>
        <section className="card" style={{ textAlign: "center" }}>
          <p className="hint">Connect your wallet to view your portfolio.</p>
          <button className="btn" onClick={onConnect} disabled={busy}>Connect wallet</button>
        </section>
      </div>
    );
  }

  const shieldedTokens = net.tokens.filter((t, i) => net.tokens.findIndex((x) => x.address === t.address) === i);
  const totalSh = shieldedTokens.reduce((s, t) => (t.halted ? s : s + (usdOf(t.symbol, shielded[t.symbol] ?? 0n, t.decimals) ?? 0)), 0);
  const totalCl = net.tokens.reduce((s, t) => (t.halted ? s : s + (usdOf(t.symbol, clear[t.symbol] ?? 0n, t.decimals) ?? 0)), 0);
  const totalAll = totalSh + totalCl;

  // Uniswap-style table rows: one row per token for the active segment.
  const rows = shieldedTokens
    .filter((t) => !t.halted)
    .map((t) => {
      const sh = shielded[t.symbol] ?? 0n;
      const cl = clear[t.symbol] ?? 0n;
      const amount = pfSeg === "shielded" ? sh : pfSeg === "wallet" ? cl : sh + cl;
      return { t, amount, usd: usdOf(t.symbol, amount, t.decimals), price: prices[t.symbol] };
    })
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

  return (
    <div className="app">
      {/* identity header */}
      <div className="pf-id">
        <span className="pf-ava" style={{ backgroundImage: tokenGradient(conn.address) }} />
        <div className="pf-id-meta">
          <b>{conn.address.slice(0, 6)}…{conn.address.slice(-4)}</b>
          <button type="button" className="pf-id-sub" onClick={onCopy} title="Copy your Sherwood shielded address">
            {copied ? "Copied ✓" : `sherwood ${myAddress.slice(0, 18)}… ⧉`}
          </button>
        </div>
        <div className="pf-id-right">
          <button className="btn ghost sm" onClick={onRefresh} disabled={busy}>↻ Refresh</button>
          {net.explorer && <a className="btn ghost sm" href={`${net.explorer}/address/${conn.address}`} target="_blank" rel="noreferrer">Explorer ↗</a>}
        </div>
      </div>

      <div className="pf-grid">
        {/* left: value + tokens table */}
        <div className="pf-main">
          <div className="pf-hero2">
            <span className="pf-hero-total">{fmtUsd(totalAll)}</span>
            <div className="pf-hero-split">
              <span className="pf-chip"><em className="pf-dot shielded" />Shielded {fmtUsd(totalSh)}</span>
              <span className="pf-chip"><em className="pf-dot wallet" />Wallet {fmtUsd(totalCl)}</span>
              <span className="pf-chip">{noteCount} note{noteCount === 1 ? "" : "s"}</span>
            </div>
          </div>

          <div className="pf-tokens-head">
            <h2>Tokens</h2>
            <div className="tabs" style={{ margin: 0 }}>
              {(["all", "shielded", "wallet"] as const).map((s) => (
                <button key={s} className={`tab ${pfSeg === s ? "active" : ""}`} onClick={() => setPfSeg(s)}>{s[0].toUpperCase() + s.slice(1)}</button>
              ))}
            </div>
          </div>
          <div className="pf-th2 mono-sm"><span>Token</span><span>Price</span><span>Balance</span><span>Value</span></div>
          <ul className="holdings pf-table2">
            {rows.map(({ t, amount, usd, price }) => (
              <PfRow key={t.symbol} t={t} amount={amount} usd={usd} price={price} seg={pfSeg} />
            ))}
          </ul>
        </div>

        {/* right: quick actions + shielded address */}
        <div className="pf-side">
          <div className="pf-actions">
            <a className="pf-action" href="#/"><span className="pf-ico" aria-hidden>↑</span>Send</a>
            <button className="pf-action" onClick={onCopy}><span className="pf-ico" aria-hidden>↓</span>{copied ? "Copied ✓" : "Receive"}</button>
            <a className="pf-action" href="#/bridge"><span className="pf-ico" aria-hidden>+</span>Buy</a>
            <a className="pf-action" href="#/swap"><span className="pf-ico" aria-hidden>⇄</span>Swap</a>
          </div>
          <section className="card pf-addr">
            <h2>Sherwood address</h2>
            <p className="hint">Share this to receive private notes — it is not your wallet address.</p>
            <div className="addr-row">
              <code className="addr mono-sm">{myAddress}</code>
              <button className="btn ghost sm addr-copy" onClick={onCopy}>{copied ? "Copied ✓" : "Copy"}</button>
            </div>
          </section>
          <section className="card pf-addr">
            <h2>Activity</h2>
            <p className="hint">Shielded activity leaves no trace here — that's the point. Public history lives on the explorer.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

/** Uniswap-style token table row: Token | Price | Balance | Value, click to expand actions. */
function PfRow({ t, amount, usd, price, seg }: { t: TokenInfo; amount: bigint; usd?: number; price?: number; seg: "all" | "shielded" | "wallet" }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`holding ${amount === 0n ? "zero" : ""} ${open ? "open" : ""}`}>
      <button type="button" className="holding-row pf-tr2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="pf-cell-tok">
          <TokenAvatar sym={t.symbol} logo={t.logo} size={34} className="tok-badge" />
          <span className="holding-meta">
            <span className="holding-sym">{t.symbol}</span>
            <span className="holding-name">{t.name ?? TOKEN_NAMES[t.symbol] ?? t.symbol}</span>
          </span>
        </span>
        <span className="pf-cell">{price != null ? fmtUsd(price).replace("≈ ", "") : "—"}</span>
        <span className="pf-cell">{trimAmt(formatUnits(amount, t.decimals))}</span>
        <span className="pf-cell val">{usd != null ? fmtUsd(usd).replace("≈ ", "") : "—"}</span>
      </button>
      {open && (
        <div className="holding-x">
          <div className="holding-x-rows mono-sm">
            <span>Exact balance</span><b>{formatUnits(amount, t.decimals)} {t.symbol}</b>
          </div>
          <div className="holding-x-actions">
            <a className="btn ghost sm" href="#/">{seg === "wallet" ? "Shield" : "Send privately"}</a>
            <a className="btn ghost sm" href="#/swap">Swap</a>
            {t.symbol === "SWOOD" && <a className="btn ghost sm" href="#/stake">Stake</a>}
          </div>
        </div>
      )}
    </li>
  );
}

const relayerOpts = (relayer: Address | null) =>
  relayer ? { relayer, fee: 0n } : {};

function useAmount(token: TokenInfo, v: string): bigint {
  try {
    return parseUnits(v || "0", token.decimals);
  } catch {
    return 0n;
  }
}

/** Estimated USD value of `amt` of `token`, priced via USDG (≈ $1) through the public quoter.
 *  Returns null while loading or if the token has no route to USDG. */
function useUsdValue(net: NetworkConfig, token: TokenInfo, amt: string): number | null {
  const pc = useMemo(() => createPublicClient({ chain: chainById(net.chainId), transport: rpcTransport(net) }), [net]);
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      if (token.address.toLowerCase() === USDG_ADDR.toLowerCase()) { if (live) setPrice(1); return; }
      try {
        const p = await quoteRoute(pc, token.address as Address, USDG_ADDR as Address, parseUnits("1", token.decimals));
        if (live) setPrice(p ? Number(formatUnits(p, 6)) : null);
      } catch { if (live) setPrice(null); }
    })();
    return () => { live = false; };
  }, [token.address, net]);
  return price != null && amt ? price * (parseFloat(amt) || 0) : null;
}

const TOKEN_NAMES: Record<string, string> = {
  ETH: "Ether", WETH: "Wrapped Ether", USDG: "Global Dollar",
  CASHCAT: "Cash Cat", JUGGERNAUT: "Juggernaut", HOODRAT: "Hoodrat",
  VIRTUAL: "Virtual", VEX: "Vex", AAPL: "Apple", TSLA: "Tesla", NVDA: "Nvidia",
};

/** DEX version each desk token's ETH leg executes on — display-only mirror of routing.ts
 *  (stocks are all v4; hub tokens have no leg). */
const DESK_DEX: Record<string, string> = { USDG: "v4", CASHCAT: "v3", JUGGERNAUT: "v3", HOODRAT: "v2", VIRTUAL: "v2", VEX: "v2²" };

/** Deterministic gradient per ticker so each token badge is stable + distinct. */
function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "≈ $" + n.toFixed(4);
  return "≈ $" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** One portfolio row: token badge + name + amount + estimated USD value (Zerion-style). */
function Holding({ sym, name, amount, decimals, muted, halted, usd, logo }: { sym: string; name?: string; amount: bigint; decimals: number; muted?: boolean; halted?: boolean; usd?: number; logo?: string }) {
  const [open, setOpen] = useState(false);
  const human = Number(formatUnits(amount, decimals));
  const price = usd != null && human > 0 ? usd / human : undefined;
  return (
    <li className={`holding ${halted ? "halted" : amount === 0n ? "zero" : ""} ${open ? "open" : ""}`}>
      <button type="button" className="holding-row" onClick={() => !halted && setOpen((o) => !o)} aria-expanded={open}>
        <TokenAvatar sym={sym} logo={logo} size={36} className="tok-badge" />
        <span className="holding-meta">
          <span className="holding-sym">{sym}</span>
          <span className="holding-name">{halted ? "Deposit & trading halted" : name ?? TOKEN_NAMES[sym] ?? sym}</span>
        </span>
        {halted ? (
          <span className="holding-badge">HALTED</span>
        ) : (
          <span className="holding-vals">
            <span className={`holding-amt ${muted ? "muted" : ""}`}>{trimAmt(formatUnits(amount, decimals))}</span>
            {amount > 0n && usd != null && <span className="holding-usd">{fmtUsd(usd)}</span>}
          </span>
        )}
      </button>
      {open && !halted && (
        <div className="holding-x">
          <div className="holding-x-rows mono-sm">
            <span>Balance</span><b>{formatUnits(amount, decimals)} {sym}</b>
            <span>Price</span><b>{price != null ? fmtUsd(price) : "—"}</b>
            <span>Value</span><b>{usd != null ? fmtUsd(usd) : "—"}</b>
          </div>
          <div className="holding-x-actions">
            <a className="btn ghost sm" href="#/">{muted ? "Shield" : "Send privately"}</a>
            <a className="btn ghost sm" href="#/swap">Swap</a>
            {sym === "SWOOD" && <a className="btn ghost sm" href="#/stake">Stake</a>}
          </div>
        </div>
      )}
    </li>
  );
}

/** Trim a decimal string to `n` fractional digits for compact display (no rounding). */
function trimAmt(s: string, n = 6): string {
  const [i, d] = s.split(".");
  return d ? `${i}.${d.slice(0, n)}` : i;
}

/** Desk token selector — the shared searchable TokenPicker over the pool's allowlisted tokens
 *  (same UI as the public aggregator). No favorites/import: the shielded pool is a fixed set.
 *  Tokenized stocks group under their own section; rows show the balance the form already holds. */
function DeskPill({ net, sym, onSym, balances }: { net: NetworkConfig; sym: string; onSym: (s: string) => void; balances?: Record<string, bigint> }) {
  const sel = useMemo(() => net.tokens.filter((t) => !t.halted).map((t) => ({ ...t, name: t.name ?? TOKEN_NAMES[t.symbol] ?? t.symbol })), [net]);
  const value = sel.find((t) => t.symbol === sym) ?? sel[0];
  const stocks = useMemo(() => new Set(net.tokens.filter((t) => t.stock).map((t) => t.address.toLowerCase())), [net]);
  return (
    <TokenPicker
      tokens={sel}
      value={value}
      onChange={(t) => onSym(t.symbol)}
      isStock={(t) => stocks.has(t.address.toLowerCase())}
      balOf={balances ? (t) => { const b = balances[t.symbol]; return b != null && b > 0n ? trimAmt(formatUnits(b, t.decimals)) : undefined; } : undefined}
    />
  );
}

/** Uniswap-style amount panel: big amount input on the left, token pill on the right,
 *  with a balance + MAX readout. `readOnly` (swap output) shows a quote instead of input. */
function AssetPanel({ label, amount, onAmount, balance, decimals, onMax, readOnly, quoting, pill, usd }: {
  label: string; amount: string; onAmount?: (v: string) => void; balance?: bigint; decimals: number;
  onMax?: (v: string) => void; readOnly?: boolean; quoting?: boolean; pill: ReactNode; usd?: number | null;
}) {
  return (
    <div className="asset-panel">
      <div className="ap-top">
        <span className="ap-label">{label}</span>
        {balance != null && (
          <span className="ap-bal">
            Balance: {trimAmt(formatUnits(balance, decimals))}
            {onMax && balance > 0n && <button type="button" className="max-chip" onClick={() => onMax(formatUnits(balance, decimals))}>MAX</button>}
          </span>
        )}
      </div>
      <div className="ap-main">
        {readOnly ? (
          <div className={`ap-amount ap-readonly ${amount ? "" : "muted"}`}>{quoting ? <span className="skel skel-amt" /> : amount || "0.0"}</div>
        ) : (
          <input className="ap-amount" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => onAmount?.(e.target.value)} />
        )}
        {pill}
      </div>
      {usd != null && usd > 0 && <div className="ap-usd">{fmtUsd(usd)}</div>}
    </div>
  );
}

function ShieldForm({ net, busy, balances, onSubmit }: { net: NetworkConfig; busy: boolean; balances: Record<string, bigint>; onSubmit: (t: TokenInfo, amt: bigint) => void }) {
  const [sym, setSym] = useState(net.tokens[0].symbol);
  const [amt, setAmt] = useState("");
  const token = net.tokens.find((t) => t.symbol === sym)!;
  const value = useAmount(token, amt);
  const usd = useUsdValue(net, token, amt);
  return (
    <>
      <h2>Shield</h2>
      <p className="hint">Deposit tokens from your wallet into a private note. Your wallet approves + sends this one.</p>
      <AssetPanel
        label="You deposit"
        amount={amt}
        onAmount={setAmt}
        balance={balances[sym] ?? 0n}
        decimals={token.decimals}
        onMax={setAmt}
        usd={usd}
        pill={<DeskPill net={net} sym={sym} onSym={setSym} balances={balances} />}
      />
      <button className="btn block" style={{ marginTop: 16 }} disabled={busy || value <= 0n} onClick={() => onSubmit(token, value)}>
        Shield {sym}
      </button>
    </>
  );
}

function SendForm({ net, busy, balances, myAddress, onSubmit }: { net: NetworkConfig; busy: boolean; balances: Record<string, bigint>; myAddress: string; onSubmit: (t: TokenInfo, amt: bigint, to: ReturnType<typeof parseAddress>) => void }) {
  const [sym, setSym] = useState(net.tokens[0].symbol);
  const [amt, setAmt] = useState("");
  const [to, setTo] = useState("");
  const token = net.tokens.find((t) => t.symbol === sym)!;
  const value = useAmount(token, amt);
  const usd = useUsdValue(net, token, amt);
  let parsed: ReturnType<typeof parseAddress> | null = null;
  try {
    parsed = to ? parseAddress(JSON.parse(to)) : null;
  } catch {
    parsed = null;
  }
  return (
    <>
      <h2>Private send</h2>
      <p className="hint">Move a note to another Sherwood address. Nothing moves on-chain; only they can discover it. Large amounts split across deposits are sent as several transfers automatically.</p>
      <AssetPanel
        label="You send"
        amount={amt}
        onAmount={setAmt}
        balance={balances[sym] ?? 0n}
        decimals={token.decimals}
        onMax={setAmt}
        usd={usd}
        pill={<DeskPill net={net} sym={sym} onSym={setSym} balances={balances} />}
      />
      <div className="field">
        <label>Recipient Sherwood address</label>
        <textarea className="addr-input" placeholder='{"pubKey":"0x…","viewPub":"0x…"}' value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <button
        className="btn block"
        style={{ marginTop: 4 }}
        disabled={busy || value <= 0n || !parsed}
        onClick={() => parsed && onSubmit(token, value, parsed)}
      >
        Send privately
      </button>
    </>
  );
}

function SwapForm({ net, busy, balances, quote, onSubmit }: { net: NetworkConfig; busy: boolean; balances: Record<string, bigint>; quote: (tin: Address, tout: Address, amt: bigint, bps: number) => Promise<{ amountOut: bigint; minOut: bigint } | null>; onSubmit: (tin: TokenInfo, amt: bigint, tout: TokenInfo, minOut: bigint) => void }) {
  const [inSym, setInSym] = useState(net.tokens[0].symbol);
  const [outSym, setOutSym] = useState(net.tokens[1]?.symbol ?? net.tokens[0].symbol);
  const [amt, setAmt] = useState("");
  const [slippage, setSlippage] = useState("0.5"); // percent
  const [q, setQ] = useState<{ amountOut: bigint; minOut: bigint } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [manualMin, setManualMin] = useState("");
  const tin = net.tokens.find((t) => t.symbol === inSym)!;
  const tout = net.tokens.find((t) => t.symbol === outSym)!;
  const value = useAmount(tin, amt);
  const bps = Math.round((parseFloat(slippage) || 0) * 100);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // debounced live quote
  useEffect(() => {
    setQ(null);
    if (timer.current) clearTimeout(timer.current);
    if (value <= 0n || inSym === outSym) return;
    setQuoting(true);
    timer.current = setTimeout(async () => {
      try {
        setQ(await quote(tin.address, tout.address, value, bps));
      } catch {
        setQ(null);
      } finally {
        setQuoting(false);
      }
    }, 350);
    return () => timer.current && clearTimeout(timer.current);
  }, [amt, inSym, outSym, slippage]);

  const manualMinValue = useAmount(tout, manualMin);
  const minValue = q ? q.minOut : manualMinValue;
  const rate = q && value > 0n ? (q.amountOut * 10n ** BigInt(tin.decimals)) / value : 0n;
  const [flips, setFlips] = useState(0); // drives the flip-button rotation (visual only)
  const flip = () => { setInSym(outSym); setOutSym(inSym); setFlips((f) => f + 1); };

  // route path chips (display-only) — every desk pair routes through the WETH/ETH hub
  const isHubTok = (t: TokenInfo) => t.symbol === "ETH" || t.symbol === "WETH";
  const deskDex = (t: TokenInfo): string | undefined => (isHubTok(t) ? undefined : t.stock ? "v4" : DESK_DEX[t.symbol]);
  const routeStops = useMemo(() => {
    const stops: { sym: string; logo?: string; tag?: string }[] = [{ sym: tin.symbol, logo: tin.logo, tag: deskDex(tin) }];
    if (!isHubTok(tin) && !isHubTok(tout)) stops.push({ sym: "ETH", logo: "/tokens/eth.png" });
    stops.push({ sym: tout.symbol, logo: tout.logo, tag: deskDex(tout) });
    return stops;
  }, [tin, tout]);

  // USD values (priced via USDG), same as the public aggregator
  const usdIn = useUsdValue(net, tin, amt);
  const usdOut = useUsdValue(net, tout, q ? formatUnits(q.amountOut, tout.decimals) : "");

  return (
    <>
      <h2>Shielded swap</h2>
      <p className="hint">Route through public Uniswap liquidity; proceeds re-shield into a fresh note you own.</p>

      <AssetPanel
        label="You pay"
        amount={amt}
        onAmount={setAmt}
        balance={balances[inSym] ?? 0n}
        decimals={tin.decimals}
        onMax={setAmt}
        usd={usdIn}
        pill={<DeskPill net={net} sym={inSym} onSym={setInSym} balances={balances} />}
      />

      <div className="swap-dir-wrap">
        <button type="button" className="swap-dir" onClick={flip} aria-label="Switch direction" style={{ transform: `rotate(${flips * 180}deg)` }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" /></svg>
        </button>
      </div>

      <AssetPanel
        label="You receive · re-shielded"
        amount={q ? trimAmt(formatUnits(q.amountOut, tout.decimals), 8) : ""}
        readOnly
        quoting={quoting}
        balance={balances[outSym] ?? 0n}
        decimals={tout.decimals}
        usd={usdOut}
        pill={<DeskPill net={net} sym={outSym} onSym={setOutSym} balances={balances} />}
      />

      {net.quoter ? (
        <div className="swap-meta">
          <div className="sm-row">
            <span>Rate</span>
            <span>{rate > 0n ? `1 ${tin.symbol} ≈ ${trimAmt(formatUnits(rate, tout.decimals), 6)} ${tout.symbol}` : quoting ? "fetching…" : "—"}</span>
          </div>
          <div className="sm-row">
            <span>Max slippage</span>
            <span className="slip-input"><input inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} />%</span>
          </div>
          {q && (
            <div className="sm-row dim">
              <span>Min received</span>
              <span>{trimAmt(formatUnits(q.minOut, tout.decimals), 8)} {tout.symbol}</span>
            </div>
          )}
          <div className="sm-row route-row">
            <span>Route</span>
            {inSym === outSym ? <span>—</span> : <RouteChips stops={routeStops} />}
          </div>
        </div>
      ) : (
        <div className="field">
          <label>Min received ({tout.symbol}) — slippage floor</label>
          <input inputMode="decimal" placeholder="0.0" value={manualMin} onChange={(e) => setManualMin(e.target.value)} />
        </div>
      )}

      <button
        className="btn block"
        style={{ marginTop: 14 }}
        disabled={busy || value <= 0n || inSym === outSym || minValue <= 0n}
        onClick={() => onSubmit(tin, value, tout, minValue)}
      >
        {inSym === outSym ? "Select different tokens" : "Swap privately"}
      </button>
    </>
  );
}

function WithdrawForm({ net, busy, balances, onSubmit }: { net: NetworkConfig; busy: boolean; balances: Record<string, bigint>; onSubmit: (t: TokenInfo, amt: bigint, recipient: Address) => void }) {
  const [sym, setSym] = useState(net.tokens[0].symbol);
  const [amt, setAmt] = useState("");
  const [to, setTo] = useState("");
  const token = net.tokens.find((t) => t.symbol === sym)!;
  const value = useAmount(token, amt);
  const usd = useUsdValue(net, token, amt);
  let recipient: Address | null = null;
  try {
    recipient = to ? getAddress(to) : null;
  } catch {
    recipient = null;
  }
  return (
    <>
      <h2>Withdraw</h2>
      <p className="hint">Unshield a note to any clear address. Sent via the relayer so it is unlinkable to your deposit.</p>
      <AssetPanel
        label="You withdraw"
        amount={amt}
        onAmount={setAmt}
        balance={balances[sym] ?? 0n}
        decimals={token.decimals}
        onMax={setAmt}
        usd={usd}
        pill={<DeskPill net={net} sym={sym} onSym={setSym} balances={balances} />}
      />
      <div className="field">
        <label>Recipient address</label>
        <input placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <button
        className="btn block"
        style={{ marginTop: 4 }}
        disabled={busy || value <= 0n || !recipient}
        onClick={() => recipient && onSubmit(token, value, recipient)}
      >
        Withdraw {sym}
      </button>
    </>
  );
}
