// Pool — community liquidity for the SWOOD/WETH pair on Sherwood's own V2 AMM
// (SherwoodV2Factory 0xA51e4423…), Uniswap-style: anyone can add or remove liquidity via the
// router. While the pool is EMPTY the first LP sets the price, so the form pre-fills the ETH
// side from the live aggregator rate (the Virtuals SWOOD pair) and says so loudly.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseUnits, parseEther, formatUnits, formatEther, maxUint256, type Address } from "viem";
import { chainById, ERC20_ABI } from "@sherwood/client";
import type { NetworkConfig } from "./config";
import { quoteRoute } from "./routing";
import { TokenAvatar } from "./TokenUI";
import { toast } from "./Toast";

const ROUTER = "0xc0Be15411D142Ae16fC7f5096395a33142684805" as Address;
const PAIR = "0x080a682A061E103ed14Ff29B8860cC021e4F7EF9" as Address;
const SWOOD = "0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const SLIP_BPS = 100n; // 1%

const ROUTER_ABI = [
  { type: "function", name: "addLiquidityETH", stateMutability: "payable", inputs: [
    { name: "token", type: "address" }, { name: "amountTokenDesired", type: "uint256" },
    { name: "amountTokenMin", type: "uint256" }, { name: "amountETHMin", type: "uint256" },
    { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
  ], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "removeLiquidityETH", stateMutability: "nonpayable", inputs: [
    { name: "token", type: "address" }, { name: "liquidity", type: "uint256" },
    { name: "amountTokenMin", type: "uint256" }, { name: "amountETHMin", type: "uint256" },
    { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
  ], outputs: [{ type: "uint256" }, { type: "uint256" }] },
] as const;
const PAIR_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const chainOf = (net: NetworkConfig): any => ({
  id: net.chainId, name: net.label,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [net.rpcUrl] } },
});
const trim = (s: string, n = 6) => { const [i, d] = s.split("."); return d ? `${i}.${d.slice(0, n)}` : i; };
const readableErr = (e: any): string => {
  const m: string = e?.shortMessage ?? e?.message ?? String(e);
  if (/user (rejected|denied)|rejected the request/i.test(m)) return "Transaction rejected in your wallet.";
  if (/insufficient/i.test(m)) return "Insufficient balance.";
  if (/EXPIRED|INSUFFICIENT_[AB]_AMOUNT/i.test(m)) return "Price moved — retry.";
  return m.length > 180 ? m.slice(0, 180) + "…" : m;
};

export function PoolPage({ net, walletProvider, address, isConnected, onConnect }: {
  net: NetworkConfig; walletProvider: any; address?: string; isConnected: boolean; onConnect: () => void;
}) {
  const pc = useMemo(() => createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) }), [net]);
  const [tab, setTab] = useState<"add" | "remove">("add");
  const [rSwood, setRSwood] = useState(0n); // pair reserves, SWOOD side
  const [rWeth, setRWeth] = useState(0n);
  const [lpSupply, setLpSupply] = useState(0n);
  const [lpBal, setLpBal] = useState(0n);
  const [swoodBal, setSwoodBal] = useState(0n);
  const [ethBal, setEthBal] = useState(0n);
  const [swoodAmt, setSwoodAmt] = useState("");
  const [ethAmt, setEthAmt] = useState("");
  const [pct, setPct] = useState(50); // remove percent
  const [marketEthPerSwood, setMarket] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const tick = useRef(0);

  const empty = lpSupply === 0n;

  async function refresh() {
    try {
      const [r, ts, t0] = await Promise.all([
        pc.readContract({ address: PAIR, abi: PAIR_ABI, functionName: "getReserves" }) as Promise<readonly [bigint, bigint, number]>,
        pc.readContract({ address: PAIR, abi: PAIR_ABI, functionName: "totalSupply" }) as Promise<bigint>,
        pc.readContract({ address: PAIR, abi: PAIR_ABI, functionName: "token0" }) as Promise<Address>,
      ]);
      const wethIs0 = t0.toLowerCase() === WETH.toLowerCase();
      setRWeth(wethIs0 ? r[0] : r[1]); setRSwood(wethIs0 ? r[1] : r[0]); setLpSupply(ts);
      if (address) {
        const [lp, sw, et] = await Promise.all([
          pc.readContract({ address: PAIR, abi: ERC20_ABI, functionName: "balanceOf", args: [address as Address] }) as Promise<bigint>,
          pc.readContract({ address: SWOOD, abi: ERC20_ABI, functionName: "balanceOf", args: [address as Address] }) as Promise<bigint>,
          pc.getBalance({ address: address as Address }),
        ]);
        setLpBal(lp); setSwoodBal(sw); setEthBal(et);
      }
    } catch { /* rpc flake — keep prior state */ }
  }
  useEffect(() => { refresh(); const t = setInterval(() => { tick.current++; refresh(); }, 20_000); return () => clearInterval(t); }, [pc, address]);

  // live market rate for the empty-pool suggestion (aggregator: SWOOD → ETH through the hub)
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const out = await quoteRoute(pc as any, SWOOD, WETH, parseEther("1000"));
        if (live && out != null && out > 0n) setMarket(Number(formatEther(out)) / 1000);
      } catch { /* optional */ }
    })();
    return () => { live = false; };
  }, [pc]);

  // keep the ETH side in ratio: pool ratio when seeded, market rate when empty
  function onSwoodInput(v: string) {
    setSwoodAmt(v);
    const n = parseFloat(v);
    if (!(n > 0)) { if (!v) setEthAmt(""); return; }
    if (!empty && rSwood > 0n) {
      const eth = (parseEther(v || "0") * rWeth) / rSwood;
      setEthAmt(trim(formatEther(eth), 8));
    } else if (marketEthPerSwood != null) {
      setEthAmt(trim(String(n * marketEthPerSwood), 8));
    }
  }
  function onEthInput(v: string) {
    setEthAmt(v);
    if (!empty && rWeth > 0n && parseFloat(v) > 0) {
      const sw = (parseEther(v || "0") * rSwood) / rWeth;
      setSwoodAmt(trim(formatEther(sw), 6));
    }
  }

  async function addLiq() {
    if (!walletProvider || !address) { onConnect(); return; }
    const aSwood = parseUnits(swoodAmt || "0", 18), aEth = parseEther(ethAmt || "0");
    if (aSwood <= 0n || aEth <= 0n) return;
    setWorking(true);
    const id = toast({ kind: "busy", msg: "Adding liquidity…" });
    try {
      const wc = createWalletClient({ account: address as Address, chain: chainById(net.chainId), transport: custom(walletProvider) });
      try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + net.chainId.toString(16) }] }); } catch { /* manual */ }
      const allow = (await pc.readContract({ address: SWOOD, abi: ERC20_ABI, functionName: "allowance", args: [address as Address, ROUTER] })) as bigint;
      if (allow < aSwood) {
        toast({ id, kind: "busy", msg: "Approving SWOOD…" });
        const ah = await wc.writeContract({ address: SWOOD, abi: ERC20_ABI, functionName: "approve", args: [ROUTER, maxUint256] });
        await pc.waitForTransactionReceipt({ hash: ah });
      }
      toast({ id, kind: "busy", msg: "Adding liquidity…" });
      const h = await wc.writeContract({
        address: ROUTER, abi: ROUTER_ABI, functionName: "addLiquidityETH",
        args: [SWOOD, aSwood, (aSwood * (10000n - SLIP_BPS)) / 10000n, (aEth * (10000n - SLIP_BPS)) / 10000n, address as Address, BigInt(Math.floor(Date.now() / 1000) + 1200)],
        value: aEth,
      });
      await pc.waitForTransactionReceipt({ hash: h });
      toast({ id, kind: "ok", msg: `Added ${swoodAmt} SWOOD + ${ethAmt} ETH to the pool.`, hash: h, explorer: net.explorer });
      setSwoodAmt(""); setEthAmt("");
      await refresh();
    } catch (e: any) { toast({ id, kind: "error", msg: readableErr(e) }); }
    finally { setWorking(false); }
  }

  async function removeLiq() {
    if (!walletProvider || !address || lpBal <= 0n) return;
    const liquidity = (lpBal * BigInt(pct)) / 100n;
    if (liquidity <= 0n) return;
    setWorking(true);
    const id = toast({ kind: "busy", msg: "Removing liquidity…" });
    try {
      const wc = createWalletClient({ account: address as Address, chain: chainById(net.chainId), transport: custom(walletProvider) });
      try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + net.chainId.toString(16) }] }); } catch { /* manual */ }
      const allow = (await pc.readContract({ address: PAIR, abi: ERC20_ABI, functionName: "allowance", args: [address as Address, ROUTER] })) as bigint;
      if (allow < liquidity) {
        toast({ id, kind: "busy", msg: "Approving LP tokens…" });
        const ah = await wc.writeContract({ address: PAIR, abi: ERC20_ABI, functionName: "approve", args: [ROUTER, maxUint256] });
        await pc.waitForTransactionReceipt({ hash: ah });
      }
      // expected underlying at current reserves, floored 1%
      const expSwood = lpSupply > 0n ? (rSwood * liquidity) / lpSupply : 0n;
      const expWeth = lpSupply > 0n ? (rWeth * liquidity) / lpSupply : 0n;
      toast({ id, kind: "busy", msg: "Removing liquidity…" });
      const h = await wc.writeContract({
        address: ROUTER, abi: ROUTER_ABI, functionName: "removeLiquidityETH",
        args: [SWOOD, liquidity, (expSwood * (10000n - SLIP_BPS)) / 10000n, (expWeth * (10000n - SLIP_BPS)) / 10000n, address as Address, BigInt(Math.floor(Date.now() / 1000) + 1200)],
      });
      await pc.waitForTransactionReceipt({ hash: h });
      toast({ id, kind: "ok", msg: `Removed ${pct}% of your liquidity.`, hash: h, explorer: net.explorer });
      await refresh();
    } catch (e: any) { toast({ id, kind: "error", msg: readableErr(e) }); }
    finally { setWorking(false); }
  }

  const share = lpSupply > 0n ? Number((lpBal * 10000n) / lpSupply) / 100 : 0;
  const mySwood = lpSupply > 0n ? (rSwood * lpBal) / lpSupply : 0n;
  const myWeth = lpSupply > 0n ? (rWeth * lpBal) / lpSupply : 0n;
  const poolPrice = rSwood > 0n ? Number(formatEther(rWeth)) / Number(formatEther(rSwood)) : null;
  const addDisabled = working || !(parseFloat(swoodAmt) > 0) || !(parseFloat(ethAmt) > 0)
    || (isConnected && (parseUnits(swoodAmt || "0", 18) > swoodBal || parseEther(ethAmt || "0") > ethBal));

  return (
    <div className="app">
      <div className="app-head">
        <div>
          <h2 style={{ fontFamily: "var(--display)", fontSize: 26, margin: 0 }}>Pool</h2>
          <p className="muted mono-sm" style={{ margin: "4px 0 0" }}>Provide SWOOD/ETH liquidity on Sherwood's own AMM — earn the 0.30% swap fee, Uniswap-style.</p>
        </div>
      </div>

      <div className="desk-one">
        <section className="card">
          <div className="tabs">
            <button className={`tab ${tab === "add" ? "active" : ""}`} onClick={() => setTab("add")}>Add</button>
            <button className={`tab ${tab === "remove" ? "active" : ""}`} onClick={() => setTab("remove")}>Remove</button>
          </div>

          {/* pool stats */}
          <div className="pool-stats mono-sm">
            <span>Pool: {trim(formatEther(rSwood), 0)} SWOOD · {trim(formatEther(rWeth), 4)} ETH</span>
            <span>{poolPrice != null ? `1 SWOOD ≈ ${poolPrice.toFixed(8)} ETH` : marketEthPerSwood != null ? `market ≈ ${marketEthPerSwood.toFixed(8)} ETH/SWOOD` : ""}</span>
          </div>

          {empty && tab === "add" && (
            <div className="status ok" style={{ margin: "12px 0" }}>
              This pool is <b>empty — the first deposit sets the price</b>. The ETH field is pre-filled
              from the live market rate ({marketEthPerSwood != null ? `${marketEthPerSwood.toFixed(8)} ETH/SWOOD` : "loading…"});
              seeding far from it hands arbitrage your funds.
            </div>
          )}

          {tab === "add" ? (
            <>
              <div className="asset-panel">
                <div className="ap-top"><span className="ap-label">SWOOD</span>{isConnected && <span className="ap-bal">Balance: {trim(formatEther(swoodBal), 2)}{swoodBal > 0n && <button type="button" className="max-chip" onClick={() => onSwoodInput(formatEther(swoodBal))}>MAX</button>}</span>}</div>
                <div className="ap-main">
                  <input className="ap-amount" inputMode="decimal" placeholder="0.0" value={swoodAmt} onChange={(e) => onSwoodInput(e.target.value)} />
                  <span className="pool-tok"><TokenAvatar sym="SWOOD" logo="/tokens/swood.png" size={22} />SWOOD</span>
                </div>
              </div>
              <div className="asset-panel" style={{ marginTop: 10 }}>
                <div className="ap-top"><span className="ap-label">ETH {empty ? "(editable — you set the price)" : "(auto, pool ratio)"}</span>{isConnected && <span className="ap-bal">Balance: {trim(formatEther(ethBal), 5)}</span>}</div>
                <div className="ap-main">
                  <input className="ap-amount" inputMode="decimal" placeholder="0.0" value={ethAmt} onChange={(e) => onEthInput(e.target.value)} readOnly={!empty} />
                  <span className="pool-tok"><TokenAvatar sym="ETH" logo="/tokens/eth.png" size={22} />ETH</span>
                </div>
              </div>
              {!isConnected ? (
                <button className="btn block" style={{ marginTop: 14 }} onClick={onConnect}>Connect wallet</button>
              ) : (
                <button className="btn block" style={{ marginTop: 14 }} disabled={addDisabled} onClick={addLiq}>
                  {working ? "Working…" : empty ? "Seed the pool" : "Add liquidity"}
                </button>
              )}
            </>
          ) : (
            <>
              {lpBal <= 0n ? (
                <p className="muted mono-sm" style={{ margin: "14px 0" }}>No LP position yet — add liquidity first.</p>
              ) : (
                <>
                  <div className="pool-remove">
                    <div className="pool-pct mono-sm"><span>Remove</span><b>{pct}%</b></div>
                    <input type="range" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
                    <div className="pool-recv mono-sm muted">
                      ≈ {trim(formatEther((mySwood * BigInt(pct)) / 100n), 2)} SWOOD + {trim(formatEther((myWeth * BigInt(pct)) / 100n), 6)} ETH
                    </div>
                  </div>
                  <button className="btn block" style={{ marginTop: 14 }} disabled={working} onClick={removeLiq}>{working ? "Working…" : "Remove liquidity"}</button>
                </>
              )}
            </>
          )}

          {/* my position */}
          {isConnected && lpBal > 0n && (
            <div className="pool-pos mono-sm">
              <span>Your position</span>
              <span>{trim(formatEther(lpBal), 6)} LP · {share.toFixed(2)}% of pool · ≈ {trim(formatEther(mySwood), 2)} SWOOD + {trim(formatEther(myWeth), 6)} ETH</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
