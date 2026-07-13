# Sherwood — Internal Security Audit

## 1. Executive Summary

Sherwood is a multi-asset shielded pool with an integrated AMM swap path and an Association-Set-Provider (ASP) "proof-of-innocence" compliance layer, targeting a regulated-RWA deployment on Robinhood Chain. This internal audit reviewed the Solidity contracts (`src/`), the `transaction.circom` circuit, the TypeScript client SDK (`client/`), and the transaction relayer (`relayer/`).

The core value-conservation machinery — nullifier accounting, ownership proofs, range checks, Merkle membership, and collateralization — was reviewed and found sound. Deposits, transfers, and withdrawals do not permit fund minting or theft of other users' funds, and the pool stays collateralized.

However, **the protocol's headline security property — association-set compliance / proof-of-innocence — is completely and permissionlessly bypassable at zero cost.** Deposit and swap labels, on which the entire screening model rests, are attacker-chosen and bound to nothing. Any user can smuggle unscreened value into the approved set. Because compliance integrity is the reason this system exists, this is a protocol-defining defect, not a peripheral one.

Compounding this, the compliance layer is governed by a single unconstrained ASP/owner (no timelock, no multisig, no user exit valve), and several owner levers can freeze already-committed user funds.

**Overall risk verdict: NOT READY.** The advertised compliance guarantee is currently void, and multiple centralized fund-freeze levers exist. The confidentiality and fund-safety properties are in better shape but carry real defects. Substantial remediation plus external review are required before any real value is handled.

---

## 1a. Remediation Status (post-audit hardening pass)

All 12 code-level findings below were remediated in this pass; M-1 is documented (deep refactor deferred). This does **not** change the mainnet verdict — an *external* audit + a real trusted-setup ceremony are still prerequisites (see §4). This pass closed the internally-found defects and added regression tests so an external reviewer starts from a hardened baseline.

| # | Severity | Status | Remediation |
|---|---|---|---|
| C-1 | Critical | ✅ Fixed | Deposit & swap labels are now derived on-chain as `Poseidon(msg.sender, depositNonce[sender])` (unique, sender-bound), verified against the proof's `depositLabel` public signal, and recorded in `usedLabel` to bar reuse. Forged/reused labels revert. No circuit change (already binds `note.label == depositLabel`). Proven end-to-end + `test_Revert_ForgedDepositLabel`, `test_DepositLabel_DerivedUniquePerDeposit`. |
| H-1 | High | ✅ Fixed | ASP rotation is now a 2-step `proposeAsp`/`acceptAsp` with a 2-day timelock; a 64-entry rolling `associationRoots` history means publishing a new root no longer strands in-flight proofs; de-listing an asset keeps an exit valve (below). Tests: `test_Asp_TwoStepTimelock`, `test_KnownAssociationRoot_HistorySpend`. |
| M-1 | Medium | ✅ Fixed | Swaps now use a **per-swap stealth key**: `swapPubKey = Poseidon(Poseidon(DOMAIN, spendKey, swapBlinding))` with a fixed domain tag (`sherwood/swap-stealth-v1`), so each swap reveals only a fresh one-time pubkey unlinkable to the account or to other swaps. The scanner re-derives the stealth key from the ECIES-recovered `swapBlinding` (zero new on-chain data, O(1) per note) with a permanent legacy master-key fallback for pre-fix claim notes; spending passes the stealth key as the input's `inPrivateKey` witness (the circuit is already per-input-key — no circuit/contract change). ClientState v3 persists per-note pubkeys (v2 caches migrate in place). Client-only fix. Tests: offline units (derivation determinism/domain separation, claim recovery, witness override) + e2e with real proofs (fresh key per swap, discovery of both claims, stealth spend, snapshot/load round-trip spend). |
| M-2 | Medium | ✅ Fixed | Account-key signing message now carries a domain: `network:<chainId>`, `pool:<address>`, `version`. A signature for one chain/pool no longer derives the same key elsewhere. |
| M-3 | Medium | ✅ Fixed | Deposit path gated on `supportedAsset`; the exit (unshield) path is not — holders can always withdraw a de-listed asset. Test: `test_Delist_BlocksDeposit_AllowsExit`. |
| M-4 | Medium | ✅ Fixed | Same rolling association-root history as H-1 — recently-valid roots stay accepted. |
| M-5 | Medium | ✅ Fixed | Relayer rate limiter now keys on the **right-most** (trusted-proxy-appended) XFF hop behind `trustProxy`, else `socket.remoteAddress`. Left-most spoofing no longer forges IPs. |
| M-6 | Medium | ✅ Fixed | `validate()` wrapped in try/catch → 400; malformed bodies return 400 instead of crashing the process. |
| L-1 | Low | ✅ Fixed | SDK reserves selected note nullifiers during an in-flight build (`utxos()` excludes them); reservations clear on `invalidate()` and via `release()`, so concurrent/rapid builds can't double-select. |
| I-1 | Info | ✅ Fixed | Sanctions stub is now honest: explicit no-op by default, `SANCTIONS_FAIL_CLOSED=1` rejects until a real provider is wired; the meaningless `tokenOut` (token-contract) screen was removed. |
| I-2 | Info | ✅ Fixed | `SwapExecutor.swap` forces `recipient = msg.sender`, so a permissionless caller can only ever receive the output of tokens it itself funded — no caller-chosen residual routing. |

---

## 2. Findings

### Critical

#### C-1 — Association-set compliance is fully bypassable: labels are unconstrained, non-unique, and reusable
**Location:** `src/Sherwood.sol:180, 188, 204–205, 259, 266`; `circuits/transaction.circom:31, 170, 173–182`; `client/src/pool.ts:16, 298`; `client/src/assoc.ts:14–21`
*(Consolidates three separately-verified findings — core-pool, econ-governance, and circuit — that describe the same root defect across contract, circuit, and SDK.)*

The compliance model requires that (a) a spend prove its note's `label` is a member of the ASP-approved `associationRoot`, and (b) value entering the pool be a pure deposit so unscreened value cannot inherit an approved label. The purity guard is enforced (`isDeposit == 1` for value-in, `Sherwood.sol:180`; `isDeposit === IsZero(sumIns)` in-circuit), **but the label itself is a free prover-chosen field element.** The only deposit constraint is `isDep.out * (txLabel - depositLabel) === 0` (`transaction.circom:170`); the label is never bound to `msg.sender`, a monotonic nonce, the deposit's own commitment, or the funds' origin. Association membership is proven over the **bare label value** (`assocTree.leaf <== txLabel`, line 174), and the contract keeps **no used-label registry** (the only mapping is `nullifierHashes`). Every approved label is public via the indexed `Deposit(uint256 indexed label, …)` event.

**Impact — verified end-to-end (CONFIRMED):** An attacker reads any approved label `L` from a prior `Deposit` event (or self-approves a trivial clean deposit to seed `L`). They then submit a *pure* deposit of dirty/unscreened funds with `depositLabel = L` — this passes the purity guard, the circuit, and the contract, minting spendable notes labeled `L` with zero ASP screening of that deposit. They later spend those notes, proving `L ∈ associationRoot` (still true), and exit with a valid "proof-of-innocence." The same trick applies to `swapLabel`. The ASP cannot stop it: the set is keyed on the bare label, so it cannot distinguish the dirty `L`-note from the clean `L`-note, and revoking `L` would freeze the honest depositor. This defeats the entire reason the association set exists. No fund theft, and the pool stays collateralized, but the advertised compliance guarantee is entirely void, permissionlessly, at zero cost.

**Fix:** Derive the label deterministically and uniquely on-chain and pass it into the proof as a public signal the circuit must equal — e.g. `label = Poseidon(scope, monotonic-nonce)` or `Poseidon(msg.sender, contract-counter)` — rather than accepting an arbitrary `depositLabel`/`swapLabel` from the caller. At minimum, add `mapping(uint256 => bool) usedLabel` and revert on any reused label. The ASP must approve labels cryptographically bound to one specific, screenable deposit (approve by `(label, commitmentIndex)`, not by bare value). This restores the canonical Privacy-Pools invariant.

---

### High

#### H-1 — Single unconstrained ASP + instant owner reassignment: compliance and withdrawal liveness are a single point of failure
**Location:** `src/Sherwood.sol:137–148`

`setAssociationRoot(uint256)` accepts any 256-bit value from the single `asp` address with no validation, timelock, or multisig, and `setAsp(newAsp)` lets the owner swap in a new ASP instantly. At deployment `owner == asp == a single EOA`, and `associationRoot` defaults to `0` (uninitialized).

**Impact (CONFIRMED):** Three concrete failure modes. (1) **Censorship/rug** — owner appoints a malicious ASP, which publishes an exclusionary root; every honest spend reverts with "stale association root" while deposits still succeed, freezing pooled funds. (2) **Laundering** — a malicious ASP publishes a root containing dirty labels. (3) **Liveness** — an honest-but-offline/lost-key ASP leaves every post-approval deposit permanently unspendable, with no recovery path. This is a centralization finding (requires a privileged role to be malicious/compromised/negligent), but the missing timelock/multisig on both setters, the missing user-exit valve, and `owner == asp == single EOA` are genuine, un-mitigated defects spanning the entire fund base.

**Fix:** Require a multisig for both `asp` and root updates; add timelocks to `setAsp` and `setAssociationRoot`; emit auditable screening evidence; and provide a user-exit safety valve (after a max ASP-inactivity window, allow withdrawal against a permissive/last-known root) so a dead or malicious ASP cannot permanently freeze funds.

---

### Medium

#### M-1 — Swaps leak the account master pubKey in cleartext, deanonymizing the swap graph
**Location:** `client/src/pool.ts:372`; supporting `client/src/keypair.ts:42, 73–75`; `client/src/extdata.ts:16, 37`; `src/Sherwood.sol:259`

`buildSwap` sets `extData.swapPubKey = this.keypair.pubKey` — the account's long-term master public key, which is also the public "Sherwood address" every counterparty is given. `extData` travels in on-chain calldata (only hashed, never hidden), so every swap publishes this persistent identifier in the clear.

**Impact (CONFIRMED):** A passive observer clusters all of an account's swaps by the identical `swapPubKey`, and anyone holding the victim's Sherwood address attributes those swaps by name, then chains in the swap's nullifiers and re-shield outputs. This directly falsifies the documented "owner of the output note is hidden" guarantee (`README.md:21`, `SECURITY.md:21`). No funds at risk; scoped to swaps.

**Fix:** Derive a per-swap stealth owner key from `spendKey` plus a fresh swap nonce (`childPub = Poseidon(H(spendKey, swapNonce))`) and place that unlinkable one-time key in `swapPubKey`; remember the nonce to spend the claim note. At minimum, document that swaps are non-private.

#### M-2 — Account key has no chain/pool domain separation and is fully recoverable from one reused signature
**Location:** `client/src/keypair.ts:48`; `web/app/src/wallet.ts:38–40`; `web/app/src/config.ts:42–43`

The entire account (spendKey + viewKey) derives from `keccak256(signature)` over a hardcoded fixed message with no chainId, pool address, or nonce mixed in. The same wallet yields the same, non-rotatable account on every chain and pool.

**Impact (CONFIRMED):** Because EIP-191 `personal_sign` does not bind the requesting origin and ECDSA is deterministic, a signature phished on a hostile site over this exact public message is byte-identical to the real one, yielding the identical seed — and thus both keys, enabling discovery and drain of every note across all pools/chains, irreversibly. Gated behind a signature-phishing precondition, but blast radius is catastrophic and global.

**Fix:** Include a strong domain (protocol tag + chainId + pool address + version) in both the signed message and the KDF, and prefer a per-account random secret that the signature only unlocks rather than fully determines.

#### M-3 — Owner can freeze already-shielded funds by de-listing an asset
**Location:** `src/Sherwood.sol:131–133, 173, 225–226, 235`

`transact` requires `supportedAsset[assetToken]` for **all** modes including unshield and swap-out, and `assetId` is proof-bound so it cannot be substituted. `setAsset(token,false)` is a direct `onlyOwner` write with no timelock.

**Impact (CONFIRMED):** After users shield token X, the owner calls `setAsset(X,false)`; all holders of X-notes lose unshield, swap-out, *and* transfer simultaneously — funds trapped until re-listing, with no user recourse.

**Fix:** Separate "accept new deposits" from "allow exits": gate only the deposit path on `supportedAsset`, and always permit exit of any asset that already has notes. Alternatively, timelock removal and never let it block existing-note withdrawals.

#### M-4 — Association root has no history window: any root rotation invalidates all in-flight spend proofs
**Location:** `src/Sherwood.sol:179` (vs `MerkleTreeWithHistory.sol:74–91`)
*(Consolidates the Medium and Low variants of the same defect.)*

The commitment root uses a 100-deep rolling history (`isKnownRoot`), but the association root is checked by exact equality against a single scalar. A proof pins `proof.associationRoot` as a public signal, so every `setAssociationRoot` call atomically invalidates all outstanding spend proofs.

**Impact (CONFIRMED):** Occurs in normal operation — every routine ASP approval shifts the root and reverts concurrent honest withdrawals with "stale association root," forcing costly re-proving; a malicious ASP can rotate to make withdrawals practically impossible to land. ASP-gated, retriable, no fund loss.

**Fix:** Mirror the commitment tree — keep a bounded rolling history/allowlist of recent association roots and accept any recently-valid root. Set growth is monotonic for additions, so accepting a slightly-stale root is safe; handle revocations explicitly.

#### M-5 — X-Forwarded-For spoofing bypasses the relayer per-IP rate limiter
**Location:** `relayer/src/server.ts:121–128`; `relayer/src/config.ts:22`

`trustProxy` defaults to `true` and `clientIp()` takes the attacker-controlled left-most XFF entry, so the per-IP bucket key is fully attacker-controlled.

**Impact (CONFIRMED):** A single host sends requests with random `X-Forwarded-For` values, never trips the 10/min per-IP cap, and alone consumes the entire 120/min global budget — locking out legitimate users with 429s and amplifying gas-drain. Bounded availability impact.

**Fix:** Only honor XFF behind a validated trusted proxy, taking the right-most appended hop; otherwise key on `req.socket.remoteAddress`. Default `trustProxy` to false.

#### M-6 — Unhandled exceptions in relayer `validate()` crash/hang the process on a single malformed request
**Location:** `relayer/src/server.ts:82` (throws at 47, 53, 58, 62, 64); `client/src/serde.ts:61–77`

`deserializeBuiltTx` does not validate that `recipient`/`relayer`/`tokenOut` are 20-byte addresses or that `assetId < 2^160`, so a body with one garbage address deserializes fine, then `validate()` throws inside `encodeAbiParameters`/`getAddress`. The `await validate(tx)` call has no try/catch and there is no process-level `unhandledRejection` guard.

**Impact (CONFIRMED):** Under modern Node's default `throw` mode, a single unauthenticated `/transact` request terminates the entire relayer — the sole user-facing submission route. Repeatable at will.

**Fix:** Wrap `validate()` in try/catch returning 400, validate address/field shape up front in `deserializeBuiltTx`, and add a process-level `unhandledRejection` guard.

---

### Low

#### L-1 — SDK does not reserve selected UTXOs, so concurrent/rapid builds double-select the same notes
**Location:** `client/src/pool.ts:239`

`utxos()`/`selectInputs` choose from `owned` minus `spent`, and `spent` is only populated from on-chain `NewNullifier` events. Nothing marks a note in-flight after selection.

**Impact (CONFIRMED):** Two back-to-back builds before the first confirms select identical inputs; the second tx reverts on-chain ("input already spent"), wasting relayer fee/gas and corrupting optimistic balance. On-chain nullifier check prevents any double-spend — self-griefing foot-gun only.

**Fix:** Track a locally-reserved nullifier/index set for in-flight builds, exclude it in selection, and expose a release API on failure.

---

### Informational

#### I-1 — Sanctions screen is a default-disabled no-op stub; tokenOut screening has no compliance value
**Location:** `relayer/src/screen.ts:6–23`; `relayer/src/server.ts:62–67`

`screenAddress()` only rejects addresses in the `SANCTIONS_DENYLIST` env var, which is empty by default and never `required()` — so out of the box every recipient passes. Screening `extData.tokenOut` is meaningless (it is a Uniswap token-contract address, never a counterparty); the unshield recipient is the only genuine clear-value exit and is correctly screened. Self-acknowledged as an MVP stub in-code.

**Fix:** Fail closed when no provider is configured, wire a real Chainalysis/TRM provider on the recipient, and drop the `tokenOut` screen.

#### I-2 — `SwapExecutor.swap` is permissionless and forwards residual balances to a caller-chosen recipient
**Location:** `src/SwapExecutor.sol:32–64`

`swap` is `external` with no access control and forwards leftover `tokenIn` to a caller-supplied `recipient`. Normal flow is safe (Sherwood funds exact `amountIn` atomically with `recipient = pool`, leaving no standing balance), so no protocol funds are exposed. Only tokens *donated* directly to the executor between calls are sweepable (via a nonzero-amount leg against an existing pool; the zero-amount variant reverts). Negligible impact — the standard "anyone can take tokens mistakenly sent to a custody-free contract" pattern.

**Fix:** `require(msg.sender == pool)` or force `recipient = pool`.

---

## 3. What Looked Solid

- **Value conservation & note accounting:** join-split sum constraints, ownership proofs, nullifier derivation, range checks, and Merkle membership were reviewed and are sound. No fund-mint or inflation path was found.
- **Collateralization:** the pool remains fully collateralized; no finding enables theft of another user's funds.
- **Commitment Merkle root history:** the 100-deep `isKnownRoot` rolling window correctly prevents benign tree advancement from invalidating in-flight proofs (and is the model M-4 recommends copying for the association root).
- **Asset-canonicalization binding:** `assetId` is proof-bound to `publicAsset` and to input notes, preventing asset-substitution dodges.
- **SwapExecutor custody model:** the executor holds no standing balance in normal flow; funding, swap, and leftover-forwarding are atomic (invariant-tested).
- **Unshield recipient screening:** the one genuine clear-value exit is correctly passed to the screen (whatever the screen's own configuration limits).
- **Nullifier double-spend protection:** the on-chain nullifier set fully protects funds even when the SDK mis-selects inputs (L-1).

---

## 4. Mainnet-Readiness Verdict

**Sherwood is NOT ready for mainnet.** Its advertised core guarantee — association-set / proof-of-innocence compliance — is currently void (C-1), and the compliance/governance layer is a single unconstrained point of failure with several owner-controlled fund-freeze levers.

Be explicit about the limits of this review:

> **This internal audit does NOT substitute for (a) an external professional audit of BOTH the Solidity contracts and the `transaction.circom` circuit, nor (b) a real multi-party trusted-setup ceremony.** The proving/verifying keys in this repository are a **development (single-party) setup**; a dev zkey is a backdoor — anyone with the toxic waste can forge proofs. A production, audited circuit MUST be paired with a genuine multi-contributor MPC ceremony before any real value is handled.

### Prioritized must-fix list (before external audit + ceremony)

1. **C-1 — Bind labels to unique, contract-derived, per-deposit values** and enforce uniqueness on-chain (`usedLabel` at minimum; in-circuit `Poseidon(scope, nonce)` derivation preferred). Without this the protocol has no compliance guarantee at all. *(Highest priority — this is the product.)*
2. **H-1 — Decentralize and constrain the ASP/owner:** multisig + timelock on `setAsp` and `setAssociationRoot`, initialize `associationRoot`, and add a user-exit safety valve so a dead/malicious ASP cannot permanently freeze funds.
3. **M-3 — Separate asset de-listing from the exit path** so the owner cannot trap already-shielded funds.
4. **M-4 — Add an association-root history window** to stop routine ASP updates from bricking honest in-flight withdrawals.
5. **M-6 & M-5 — Harden the relayer:** try/catch + input validation + `unhandledRejection` guard (single-request crash), and fix XFF trust/rate-limit keying.
6. **M-2 & M-1 — Fix key derivation domain separation and the swap pubKey leak** before users are told their activity is private.
7. **I-1 — Fail closed on sanctions screening** and wire a real provider on the recipient before touching regulated value.

Items C-1, H-1, and the circuit trusted-setup concern should be treated as **release-blocking**. The remaining items should be resolved or explicitly risk-accepted, in writing, prior to the external audit — not after.

*Scope note: 23 raw findings were triaged; 9 were refuted under adversarial verification and are excluded. The 14 above are those that survived as CONFIRMED, consolidated where they described the same underlying defect across contract, circuit, and SDK layers.*