// $SWOOD governance — signaling proposals + votes weighted by staked $SWOOD. Public, wallet-driven.
// Mirrors SwoodGovernor.sol. No on-chain execution; the team enacts what the community votes for.
import { useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, formatUnits, type Address } from "viem";
import { chainById } from "@sherwood/client";
import type { NetworkConfig } from "./config";
import { toast, dismiss } from "./Toast";

type St = { kind: "ok" | "err" | "busy"; msg: string; hash?: string } | null;
const trim = (s: string, n = 0) => { const [i] = s.split("."); return i; };
/** Big-number formatter: thousands separators under 10k, compact notation (4.04M) above. */
const fmtCompact = (v: bigint, dec = 18) => {
  const n = Number(formatUnits(v, dec));
  return n >= 10000
    ? n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })
    : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
const STAKING_ABI = [{ type: "function", name: "stakedOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const GOV_ABI = [
  { type: "function", name: "proposalCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "proposalThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "proposals", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
    { name: "proposer", type: "address" }, { name: "description", type: "string" }, { name: "start", type: "uint64" }, { name: "end", type: "uint64" }, { name: "forVotes", type: "uint256" }, { name: "againstVotes", type: "uint256" }] },
  { type: "function", name: "voteOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "propose", stateMutability: "nonpayable", inputs: [{ type: "string" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "vote", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "bool" }], outputs: [] },
] as const;

interface Prop { id: number; description: string; end: number; forVotes: bigint; againstVotes: bigint; myVote: number; }

export function Govern({ net, walletProvider, address, isConnected, onConnect }: {
  net: NetworkConfig; walletProvider: any; address?: string; isConnected: boolean; onConnect: () => void;
}) {
  const [props, setProps] = useState<Prop[]>([]);
  const [power, setPower] = useState(0n);
  const [threshold, setThreshold] = useState(0n);
  const [desc, setDesc] = useState("");
  const [working, setWorking] = useState(false);
  const [tick, setTick] = useState(0);
  const pc = useMemo(() => createPublicClient({ chain: chainById(net.chainId), transport: http(net.rpcUrl) }), [net]);
  const gov = net.swoodGovernor;
  const staking = net.swoodStaking;
  const setStatus = (s: St) => { if (s) toast({ id: "govern", kind: s.kind === "err" ? "error" : s.kind, msg: s.msg, hash: s.hash, explorer: net.explorer }); else dismiss("govern"); };
  const now = Math.floor(Date.now() / 1000);

  useEffect(() => {
    if (!gov) return;
    let live = true;
    (async () => {
      try {
        const [count, thr] = await Promise.all([
          pc.readContract({ address: gov, abi: GOV_ABI, functionName: "proposalCount" }) as Promise<bigint>,
          pc.readContract({ address: gov, abi: GOV_ABI, functionName: "proposalThreshold" }) as Promise<bigint>,
        ]);
        if (live) setThreshold(thr);
        const n = Number(count);
        const out: Prop[] = [];
        for (let i = n - 1; i >= 0 && i >= n - 30; i--) {
          const p = (await pc.readContract({ address: gov, abi: GOV_ABI, functionName: "proposals", args: [BigInt(i)] })) as any;
          const myVote = address ? Number(await pc.readContract({ address: gov, abi: GOV_ABI, functionName: "voteOf", args: [BigInt(i), address as Address] })) : 0;
          out.push({ id: i, description: p.description ?? p[1], end: Number(p.end ?? p[3]), forVotes: p.forVotes ?? p[4], againstVotes: p.againstVotes ?? p[5], myVote });
        }
        if (live) setProps(out);
        if (address && staking) setPower((await pc.readContract({ address: staking, abi: STAKING_ABI, functionName: "stakedOf", args: [address as Address] })) as bigint);
      } catch { /* read fail */ }
    })();
    return () => { live = false; };
  }, [address, gov, staking, tick]);

  const wc = () => createWalletClient({ account: address as Address, chain: chainById(net.chainId), transport: custom(walletProvider) });
  async function run(fn: () => Promise<`0x${string}`>, label: string) {
    if (!walletProvider || !address || !gov) return;
    try {
      setWorking(true);
      try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1237" }] }); } catch { /* */ }
      setStatus({ kind: "busy", msg: `${label}…` });
      const h = await fn();
      await pc.waitForTransactionReceipt({ hash: h });
      setStatus({ kind: "ok", msg: `${label} — done.`, hash: h });
      setTick((t) => t + 1);
    } catch (e: any) { setStatus({ kind: "err", msg: e?.shortMessage ?? e?.message ?? String(e) }); }
    finally { setWorking(false); }
  }

  const canPropose = power >= threshold && threshold > 0n;
  const activeCount = props.filter((p) => p.end > now).length;
  const fmtLeft = (end: number) => { const s = end - now; if (s <= 0) return "ended"; const h = Math.floor(s / 3600); return h >= 24 ? `${Math.floor(h / 24)}d left` : `${h}h left`; };

  return (
    <div className="app">
      <div className="app-head">
        <div>
          <h2 style={{ fontFamily: "var(--display)", fontSize: 26, margin: 0 }}>Governance</h2>
          <p className="muted mono-sm" style={{ margin: "4px 0 0" }}>$SWOOD-weighted signaling votes on listings + protocol parameters.</p>
        </div>
        <span className="muted mono-sm">{isConnected ? `${fmtCompact(power)} votes` : ""}</span>
      </div>

      <div className="desk-one" style={{ maxWidth: 640 }}>
        <section className="card">
          <div className="public-note">Voting power = your <b>staked $SWOOD</b>. Proposals are signaling — the team enacts what the community votes for. Stake to vote or propose.</div>

          <div className="stat-tiles">
            <div className="stat-tile"><b className="lime">{isConnected ? fmtCompact(power) : "—"}</b><span>Your vote weight</span></div>
            <div className="stat-tile"><b>{threshold > 0n ? fmtCompact(threshold) : "—"}</b><span>Proposal threshold</span></div>
            <div className="stat-tile"><b>{activeCount}</b><span>Active proposals</span></div>
          </div>

          {isConnected && (
            <div className="field">
              <label>New proposal {canPropose ? "" : `(need ${fmtCompact(threshold)} staked $SWOOD)`}</label>
              <textarea className="addr-input" placeholder="e.g. List $XYZ on the aggregator" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} />
              <button className="btn block" style={{ marginTop: 8 }} disabled={working || !canPropose || desc.trim().length === 0} onClick={() => { run(() => wc().writeContract({ address: gov!, abi: GOV_ABI, functionName: "propose", args: [desc.trim()] }), "Submitting proposal").then(() => setDesc("")); }}>
                {canPropose ? "Submit proposal" : "Stake more to propose"}
              </button>
            </div>
          )}

          <div className="prop-list">
            {props.length === 0 && <div className="tp-empty">No proposals yet.{isConnected && canPropose ? " Be the first." : ""}</div>}
            {props.map((p) => {
              const totalV = p.forVotes + p.againstVotes;
              const forPct = totalV > 0n ? Number((p.forVotes * 100n) / totalV) : 0;
              const active = p.end > now;
              return (
                <div key={p.id} className="prop">
                  <div className="prop-head"><span className="prop-id">#{p.id}</span><span className={`prop-state ${active ? "on" : ""}`}>{active ? fmtLeft(p.end) : "ended"}</span></div>
                  <div className="prop-desc">{p.description}</div>
                  <div className="prop-bar"><div className="prop-bar-for" style={{ width: `${forPct}%` }} /></div>
                  <div className="prop-tally">
                    <span className="tally-for">For {fmtCompact(p.forVotes)} · {forPct}%</span>
                    <span className="tally-against">{100 - forPct}% · Against {fmtCompact(p.againstVotes)}</span>
                  </div>
                  {isConnected && active && (p.myVote === 0 ? (
                    <div className="prop-vote">
                      <button className="btn sm" disabled={working || power === 0n} onClick={() => run(() => wc().writeContract({ address: gov!, abi: GOV_ABI, functionName: "vote", args: [BigInt(p.id), true] }), `Voting for #${p.id}`)}>Vote For</button>
                      <button className="btn ghost sm" disabled={working || power === 0n} onClick={() => run(() => wc().writeContract({ address: gov!, abi: GOV_ABI, functionName: "vote", args: [BigInt(p.id), false] }), `Voting against #${p.id}`)}>Against</button>
                      {power === 0n && <span className="muted mono-sm">stake $SWOOD to vote</span>}
                    </div>
                  ) : p.myVote !== 0 ? <div className="muted mono-sm" style={{ marginTop: 8 }}>You voted {p.myVote === 1 ? "For ✓" : "Against ✕"}</div> : null)}
                </div>
              );
            })}
          </div>

          {!isConnected && <button className="btn block" style={{ marginTop: 14 }} onClick={onConnect}>Connect wallet</button>}
        </section>
      </div>
    </div>
  );
}
