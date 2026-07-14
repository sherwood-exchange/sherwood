// $SWOOD staking / revenue share — stake $SWOOD, earn a share of protocol swap fees (paid in
// USDG). Public (non-shielded), wallet-driven. Mirrors SwoodStaking.sol.
import { useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, maxUint256, type Address } from "viem";
import { chainById, ERC20_ABI } from "@sherwood/client";
import type { NetworkConfig } from "./config";
import { toast, dismiss } from "./Toast";

type St = { kind: "ok" | "err" | "busy"; msg: string; hash?: string } | null;
const SWOOD = "0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60" as Address;
const trim = (s: string, n = 4) => { const [i, d] = s.split("."); return d ? `${i}.${d.slice(0, n)}` : i; };
/** Big-number formatter: thousands separators under 10k, compact notation (4.04M) above. */
const fmtCompact = (v: bigint, dec: number, frac = 2) => {
  const n = Number(formatUnits(v, dec));
  return n >= 10000
    ? n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })
    : n.toLocaleString("en-US", { maximumFractionDigits: frac });
};
const STAKE_ABI = [
  { type: "function", name: "stake", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "getReward", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "earned", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "stakedOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalStaked", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export function Stake({ net, walletProvider, address, isConnected, onConnect }: {
  net: NetworkConfig; walletProvider: any; address?: string; isConnected: boolean; onConnect: () => void;
}) {
  const [amt, setAmt] = useState("");
  const [bal, setBal] = useState(0n);
  const [staked, setStaked] = useState(0n);
  const [earned, setEarned] = useState(0n);
  const [total, setTotal] = useState(0n);
  const [working, setWorking] = useState(false);
  const [tick, setTick] = useState(0);
  const pc = useMemo(() => createPublicClient({ chain: chainById(net.chainId), transport: http(net.rpcUrl) }), [net]);
  const staking = net.swoodStaking;
  const setStatus = (s: St) => { if (s) toast({ id: "stake", kind: s.kind === "err" ? "error" : s.kind, msg: s.msg, hash: s.hash, explorer: net.explorer }); else dismiss("stake"); };

  useEffect(() => {
    if (!staking) return;
    let live = true;
    (async () => {
      try {
        const t = (await pc.readContract({ address: staking, abi: STAKE_ABI, functionName: "totalStaked" })) as bigint;
        if (live) setTotal(t);
        if (address) {
          const [b, s, e] = await Promise.all([
            pc.readContract({ address: SWOOD, abi: ERC20_ABI, functionName: "balanceOf", args: [address as Address] }) as Promise<bigint>,
            pc.readContract({ address: staking, abi: STAKE_ABI, functionName: "stakedOf", args: [address as Address] }) as Promise<bigint>,
            pc.readContract({ address: staking, abi: STAKE_ABI, functionName: "earned", args: [address as Address] }) as Promise<bigint>,
          ]);
          if (live) { setBal(b); setStaked(s); setEarned(e); }
        }
      } catch { /* read fail */ }
    })();
    return () => { live = false; };
  }, [address, staking, tick]);

  // refresh rewards every 12s (they accrue continuously)
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 12000); return () => clearInterval(id); }, []);

  const amount = useMemo(() => { try { return parseUnits(amt || "0", 18); } catch { return 0n; } }, [amt]);
  const sharePct = total > 0n ? (Number(staked) / Number(total)) * 100 : 0;
  const wc = () => createWalletClient({ account: address as Address, chain: chainById(net.chainId), transport: custom(walletProvider) });

  async function run(fn: () => Promise<`0x${string}`>, label: string) {
    if (!walletProvider || !address || !staking) return;
    try {
      setWorking(true);
      try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1237" }] }); } catch { /* */ }
      setStatus({ kind: "busy", msg: `${label}…` });
      const h = await fn();
      await pc.waitForTransactionReceipt({ hash: h });
      setStatus({ kind: "ok", msg: `${label} — done.`, hash: h });
      setTick((t) => t + 1);
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.shortMessage ?? e?.message ?? String(e) });
    } finally { setWorking(false); }
  }

  async function doStake() {
    if (amount <= 0n || !staking) return;
    const allow = (await pc.readContract({ address: SWOOD, abi: ERC20_ABI, functionName: "allowance", args: [address as Address, staking] })) as bigint;
    if (allow < amount) { await run(() => wc().writeContract({ address: SWOOD, abi: ERC20_ABI, functionName: "approve", args: [staking, maxUint256] }), "Approving $SWOOD"); }
    await run(() => wc().writeContract({ address: staking, abi: STAKE_ABI, functionName: "stake", args: [amount] }), `Staking ${amt} $SWOOD`);
    setAmt("");
  }

  return (
    <div className="app">
      <div className="app-head">
        <div>
          <h2 style={{ fontFamily: "var(--display)", fontSize: 26, margin: 0 }}>Stake $SWOOD</h2>
          <p className="muted mono-sm" style={{ margin: "4px 0 0" }}>Earn a share of protocol swap-fee revenue, paid in USDG.</p>
        </div>
        <span className="muted mono-sm">{fmtCompact(total, 18)} staked</span>
      </div>

      <div className="desk-one">
        <section className="card">
          <div className="public-note">Swap fees on the public aggregator flow to the treasury and are streamed to stakers here. Stake $SWOOD → claim USDG. Public, non-shielded.</div>

          <div className="stat-tiles">
            <div className="stat-tile"><b>{fmtCompact(total, 18)}</b><span>Total $SWOOD staked</span></div>
            <div className="stat-tile"><b>{isConnected ? fmtCompact(staked, 18) : "—"}</b><span>Your staked</span></div>
            <div className="stat-tile"><b className="lime">{isConnected ? fmtCompact(earned, 6, 4) : "—"}</b><span>Claimable USDG</span></div>
            <div className="stat-tile"><b>{sharePct >= 0.01 || sharePct === 0 ? sharePct.toFixed(2) : sharePct.toFixed(4)}%</b><span>Your share</span></div>
          </div>
          {isConnected && staked > 0n && (
            <div className="share-bar" title={`You hold ${sharePct.toFixed(4)}% of the pool`}>
              <div className="share-fill" style={{ width: `${Math.min(100, Math.max(sharePct, 1.5))}%` }} />
            </div>
          )}

          <div className="asset-panel">
            <div className="ap-top">
              <span className="ap-label">Stake</span>
              {isConnected && <span className="ap-bal">Balance: {trim(formatUnits(bal, 18))} $SWOOD{bal > 0n && <button type="button" className="max-chip" onClick={() => setAmt(formatUnits(bal, 18))}>MAX</button>}</span>}
            </div>
            <div className="ap-main">
              <input className="ap-amount" inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} />
              <span className="token-pill" style={{ cursor: "default" }}><img className="tok-img" src="/tokens/swood.png" width={26} height={26} alt="SWOOD" /><span style={{ fontWeight: 600, fontSize: 15 }}>SWOOD</span></span>
            </div>
          </div>

          {!isConnected ? (
            <button className="btn block" style={{ marginTop: 14 }} onClick={onConnect}>Connect wallet</button>
          ) : (
            <button className="btn block" style={{ marginTop: 14 }} disabled={working || amount <= 0n || amount > bal} onClick={doStake}>
              {amount > bal ? "Insufficient $SWOOD" : working ? "Working…" : "Stake"}
            </button>
          )}

          {isConnected && (
            <div className="swap-meta" style={{ marginTop: 16 }}>
              <div className="sm-row"><span>Your stake</span><span>{trim(formatUnits(staked, 18))} $SWOOD{staked > 0n && <button className="max-chip" style={{ marginLeft: 8 }} disabled={working} onClick={() => run(() => wc().writeContract({ address: staking!, abi: STAKE_ABI, functionName: "withdraw", args: [staked] }), "Unstaking")}>Unstake all</button>}</span></div>
              <div className="sm-row"><span>Claimable</span><span><b style={{ color: "var(--lime)" }}>{trim(formatUnits(earned, 6), 4)} USDG</b>{earned > 0n && <button className="max-chip" style={{ marginLeft: 8 }} disabled={working} onClick={() => run(() => wc().writeContract({ address: staking!, abi: STAKE_ABI, functionName: "getReward", args: [] }), "Claiming")}>Claim</button>}</span></div>
              <div className="sm-row dim"><span>Your share</span><span>{total > 0n ? ((Number(staked) / Number(total)) * 100).toFixed(2) : "0.00"}%</span></div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
