import { useEffect, useState } from "react";
import type { Connection } from "./wallet";
import type { NetworkConfig } from "./config";
import { fetchPoints, fetchLeaderboard, type PointsInfo, type LeaderRow } from "./points";

const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

export function PointsPage({ net, conn, onConnect, busy }: { net: NetworkConfig; conn: Connection | null; onConnect: () => void; busy: boolean }) {
  const [lb, setLb] = useState<LeaderRow[]>([]);
  const [p, setP] = useState<PointsInfo | null>(null);
  useEffect(() => { fetchLeaderboard(net, 25).then(setLb).catch(() => {}); }, [net.key]);
  useEffect(() => { if (conn) fetchPoints(net, conn.address).then(setP).catch(() => {}); else setP(null); }, [conn?.address, net.key]);

  return (
    <main className="page wrap">
      <section className="page-head">
        <span className="eyebrow">Sherwood Points</span>
        <h1>Earn as you shield.</h1>
        <p className="lede">Points reward you for shielding — fully on-chain and verifiable. Your private transfers and swaps are never tracked; that stays private.</p>
      </section>

      {conn ? (
        <div className="card points" style={{ marginBottom: 18 }}>
          <div className="points-head">
            <div><h2>Your points</h2><p className="hint">{short(conn.address)}</p></div>
            <div className="pts-total">
              <span className="pts-num">{(p?.points ?? 0).toLocaleString()}</span>
              <span className="pts-lab">points{p?.rank ? ` · rank #${p.rank}` : ""}</span>
            </div>
          </div>
          <div className="pts-grid">
            <div className="pts-stat"><b>{p?.shields ?? 0}</b><span>shields</span></div>
            <div className="pts-stat"><b>{p?.streak ?? 0} 🔥</b><span>day streak</span></div>
            <div className="pts-stat"><b>{p?.referrals ?? 0}</b><span>referrals</span></div>
            <div className="pts-stat"><b>{(p?.breakdown?.daily ?? 0).toLocaleString()}</b><span>daily pts</span></div>
          </div>
          <a className="btn ghost sm" href="#/referral">Invite friends → +200 each</a>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 18, textAlign: "center" }}>
          <p className="hint" style={{ marginBottom: 14 }}>Connect your wallet to see your points, rank and referral link.</p>
          <button className="btn" onClick={onConnect} disabled={busy}>Connect wallet</button>
        </div>
      )}

      <div className="points-land">
        <div className="pl-earn">
          <h3>How to earn</h3>
          <ul className="earn-list">
            <li><b>+100</b><span>per shield</span></li>
            <li><b>+25</b><span>per active day</span></li>
            <li><b>+100</b><span>7-day streak bonus</span></li>
            <li><b>+200 / +50</b><span>referral · you / your friend</span></li>
          </ul>
        </div>
        <div className="glass pl-lb">
          <div className="row"><h3>Leaderboard</h3><span className="pill live">live</span></div>
          <ol className="pts-lb">
            {lb.map((r) => (
              <li key={r.address} className={conn && r.address.toLowerCase() === conn.address.toLowerCase() ? "me" : ""}>
                <span className="rk">#{r.rank}</span>
                <span className="mono-sm">{short(r.address)}</span>
                <span className="pp">{r.points.toLocaleString()}</span>
              </li>
            ))}
            {!lb.length && <li className="hint">No points yet — be the first to shield.</li>}
          </ol>
        </div>
      </div>
    </main>
  );
}
