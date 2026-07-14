// Robin — Sherwood's in-app investing planner agent. The user states a goal in plain language;
// Robin (a backend /plan endpoint) returns a diversified basket of Sherwood's tokenized stocks,
// which the user invests in with one tap. Basket execution reuses the public aggregator machinery
// from PublicSwap.tsx (AGG_ABI / spokeArg) + aggregator.ts (resolveSpoke / quotePublic): each
// holding buys ~$X of the token with ETH through the ETH hub. Non-shielded, wallet-driven.
import { useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseUnits, getAddress, type Address } from "viem";
import type { NetworkConfig } from "./config";
import { AGG_ABI, spokeArg } from "./PublicSwap";
import { resolveSpoke, quotePublic, isHub, NATIVE, type AggToken } from "./aggregator";
import { Mark } from "./Mark";
import { TokenAvatar } from "./TokenUI";
import { toast, dismiss } from "./Toast";

// ERC-8004 Identity registry on Robinhood Chain — Robin's on-chain agent identity.
const ERC8004_IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
// Basket buys hit thinner stock pools than a single swap, so keep a generous slippage floor
// (covers the $SWOOD-tiered protocol fee + price impact across the ETH hub).
const SLIP_BPS = 500n; // 5%

const PLAN_BASE = ((import.meta as any).env?.VITE_PLAN_URL as string | undefined) || "https://sherwood.spot/agent";

// Minimal viem Chain from the network config (avoids a cross-package import); `any` sidesteps
// the known deep viem client type mismatch — same escape hatch the desk uses elsewhere.
const chainOf = (net: NetworkConfig): any => ({
  id: net.chainId, name: net.label,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [net.rpcUrl] } },
});

type RiskTier = "cautious" | "balanced" | "bold";
interface Holding { symbol: string; address: string; category: string; allocPct: number; usd: number; rationale: string; }
interface Plan {
  goal: string; budgetUsd: number; riskTier: RiskTier;
  holdings: Holding[];
  risk: { label: "Cautious" | "Balanced" | "Bold"; note: string };
  disclaimer: string;
}

const TIERS: { id: RiskTier; label: string }[] = [
  { id: "cautious", label: "Cautious" }, { id: "balanced", label: "Balanced" }, { id: "bold", label: "Bold" },
];
// Risk label → how many of the 5 "bumpiness" segments light up.
const RISK_LEVEL: Record<Plan["risk"]["label"], number> = { Cautious: 2, Balanced: 3, Bold: 5 };

const fmtUsd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const readableErr = (e: any): string => {
  const m: string = e?.shortMessage ?? e?.message ?? String(e);
  if (/user (rejected|denied)|rejected the request/i.test(m)) return "Transaction rejected in your wallet.";
  if (/insufficient funds/i.test(m)) return "Insufficient ETH to cover this buy + gas.";
  if (/TooLittleReceived|slippage|minOut/i.test(m)) return "Price moved beyond the slippage floor — try again.";
  return m.length > 200 ? m.slice(0, 200) + "…" : m;
};

export function Plan({ net, walletProvider, address, isConnected, onConnect }: {
  net: NetworkConfig; walletProvider: any; address?: string; isConnected: boolean; onConnect: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("100");
  const [tier, setTier] = useState<RiskTier>("balanced");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [building, setBuilding] = useState(false);
  const [investing, setInvesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pc = useMemo(() => createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) }), [net]);
  const rc = pc as any; // aggregator helpers want viem's PublicClient; cast around the type mismatch
  // config overlay: address → { logo, name, decimals } so basket rows show curated art + names.
  const cfg = useMemo(() => {
    const m = new Map<string, { logo?: string; name?: string; decimals: number }>();
    for (const t of net.tokens) m.set(t.address.toLowerCase(), { logo: t.logo, name: t.name, decimals: t.decimals });
    return m;
  }, [net]);
  const metaOf = (addr: string) => cfg.get(addr.toLowerCase());
  const decOf = (addr: string) => metaOf(addr)?.decimals ?? 18;

  const budgetUsd = Math.max(0, parseFloat(budget) || 0);
  const explorer = net.explorer || "https://robinhoodchain.blockscout.com";

  async function buildPlan(useTier: RiskTier, opts?: { simple?: boolean }) {
    const g = goal.trim();
    if (!g) { setErr("Tell Robin what you're aiming for first."); return; }
    if (budgetUsd <= 0) { setErr("Add a budget so Robin can size the basket."); return; }
    setBuilding(true);
    setErr(null);
    setTier(useTier);
    try {
      const res = await fetch(`${PLAN_BASE}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: g, budgetUsd, riskTier: useTier, ...(opts?.simple ? { simple: true } : {}) }),
      });
      if (!res.ok) throw new Error(`Robin returned ${res.status}`);
      const p = (await res.json()) as Plan;
      if (!p || !Array.isArray(p.holdings)) throw new Error("Robin sent an unexpected plan.");
      setPlan(p);
    } catch (e: any) {
      setPlan(null);
      const msg = readableErr(e);
      setErr(`Robin couldn't reach the planner. ${msg}`);
      toast({ id: "plan", kind: "error", msg: "Couldn't build your plan — the planner is unreachable." });
    } finally {
      setBuilding(false);
    }
  }

  /** Execute the whole basket as real ETH→token swaps through the public aggregator, sequentially.
   *  Per holding: price its $ target into ETH via USDG (≈ $1), quote the token out, apply a
   *  slippage floor, then call AggRouter.swap(ETH → token) with value = that ETH. One toast per
   *  fill (with tx hash), a final summary toast at the end. */
  async function investBasket() {
    if (!plan || !walletProvider || !address || !net.aggRouter) return;
    const router = net.aggRouter;
    const usdgCfg = net.tokens.find((t) => t.symbol === "USDG");
    if (!usdgCfg) { toast({ id: "plan", kind: "error", msg: "No USD reference token to price the basket." }); return; }
    setInvesting(true);
    try {
      const wc: any = createWalletClient({ account: address as Address, chain: chainOf(net), transport: custom(walletProvider) });
      try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + net.chainId.toString(16) }] }); } catch { /* manual */ }

      // Hub (ETH) + USDG tokens, resolved once. ETH is a hub token → no spoke needed.
      const ethHub: AggToken = { address: NATIVE as Address, symbol: "ETH", name: "Ether", decimals: 18, spoke: null };
      const usdgTok: AggToken = { address: usdgCfg.address, symbol: "USDG", name: "Global Dollar", decimals: usdgCfg.decimals, spoke: await resolveSpoke(rc, usdgCfg.address, usdgCfg.decimals) };

      let filled = 0, skipped = 0;
      const total = plan.holdings.length;
      for (let i = 0; i < total; i++) {
        const hold = plan.holdings[i];
        const label = `${hold.symbol} (${fmtUsd(hold.usd)})`;
        if (isHub(hold.address)) { skipped++; continue; } // can't swap ETH→ETH
        const dec = decOf(hold.address);
        const spoke = await resolveSpoke(rc, hold.address, dec);
        if (spoke === null) {
          toast({ kind: "error", msg: `No route for ${hold.symbol} — skipping.` });
          skipped++; continue;
        }
        const tokenOut: AggToken = { address: getAddress(hold.address), symbol: hold.symbol, name: metaOf(hold.address)?.name ?? hold.symbol, decimals: dec, spoke };

        // $usd → ETH (via USDG ≈ $1), then quote the expected token-out for that ETH.
        const ethIn = await quotePublic(rc, usdgTok, ethHub, parseUnits(hold.usd.toFixed(6), usdgTok.decimals));
        if (!ethIn || ethIn <= 0n) { toast({ kind: "error", msg: `Couldn't price ${hold.symbol} — skipping.` }); skipped++; continue; }
        const expected = await quotePublic(rc, ethHub, tokenOut, ethIn);
        const minOut = expected != null && expected > 0n ? (expected * (10000n - SLIP_BPS)) / 10000n : 0n;

        toast({ id: "plan", kind: "busy", msg: `Buying ${label} — ${i + 1}/${total}…` });
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
        const hash = await wc.writeContract({
          address: router, abi: AGG_ABI, functionName: "swap",
          args: [NATIVE as Address, spokeArg(ethHub), tokenOut.address as Address, spokeArg(tokenOut), ethIn, minOut, deadline, address as Address],
          value: ethIn,
        });
        await pc.waitForTransactionReceipt({ hash });
        toast({ kind: "ok", msg: `Bought ${label}.`, hash, explorer });
        filled++;
      }
      dismiss("plan");
      if (filled > 0) toast({ kind: "ok", msg: `Invested in ${filled} holding${filled === 1 ? "" : "s"}${skipped ? ` · ${skipped} skipped` : ""}. Welcome to your basket.` });
      else toast({ id: "plan", kind: "error", msg: "Nothing filled — no tradable routes in this basket." });
    } catch (e: any) {
      toast({ id: "plan", kind: "error", msg: readableErr(e) });
    } finally {
      setInvesting(false);
    }
  }

  const totalUsd = plan ? plan.holdings.reduce((s, h) => s + h.usd, 0) : 0;
  const riskLevel = plan ? RISK_LEVEL[plan.risk.label] ?? 3 : 0;

  return (
    <div className="app app-narrow">
      {/* Verified-agent header */}
      <div className="agent-head">
        <div className="agent-avatar" aria-hidden><Mark size={30} /></div>
        <div className="agent-id">
          <div className="agent-name-row">
            <h2 className="agent-name">Robin</h2>
            <a className="verified-badge" href={`${explorer}/address/${ERC8004_IDENTITY}`} target="_blank" rel="noreferrer"
               title="ERC-8004 Identity registry on Robinhood Chain">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5z" /><path d="m9 12 2 2 4-4" /></svg>
              Verified agent
            </a>
          </div>
          <p className="agent-tag muted mono-sm">Sherwood's investing planner · registered on ERC-8004 Identity ↗</p>
        </div>
      </div>

      {/* Goal form */}
      <section className="card plan-form">
        <label className="plan-label">What are you aiming for?</label>
        <textarea
          className="plan-goal"
          placeholder="Tell me a goal — e.g. 'grow $100 with AI exposure, play it safe'"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={2}
        />
        <div className="plan-row">
          <div className="plan-budget">
            <label className="plan-label">Budget</label>
            <div className="plan-budget-field">
              <span className="plan-dollar">$</span>
              <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="100" />
            </div>
          </div>
          <div className="plan-risk">
            <label className="plan-label">How bold?</label>
            <div className="risk-chips">
              {TIERS.map((t) => (
                <button key={t.id} type="button" className={`risk-chip ${tier === t.id ? "active" : ""}`} onClick={() => setTier(t.id)}>{t.label}</button>
              ))}
            </div>
          </div>
        </div>
        {err && <p className="plan-err mono-sm">{err}</p>}
        <button className="btn block" style={{ marginTop: 14 }} disabled={building || investing} onClick={() => buildPlan(tier)}>
          {building ? <><span className="spin dark" />Robin is building your plan… ● ● ●</> : plan ? "Rebuild plan" : "Build my plan"}
        </button>
      </section>

      {/* Plan result */}
      {plan && !building && (
        <section className="card plan-result">
          <div className="plan-result-head">
            <div>
              <h3 className="plan-result-title">Your basket</h3>
              <p className="muted mono-sm" style={{ margin: "2px 0 0" }}>{plan.holdings.length} holdings · {fmtUsd(totalUsd)} · {plan.risk.label}</p>
            </div>
          </div>

          {/* Risk meter */}
          <div className="risk-meter">
            <div className="risk-meter-top">
              <span className="risk-meter-label">How bumpy this could feel</span>
              <span className="risk-meter-tier">{plan.risk.label}</span>
            </div>
            <div className="risk-bar" role="img" aria-label={`Risk: ${plan.risk.label}`}>
              {[1, 2, 3, 4, 5].map((n) => <span key={n} className={`risk-seg ${n <= riskLevel ? "on" : ""}`} />)}
            </div>
            <p className="risk-note muted mono-sm">{plan.risk.note}</p>
          </div>

          {/* Basket cards */}
          <ul className="basket">
            {plan.holdings.map((h, i) => {
              const meta = metaOf(h.address);
              return (
                <li key={h.address + i} className="basket-card">
                  <TokenAvatar sym={h.symbol} logo={meta?.logo} size={40} className="tok-badge" />
                  <div className="basket-main">
                    <div className="basket-top">
                      <span className="basket-sym">{h.symbol}</span>
                      <span className="basket-cat">{h.category}</span>
                    </div>
                    {meta?.name && <span className="basket-name muted">{meta.name}</span>}
                    <p className="basket-rationale">{h.rationale}</p>
                  </div>
                  <div className="basket-alloc">
                    <span className="basket-usd">{fmtUsd(h.usd)}</span>
                    <span className="basket-pct muted mono-sm">{h.allocPct}%</span>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Risk-tune chips — re-request the plan at a different tier / simpler */}
          <div className="tune-chips">
            <span className="tune-label mono-sm muted">Tune it:</span>
            <button type="button" className="tune-chip" disabled={building || investing} onClick={() => buildPlan("cautious")}>Make it safer</button>
            <button type="button" className="tune-chip" disabled={building || investing} onClick={() => buildPlan("bold")}>Be bolder</button>
            <button type="button" className="tune-chip" disabled={building || investing} onClick={() => buildPlan(tier, { simple: true })}>Keep it simple</button>
          </div>

          <p className="plan-disclaimer mono-sm muted">{plan.disclaimer}</p>

          {/* Invest — executes the whole basket */}
          {!isConnected ? (
            <button className="btn block" onClick={onConnect}>Connect wallet to invest</button>
          ) : (
            <button className="btn block" disabled={investing || building || !net.aggRouter} onClick={investBasket}>
              {investing ? <><span className="spin dark" />Investing…</> : `Invest ${fmtUsd(totalUsd)}`}
            </button>
          )}
          <p className="plan-private mono-sm muted">
            Want to buy this basket privately? Route it through the <a href="#/">shielded desk ↗</a> instead — Robin's fills are public on-chain.
          </p>
        </section>
      )}
    </div>
  );
}
