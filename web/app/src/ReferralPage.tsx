import { useEffect, useState } from "react";
import type { Connection } from "./wallet";
import type { NetworkConfig } from "./config";
import { fetchPoints, registerReferral, pendingReferral, clearReferral, type PointsInfo } from "./points";

const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

export function ReferralPage({ net, conn, onConnect, busy }: { net: NetworkConfig; conn: Connection | null; onConnect: () => void; busy: boolean }) {
  const [p, setP] = useState<PointsInfo | null>(null);
  const [refBy, setRefBy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const link = conn ? `${location.origin}/?ref=${conn.address}` : "";

  useEffect(() => {
    if (conn) { fetchPoints(net, conn.address).then(setP).catch(() => {}); setRefBy(pendingReferral(conn.address)); }
    else { setP(null); setRefBy(null); }
  }, [conn?.address, net.key]);

  const copy = async () => { try { await navigator.clipboard.writeText(link); setMsg("Referral link copied."); } catch { setMsg(link); } };
  const accept = async () => {
    if (!conn || !refBy) return;
    setMsg("Sign in your wallet to link the invite…");
    try {
      const r = await registerReferral(conn, net, refBy);
      if (r.ok) { setMsg("Invite linked — you'll earn +50 on your first shield."); clearReferral(); setRefBy(null); }
      else setMsg(`Couldn't link: ${r.error}`);
    } catch (e: any) { setMsg(`Couldn't link: ${e?.shortMessage ?? e?.message ?? e}`); }
  };

  return (
    <main className="page wrap">
      <section className="page-head">
        <span className="eyebrow">Refer &amp; earn</span>
        <h1>Bring a friend,<br />earn together.</h1>
        <p className="lede">Share your link. When a friend makes their first shield, you earn <b>+200</b> and they earn <b>+50</b> — credited on-chain. No limit.</p>
      </section>

      {conn ? (
        <>
          {refBy && !p?.referredBy && (
            <div className="status ok" style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <span>You were invited by {short(refBy)} — link it to earn +50 on your first shield.</span>
              <button className="btn sm" onClick={accept}>Accept invite</button>
            </div>
          )}
          <div className="card">
            <h2>Your referral link</h2>
            <div className="pts-referral"><span className="mono-sm">{link}</span><button className="btn ghost sm" onClick={copy}>Copy</button></div>
            {msg && <p className="hint">{msg}</p>}
            <div className="pts-grid" style={{ marginTop: 16 }}>
              <div className="pts-stat"><b>{p?.referrals ?? 0}</b><span>friends referred</span></div>
              <div className="pts-stat"><b>{((p?.referrals ?? 0) * 200).toLocaleString()}</b><span>referral pts</span></div>
              <div className="pts-stat"><b>{p?.referredBy ? "yes" : "—"}</b><span>you were invited</span></div>
            </div>
          </div>
        </>
      ) : (
        <div className="card" style={{ textAlign: "center" }}>
          <p className="hint" style={{ marginBottom: 14 }}>Connect your wallet to get your unique referral link.</p>
          <button className="btn" onClick={onConnect} disabled={busy}>Connect wallet</button>
        </div>
      )}

      <section className="section" style={{ padding: "40px 0 0" }}>
        <div className="steps">
          <div className="step"><div className="n">1</div><h4>Share</h4><p>Send your unique referral link to a friend.</p></div>
          <div className="step"><div className="n">2</div><h4>They shield</h4><p>They connect, accept the invite, and make their first shield.</p></div>
          <div className="step"><div className="n">3</div><h4>You both earn</h4><p>+200 points for you, +50 for them — verifiable on-chain.</p></div>
        </div>
      </section>
    </main>
  );
}
