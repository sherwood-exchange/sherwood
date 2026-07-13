<p align="center">
  <img src="brand/mark.svg" width="96" alt="Sherwood mark" />
</p>

<h1 align="center">Sherwood Exchange</h1>

<p align="center">
  <b>A privacy-first exchange on Robinhood Chain, run by an autonomous AI agent.</b><br/>
  Shielded trading &middot; public multi-DEX aggregation &middot; cross-chain exit &middot; $SWOOD utility &middot; live agent commerce on Virtuals ACP
</p>

<p align="center">
  <a href="https://sherwood.spot">https://sherwood.spot</a> — live on Robinhood Chain mainnet (chainId 4663)
</p>

---

> **Status:** internally audited, mainnet-deployed MVP. The ZK trusted setup is a **dev ceremony** and there has been **no external audit** — do not shield value you cannot afford to lose. Read [AUDIT.md](AUDIT.md) for the full internal security review and remediation log.

## What is Sherwood?

Sherwood is a full-stack exchange for **Robinhood Chain** (Arbitrum Orbit L2) with two trading paths and an AI-native commerce layer:

1. **Shielded pool** — value is held in fully-shielded notes. Identity, balance, note asset, and the deposit↔withdrawal link are hidden by a ZK commitment/nullifier scheme (Groth16 + Poseidon Merkle tree). Four actions through one entrypoint: **shield, private transfer, unshield, and shielded swap** that routes through public Uniswap liquidity and re-shields the proceeds.
2. **Public aggregator** — a non-custodial any-token swap router across **Uniswap v2, v3, and v4** liquidity, routed through an ETH hub. 1,000+ tokens including **all 23 tokenized stocks** (AAPL, TSLA, NVDA, SPCX, GOOGL, AMZN, SPY, QQQ, …), with a **$SWOOD-tiered protocol fee**. The same 23 stocks are also allowlisted in the shielded pool for private trading.
3. **Sherwood Exchange agent** — an autonomous agent, **live and earning on [Virtuals ACP](https://app.virtuals.io/)**, that sells live quotes, portfolio reads, real on-chain swap execution, and ETH on-ramping to Robinhood Chain for USDC escrow. See [`agent/`](agent/).

### Feature map

| Feature | Where | Notes |
|---|---|---|
| Shielded pool (shield / transfer / unshield / private swap) | `src/Sherwood.sol`, `circuits/`, `client/` | Aztec-Connect model: shielded pool over external AMM liquidity |
| Proof-of-innocence compliance | `src/Sherwood.sol`, `asp/` | Privacy-Pools association sets; on-chain sender-bound deposit labels; automated ASP approver |
| Public multi-DEX aggregator | `src/AggRouter.sol`, `web/app` | v2/v3/v4 via ETH hub, two-hop routes, searchable 1k+ token universe |
| $SWOOD fee tiers | `src/AggRouter.sol` | 0.30% base &rarr; 0.15% at &ge;100k $SWOOD &rarr; 0% at &ge;1M $SWOOD |
| $SWOOD staking (earn USDG) | `src/SwoodStaking.sol` | Synthetix-style rewards funded by protocol fees |
| Governance | `src/SwoodGovernor.sol` | Stake-weighted signaling; 100k threshold, 3-day votes |
| Private bridge (exit to any chain) | `web/app`, Relay.link | Unshield &rarr; bridge out; breaks the shielded-pool link |
| Points / activity indexer | `points/` | Chunked, rate-limit-aware on-chain indexing |
| Transaction relayer | `relayer/` | Validates, simulates, and submits shielded transactions; rate-limited |
| Autonomous ACP agent | `agent/` | Sells quotes, portfolio, swap execution, and RH on-ramp 24/7 |

## Live deployment (Robinhood Chain, chainId 4663)

| Contract | Address |
|---|---|
| Sherwood shielded pool | `0x6504c957ec52b279667e6836b102a0c2586e919c` |
| SwapExecutor | `0x97C68D7cd147eBbcC448F845b22a0BE74bA1125D` |
| AggRouter (public aggregator) | `0x01bfe0d5d43be24f2edf626bdd2ff41af5dc4e0c` |
| $SWOOD token | `0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60` |
| SwoodStaking | `0x34677e5dd609d79ca2a413c51976154db7c1973f` |
| SwoodGovernor | `0x0b6c6f778e7ac3dd576658fbc35a0ac643f79fd7` |

Chain quick facts: gas is ETH (Arbitrum Orbit), the native stablecoin is **USDG** (there is no USDC), Uniswap v2/v3/v4 are all live, and stock tokens are KYC-gated only inside their own contracts — the chain itself is permissionless. Full researched sheet: [`deploy/robinhood-chain.json`](deploy/robinhood-chain.json).

## How the privacy core works

```
        shield / transfer / unshield / swap
                      │
                      ▼
  ┌────────────────────────────────────────────────┐
  │ Sherwood.transact(proof, extData)              │
  │  • Groth16 verify (Merkle inclusion, ownership,│
  │    value conservation, asset binding)          │
  │  • consume nullifiers, insert output notes     │
  │  • move tokens by mode; swap → SwapExecutor →  │
  │    Uniswap → re-shield actual proceeds         │
  └────────────────────────────────────────────────┘
      │ Poseidon Merkle tree (rolling root history)
      │ multi-asset UTXO notes, one shared anonymity set
```

- `note = { amount, assetId, pubKey, blinding, label }` — `label` is a per-deposit compliance tag, derived **on-chain** as `Poseidon(sender, nonce)` so it cannot be forged or reused.
- `commitment = Poseidon(note)`; `nullifier = Poseidon(commitment, path, sign)` — revealed on spend, hides the leaf.
- Join-split **2-in / 2-out**: `sum(in) + publicAmount == sum(out)`, every real input note's asset must equal the public asset.
- **Compliance:** spends prove, in ZK, that their deposit labels belong to an ASP-curated association set (Privacy-Pools proof-of-innocence). The ASP publishes roots automatically (`asp/`); rotation is 2-step with a timelock, and de-listed assets always keep an exit valve.
- The cross-asset step of a shielded swap happens in Solidity, where the AMM output is known — the circuit stays a clean single-asset join-split and the user never has to predict a price.

Proving runs **in the browser** (Web-Worker prover); keys are derived from a wallet signature and never leave the client.

## Repository layout

```
src/            Solidity: Sherwood pool, SwapExecutor, AggRouter, $SWOOD token,
                staking, governor, Poseidon Merkle tree, Groth16 verifier
circuits/       circom join-split circuit + build/ceremony scripts
client/         TypeScript SDK: keys, notes (ECIES), tree sync, proofs, all 4 actions
relayer/        transaction relayer (validate → simulate → submit)
points/         on-chain activity indexer
asp/            automated association-set approver (compliance)
web/app/        Vite + React dApp — shielded pool, swap, bridge, stake, govern, points
agent/          Sherwood Exchange agent: Virtuals GAME + ACP provider loop,
                live quoting, native swap execution, inventory keeper
script/         Foundry deploy scripts        scripts/  viem deploy/ops scripts
deploy/         chain config + VPS Docker Compose stack (Caddy/TLS, relayer,
                points, RPC proxy, ASP, watchdog)
test/           Foundry: state machine, fuzz, stateful invariants, hardening
brand/          logo, wordmark, palette
```

## Quickstart

### Contracts & circuit

```bash
npm install
forge test -vvv               # state machine, swap, Poseidon parity, hardening, invariants
npm run circuit:build         # compile + dev ceremony → Verifier.sol + zkey/wasm
```

### Full end-to-end with real proofs (local)

```bash
anvil &
forge script script/E2EDeploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --broadcast --private-key <anvil key 0>
npx tsx client/test/offline.test.ts    # ZK stack: parity, ECIES, real proof vs vkey
npx tsx client/test/e2e.ts             # shield → transfer → unshield → swap, real proofs
```

### Web app

```bash
cd web/app && npm install && npm run dev     # http://localhost:5173
```

### Agent

```bash
cd agent && npm install && cp .env.example .env   # add GAME_API_KEY
npm run ask -- demo                               # exercise every live data function, no cloud needed
npm run acp:serve                                 # ACP provider loop (fulfils paid jobs)
```

### Production stack

`deploy/vps/` contains the full Docker Compose deployment used at `sherwood.spot`: Caddy (auto-TLS) fronting the static web bundle, relayer, points indexer, a CORS RPC proxy, the ASP approver, and a watchdog. `cp .env.example .env`, fill it in, then `docker compose up -d --build`.

## The agent economy (Virtuals ACP)

The Sherwood Exchange agent is a **live commercial agent** on Virtuals ACP. Buyers pay in USDC (Base escrow); the agent answers from live chain state — it never invents numbers — and can execute **real swaps on Robinhood Chain**, delivering tokens (including tokenized stocks) straight to the buyer's address from its own ETH inventory, priced dynamically at live USD value plus margin.

| Offering | What the buyer gets |
|---|---|
| `swap_quote` / `bridge_quote` | Live routed prices (v2/v3/v4 hub routing / Relay cross-chain) |
| `token_search` / `swood_info` / `portfolio` | Token universe search, $SWOOD stats, address portfolio valuation |
| `sherwood_swap` | A real, executed on-chain swap on Robinhood Chain |
| `rh_onramp` | ETH delivered to a Robinhood Chain address |

Full agent documentation: [`agent/`](agent/).

## Security

- [AUDIT.md](AUDIT.md) — full internal adversarial review: findings, severity, and the remediation pass (12/12 code-level findings closed; one linkability item documented as a scoped follow-up).
- Known prerequisites for handling real value: an **external audit** and a **real MPC trusted-setup ceremony** (the shipped zkey is from a dev ceremony).
- The relayer, ASP, and deployment stack run with least-privilege keys; secrets are injected at runtime and never baked into images.

## Brand

Palette: **Robinhood Lime `#CCFF00`** · Covert `#0A0E0C` · Moonlight `#EAF2EC`. Type: Fraunces (display) + IBM Plex Mono (UI). Voice: *“Leave no trace.”* Assets in [`brand/`](brand/).
