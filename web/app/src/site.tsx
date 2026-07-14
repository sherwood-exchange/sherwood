import type { ReactNode } from "react";
import { Mark } from "./Mark";
import { NETWORKS, type NetworkConfig } from "./config";

export const X_URL = "https://x.com/sherwoodspot";

export function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label="X">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** Ambient animated background + optional hero video loop (public/hero.mp4). */
export function Background({ still }: { still?: boolean } = {}) {
  return (
    <div className={"bg" + (still ? " still" : "")} aria-hidden>
      {!still && (
        <video
          autoPlay
          loop
          muted
          playsInline
          onLoadedMetadata={(e) => (e.currentTarget.playbackRate = 0.7)}
          onError={(e) => (e.currentTarget.style.display = "none")}
        >
          <source src="/hero.mp4" type="video/mp4" />
        </video>
      )}
      {!still && <div className="glow g1" />}
      {!still && <div className="glow g2" />}
      {!still && <div className="glow g3" />}
      <div className="grid" />
      <div className="vignette" />
    </div>
  );
}

export function Nav({
  net,
  onNet,
  right,
  inApp = false,
}: {
  net: NetworkConfig;
  onNet: (n: NetworkConfig) => void;
  right: ReactNode;
  inApp?: boolean;
}) {
  return (
    <nav className="nav">
      <a className="brand" href={inApp ? "#/" : "#top"}>
        <span className="logo"><Mark size={30} /></span>
        <span className="word">SHERWOOD</span>
      </a>
      <div className="links">
        {inApp ? (
          <>
            {/* In-app: only routes that exist here (landing-section anchors don't). */}
            <a className="link" href="#/">Desk</a>
            <a className="link" href="#/swap">Swap</a>
            <a className="link" href="#/bridge">Bridge</a>
            <a className="link" href="#/stake">Stake</a>
            <a className="link" href="#/govern">Govern</a>
            <a className="link" href="#/portfolio">Portfolio</a>
            <a className="link" href="#/points">Points</a>
          </>
        ) : (
          <>
            <a className="link" href="#protocol">Protocol</a>
            <a className="link" href="#how">How it works</a>
            <a className="link" href="#/swap">Swap</a>
            <a className="link" href="#/bridge">Bridge</a>
            <a className="link" href="#swood">$SWOOD</a>
            <a className="link" href="#roadmap">Roadmap</a>
            <a className="link" href="#/portfolio">Portfolio</a>
            <a className="link" href="#/points">Points</a>
          </>
        )}
      </div>
      <div className="right">
        {Object.keys(NETWORKS).length > 1 ? (
          <select
            value={net.key}
            onChange={(e) => onNet(NETWORKS[e.target.value])}
            style={{ width: "auto", padding: "8px 10px", fontSize: 12 }}
            aria-label="Network"
          >
            {Object.values(NETWORKS).map((n) => (
              <option key={n.key} value={n.key}>{n.label}</option>
            ))}
          </select>
        ) : (
          <span className="net-chip">{net.label}</span>
        )}
        <a className="icon-link" href={X_URL} target="_blank" rel="noreferrer" aria-label="Sherwood on X"><XIcon size={17} /></a>
        {right}
      </div>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap inner">
        <div className="brand">
          <span className="logo"><Mark size={22} /></span>
          <span className="word">SHERWOOD</span>
          <span className="voice" style={{ marginLeft: 10 }}>Leave no trace.</span>
        </div>
        <div className="links">
          <a href="#protocol">Protocol</a>
          <a href="#how">How it works</a>
          <a href="#compliance">Compliance</a>
          <a href="#/points">Points</a>
          <a href="#/referral">Referral</a>
          <a href={X_URL} target="_blank" rel="noreferrer" aria-label="X"><XIcon size={15} /></a>
        </div>
      </div>
    </footer>
  );
}

/* feature icons */
export const IconShield = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5z" /></svg>
);
export const IconSwap = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h13l-3-3m6 13H7l3 3" /></svg>
);
export const IconSeal = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="10" r="6" /><path d="m9 15-1.5 6L12 19l4.5 2L15 15" /></svg>
);
export const IconKey = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="4" /><path d="m11 11 9 9m-3 0 3-3m-6 0 2-2" /></svg>
);
export const IconGhost = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 21V10a7 7 0 0 1 14 0v11l-3-2-2 2-2-2-2 2-3-2z" /><path d="M9 10h.01M15 10h.01" /></svg>
);
export const IconBolt = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>
);
