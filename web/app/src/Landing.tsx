import { IconShield, IconSwap, IconSeal, IconKey, IconGhost, IconBolt } from "./site";

export function Landing({ onConnect, busy }: { onConnect: () => void; busy: boolean }) {
  return (
    <main id="top">
      {/* ---------------- hero ---------------- */}
      <section className="hero wrap">
        <div className="hero-grid">
          <div>
            <span className="eyebrow">Private Exchange · Robinhood Chain</span>
            <h1>
              Leave<br />
              <span className="em">no trace.</span>
            </h1>
            <p className="lede">
              Shield your assets, swap through public liquidity, and arrive from any of 100 chains —
              with zero-knowledge privacy and provable compliance on Robinhood Chain.
            </p>
            <div className="cta">
              <button className="btn" onClick={onConnect} disabled={busy}>Launch app</button>
              <a className="btn ghost" href="#/woodie">Meet WOODIE 🌲</a>
            </div>
            <div className="trust">
              <div className="t"><b>Groth16</b>zero-knowledge</div>
              <div className="t"><b>100+ chains</b>private route in/out</div>
              <div className="t"><b>Uniswap v2/v3/v4</b>public liquidity</div>
              <div className="t"><b>ERC-8004</b>verified AI copilot</div>
            </div>
          </div>

          {/* swap preview */}
          <div className="glass swapcard">
            <div className="row">
              <h3>Shielded swap</h3>
              <span className="pill">private</span>
            </div>
            <div className="leg">
              <div className="lab">You pay</div>
              <div className="val">
                <div className="amt">100.00</div>
                <div className="tok"><span className="dot" style={{ background: "var(--lime)" }} />USDG</div>
              </div>
            </div>
            <div className="swap-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14m0 0-5-5m5 5 5-5" /></svg>
            </div>
            <div className="leg">
              <div className="lab">You receive · re-shielded</div>
              <div className="val">
                <div className="amt muted">••••</div>
                <div className="tok"><span className="dot" style={{ background: "var(--moon)" }} />AAPL</div>
              </div>
            </div>
            <button className="btn block" style={{ marginTop: 16 }} onClick={onConnect} disabled={busy}>
              Connect to swap privately
            </button>
            <p className="mono-sm muted" style={{ textAlign: "center", margin: "12px 0 0" }}>
              No observer can link your deposit to the output.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- protocol ---------------- */}
      <section id="protocol" className="section wrap">
        <h2>Everything about the holder,<br />stays hidden.</h2>
        <p className="sub">
          Value lives in amount-carrying UTXO notes committed to a Poseidon Merkle tree. A join-split
          circuit proves ownership and value conservation without ever revealing which note is spent.
        </p>
        <div className="features">
          <div className="feature">
            <div className="ico"><IconGhost /></div>
            <h3>Fully shielded</h3>
            <p>Identity, balance, note amount, note asset, and the sender↔receiver and deposit↔withdrawal links are all hidden. A nullifier reveals only <em>that</em> a note was spent — never which.</p>
          </div>
          <div className="feature">
            <div className="ico"><IconSwap /></div>
            <h3>Swap public liquidity, privately</h3>
            <p>Route through public Uniswap v2/v3/v4 liquidity on Robinhood Chain and re-shield the actual proceeds into a fresh note — you never have to predict the price.</p>
          </div>
          <div className="feature">
            <div className="ico"><IconBolt /></div>
            <h3>Gasless via relayer</h3>
            <p>A relayer submits your transaction so your funded, linkable address never touches the pool. Every parameter is bound into the proof — it cannot steal or tamper.</p>
            <span className="tag">breaks the address link</span>
          </div>
        </div>
      </section>

      {/* ---------------- how it works ---------------- */}
      <section id="how" className="section alt">
        <div className="wrap">
          <h2>Four moves.</h2>
          <p className="sub">Shield, transfer, swap, unshield — one shielded transaction covers them all.</p>
          <div className="steps">
            <div className="step"><div className="n">1</div><h4>Shield</h4><p>Deposit an asset into a private note with a fresh, screenable label.</p></div>
            <div className="step"><div className="n">2</div><h4>Prove</h4><p>A zero-knowledge proof attests ownership, value, and compliance — client-side.</p></div>
            <div className="step"><div className="n">3</div><h4>Swap</h4><p>Trade through public liquidity; proceeds re-shield into a new private note.</p></div>
            <div className="step"><div className="n">4</div><h4>Settle</h4><p>Transfer privately or unshield to any address — unlinkable to your deposit.</p></div>
          </div>
        </div>
      </section>

      {/* ---------------- compliance ---------------- */}
      <section id="compliance" className="section wrap">
        <h2>Privacy, with proof<br />of innocence.</h2>
        <p className="sub">
          On a regulated chain, privacy needs an answer. Sherwood implements the Privacy-Pools model:
          prove your funds trace to an approved deposit — without revealing which one.
        </p>
        <div className="features">
          <div className="feature">
            <div className="ico"><IconSeal /></div>
            <h3>Association-set membership</h3>
            <p>Every spend proves in zero-knowledge that its note descends from a deposit approved by an Association-Set Provider — never disclosing the deposit.</p>
          </div>
          <div className="feature">
            <div className="ico"><IconKey /></div>
            <h3>Viewing keys</h3>
            <p>Voluntarily disclose your own history to an auditor, read-only. It reveals your activity but never lets anyone spend.</p>
          </div>
          <div className="feature">
            <div className="ico"><IconShield /></div>
            <h3>Screened at the source</h3>
            <p>Deposits reveal a per-deposit label for screening and are forced to be pure, so fresh value can never inherit an already-approved history.</p>
          </div>
        </div>
      </section>

      {/* ---------------- $SWOOD token ---------------- */}
      <section id="swood" className="section wrap">
        <span className="eyebrow">The Sherwood token</span>
        <h2>$SWOOD</h2>
        <p className="sub">
          The native token that powers Sherwood — fee discounts, governance over listings and the
          association set, and a share of relayer revenue.
        </p>

        <div className="glass token-card">
          <div className="token-id">
            <span className="token-logo">SW</span>
            <div>
              <div className="token-name">$SWOOD</div>
              <a
                className="token-ca mono-sm"
                href="https://robinhoodchain.blockscout.com/token/0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60"
                target="_blank"
                rel="noreferrer"
              >
                0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60
              </a>
            </div>
          </div>
          <a
            className="btn"
            href="https://app.uniswap.org/swap?outputCurrency=0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60&chain=robinhood"
            target="_blank"
            rel="noreferrer"
          >
            Buy $SWOOD
          </a>
        </div>

        <div className="features" style={{ marginTop: 28 }}>
          <div className="feature">
            <h3>Fee discounts</h3>
            <p>Hold $SWOOD to cut the public-swap fee: 0.30% base → 0.15% at 100k → 0% at 1M $SWOOD.</p>
          </div>
          <div className="feature">
            <h3>Governance</h3>
            <p>Stake $SWOOD and vote on new listings + protocol parameters. <a href="#/govern" style={{ color: "var(--lime)" }}>Vote →</a></p>
          </div>
          <div className="feature">
            <h3>Revenue share</h3>
            <p>Stake $SWOOD to earn a share of the protocol's swap-fee revenue, streamed in USDG. <a href="#/stake" style={{ color: "var(--lime)" }}>Stake →</a></p>
          </div>
        </div>
      </section>

      {/* ---------------- roadmap ---------------- */}
      <section id="roadmap" className="section alt">
        <div className="wrap">
          <h2>Roadmap.</h2>
          <p className="sub">Where Sherwood is headed.</p>
          <div className="roadmap">
            <div className="rm-item">
              <span className="rm-mark live">Live</span>
              <h4>Private swaps · multi-DEX routing</h4>
              <p>Shielded swaps auto-routed through WETH across Uniswap v2/v3/v4, plus $SWOOD live.</p>
            </div>
            <div className="rm-item">
              <span className="rm-mark live">Live</span>
              <h4>WOODIE — AI copilot</h4>
              <p>Shield, swap privately, quote and bridge in plain language. ERC-8004 verified agent; you sign everything yourself.</p>
            </div>
            <div className="rm-item">
              <span className="rm-mark live">Live</span>
              <h4>Private Route — 100+ chains</h4>
              <p>Arrive from or leave to BTC, XMR, SOL &amp; 1000+ tokens via multi-hop CEX routing. The trail breaks en route.</p>
            </div>
            <div className="rm-item">
              <span className="rm-mark">Soon</span>
              <h4>Community liquidity</h4>
              <p>Uniswap-style SWOOD/ETH pools on Sherwood's own AMM, with incentives via Points.</p>
            </div>
            <div className="rm-item">
              <span className="rm-mark live">Live</span>
              <h4>Mobile access</h4>
              <p>Installable PWA with a mobile-native shielded trading UI.</p>
            </div>
            <div className="rm-item">
              <span className="rm-mark">Planned</span>
              <h4>&amp; more</h4>
              <p>On-chain governance, deeper liquidity, and community-driven listings.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- CTA band ---------------- */}
      <section className="section wrap">
        <div className="band">
          <h2>Trade in private.</h2>
          <p>Connect a wallet on Robinhood Chain and shield your first note. Your keys are derived from a signature and never leave your browser.</p>
          <button className="btn" onClick={onConnect} disabled={busy}>Launch app</button>
        </div>
      </section>
    </main>
  );
}
