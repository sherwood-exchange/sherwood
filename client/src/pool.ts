// SherwoodClient — the high-level shielded-pool client.
// Syncs the local Merkle tree + owned-note set from chain events, then builds
// ready-to-submit { proof, extData } payloads for the four shielded actions.

import type { PublicClient, Address } from "viem";
import { getAddress } from "viem";
import { SHERWOOD_ABI } from "./abi.js";
import { Keypair, PublicAddress, deriveSwapStealthKey } from "./keypair.js";
import { poseidon } from "./poseidon.js";
import { Note } from "./note.js";
import { MerkleTree } from "./tree.js";
import { proveTransaction, OwnedInput, SolidityProof, FullProveFn } from "./prover.js";
import { ExtData, extDataHash, encodeExtData, ZERO_ADDR, EMPTY_BYTES } from "./extdata.js";
import { FIELD_SIZE, mod, type Artifacts } from "./config.js";
import { AssociationSet } from "./assoc.js";

export interface Utxo {
  note: Note;
  index: number;
  nullifier: bigint;
  /** Owner private key: the master spendKey for normal notes, a per-swap
   *  stealth key for swap claim notes (M-1). */
  privKey: bigint;
}

export interface BuiltTx {
  proof: SolidityProof;
  extData: ExtData;
  /** Nullifiers this build reserved locally (L-1). Pass to `release()` if the tx is
   *  never submitted so the notes free up; ignored by serialization/the relayer. */
  reservedNullifiers?: bigint[];
}

/** Serializable client state for an incremental-sync cache (e.g. localStorage). */
export interface ClientState {
  version: 3;
  pool: string;
  syncedToBlock: string;
  leaves: string[];
  // v3: each owned entry records its note's pubKey — the master pubKey for normal
  // notes, a per-swap stealth pubKey for swap claim notes (M-1). v2 caches (no
  // pubKey) are migrated in place: every pre-fix note used the master key.
  owned: { amount: string; assetId: string; pubKey?: string; blinding: string; label: string; index: number }[];
  spent: string[];
  // Approved association-set labels. Persisted because sync() only fetches NEW blocks —
  // without this, a warm-started client has an empty association set and can't build a
  // membership proof for an already-approved deposit ("not yet in the association set").
  assoc: string[];
}

export interface HistoryEntry {
  index: number;
  asset: `0x${string}`;
  amount: bigint;
  spent: boolean;
}

const assetIdOf = (token: string): bigint => BigInt(getAddress(token));

/** Reconstruct a swap claim note from its decrypted ECIES placeholder + the
 *  on-chain amountOut/label, and recover its owner key. Tries, in order:
 *   1. the per-swap stealth key re-derived from the decrypted blinding (M-1) —
 *      Poseidon(amountOut, assetId, stealthPub, blinding, label) must equal the
 *      on-chain commitment;
 *   2. the master pubKey (legacy pre-fix claim notes; kept permanently).
 *  Returns null if neither candidate reproduces the commitment. */
export function recoverClaimNote(
  keypair: Keypair,
  decrypted: Note,
  amountOut: bigint,
  label: bigint,
  commitment: bigint
): { note: Note; privKey: bigint } | null {
  const stealth = deriveSwapStealthKey(keypair.spendKey, decrypted.blinding);
  const stealthNote = new Note({ amount: amountOut, assetId: decrypted.assetId, pubKey: stealth.pub, blinding: decrypted.blinding, label });
  if (stealthNote.commitment() === commitment) return { note: stealthNote, privKey: stealth.priv };
  const legacyNote = new Note({ amount: amountOut, assetId: decrypted.assetId, pubKey: keypair.pubKey, blinding: decrypted.blinding, label });
  if (legacyNote.commitment() === commitment) return { note: legacyNote, privKey: keypair.spendKey };
  return null;
}

export class SherwoodClient {
  readonly pool: `0x${string}`;
  readonly keypair: Keypair;
  private client: PublicClient;
  private fromBlock: bigint;
  private artifacts: Artifacts;
  private fullProve: FullProveFn | undefined;
  /** Wallet address that submits shields — deposit labels bind to it on-chain. */
  private sender: Address | undefined;
  /** ASP association set — needed to build membership proofs for spends. */
  readonly assoc: AssociationSet;
  /** Demo mode: treat every on-chain Deposit label as approved (permissive ASP). */
  private autoApprove: boolean;

  tree = new MerkleTree();
  /** All notes ever discovered for this account (spent status tracked separately). */
  private owned: Utxo[] = [];
  private spent = new Set<bigint>();
  /** L-1: nullifiers locked by an in-flight build so a concurrent/rapid second
   *  build can't select the same notes. Cleared on invalidate() (chain reconcile). */
  private reserved = new Set<bigint>();
  private syncedToBlock: bigint | null = null;

  constructor(opts: {
    publicClient: PublicClient;
    pool: `0x${string}`;
    keypair: Keypair;
    artifacts: Artifacts; // circuit wasm + zkey (fs path in node, URL in browser)
    associationSet?: AssociationSet; // ASP-approved label tree; spends prove membership
    autoApproveDeposits?: boolean; // demo: build the association set from all Deposit events
    fromBlock?: bigint;
    fullProve?: FullProveFn; // e.g. a Web-Worker-backed prover in the browser
    sender?: Address; // wallet that submits shields (deposit labels bind to it on-chain)
  }) {
    this.client = opts.publicClient;
    this.pool = opts.pool;
    this.keypair = opts.keypair;
    this.artifacts = opts.artifacts;
    this.assoc = opts.associationSet ?? new AssociationSet();
    this.autoApprove = opts.autoApproveDeposits ?? false;
    this.fromBlock = opts.fromBlock ?? 0n;
    this.fullProve = opts.fullProve;
    this.sender = opts.sender;
  }

  /** The association root the next spend must prove against (read from chain). */
  private async onchainAssociationRoot(): Promise<bigint> {
    return (await this.client.readContract({
      address: this.pool,
      abi: SHERWOOD_ABI,
      functionName: "associationRoot",
    })) as bigint;
  }

  /** Incrementally scan chain events since the last sync (full scan on first run),
   *  appending new leaves to the tree and discovering newly-owned notes.
   *  Self-heals from chain reorgs: if the locally-rebuilt root is not one the pool
   *  recognizes, the incremental cursor is dropped and a full rescan is done. */
  async sync(): Promise<void> {
    await this._sync(false);
  }

  /** getContractEvents over [from, to], paged in bounded windows that adaptively shrink on
   *  a range/overload error (this RPC rejects wide getLogs windows) and grow back on success. */
  private async fetchEventsChunked(eventName: string, from: bigint, to: bigint): Promise<any[]> {
    const out: any[] = [];
    let lo = from;
    let span = 5000n; // proven-safe window on this RPC; adapts down if a node still balks
    while (lo <= to) {
      let hi = lo + span - 1n;
      if (hi > to) hi = to;
      try {
        const logs = await this.client.getContractEvents({ address: this.pool, abi: SHERWOOD_ABI, eventName: eventName as any, fromBlock: lo, toBlock: hi });
        out.push(...(logs as any[]));
        lo = hi + 1n;
        if (span < 5000n) span = span * 2n > 5000n ? 5000n : span * 2n; // recover window size
      } catch (err) {
        if (span <= 1n) throw err; // already at a single block — a real failure, surface it
        span = span / 2n; // shrink and retry the same lo
      }
    }
    return out;
  }

  private async _sync(isRescan: boolean): Promise<void> {
    const from = this.syncedToBlock === null ? this.fromBlock : this.syncedToBlock + 1n;
    // Resolve the head numerically and page the scan in bounded block windows: this RPC
    // returns an internal error for wide getLogs ranges. `from > head` just means nothing
    // new yet. A just-confirmed tx not yet in `head` isn't missed — the cursor only ever
    // advances to a block we actually saw a log in (see below), so the next sync re-scans.
    const head = await this.client.getBlockNumber();
    if (from > head) return;
    const [commitmentLogs, swapLogs, nullifierLogs, depositLogs] = await Promise.all([
      this.fetchEventsChunked("NewCommitment", from, head),
      this.fetchEventsChunked("SwapExecuted", from, head),
      this.fetchEventsChunked("NewNullifier", from, head),
      this.fetchEventsChunked("Deposit", from, head),
    ]);

    // Demo permissive ASP: every deposit label is "approved" into the local
    // association set, in emission order, so membership proofs can be built. The
    // ASP still publishes this root on-chain (setAssociationRoot) before spends.
    if (this.autoApprove) {
      const deposits = (depositLogs as any[])
        .slice()
        .sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
      for (const l of deposits) this.assoc.add(l.args.label as bigint);
    }

    // amountOut by claim-note index (swap claim amounts are unknown at encrypt time)
    const swapAmountByIndex = new Map<number, bigint>();
    for (const l of swapLogs as any[]) swapAmountByIndex.set(Number(l.args.claimIndex), l.args.amountOut as bigint);
    // label by commitment index — swap claim labels are contract-derived (C-1), so the
    // client recovers the real label from the Deposit event, not its placeholder.
    const depositLabelByIndex = new Map<number, bigint>();
    for (const l of depositLogs as any[]) depositLabelByIndex.set(Number(l.args.commitmentIndex), l.args.label as bigint);

    // append new commitments strictly in index order
    const commits = (commitmentLogs as any[])
      .map((l) => ({ commitment: l.args.commitment as bigint, index: Number(l.args.index), enc: l.args.encryptedOutput as string }))
      .sort((a, b) => a.index - b.index);

    for (const c of commits) {
      if (c.index < this.tree.size) continue; // already seen (range overlap safety)
      if (c.index !== this.tree.size) throw new Error(`commitment gap: expected index ${this.tree.size}, got ${c.index}`);
      this.tree.insert(c.commitment);

      const note = Note.tryDecrypt(this.keypair, c.enc);
      if (!note) continue;
      let real = note;
      let privKey = this.keypair.spendKey;
      if (real.commitment() !== c.commitment) {
        // swap claim note: recover the amount from the SwapExecuted event, the
        // label from the Deposit event, and the owner key from the blinding (M-1)
        const amountOut = swapAmountByIndex.get(c.index);
        if (amountOut === undefined) continue;
        const rec = recoverClaimNote(this.keypair, note, amountOut, depositLabelByIndex.get(c.index) ?? note.label, c.commitment);
        if (!rec) continue;
        real = rec.note;
        privKey = rec.privKey;
      }
      if (real.amount === 0n) continue;
      this.owned.push({ note: real, index: c.index, privKey, nullifier: real.nullifierWithKey(privKey, c.index) });
    }

    for (const l of nullifierLogs as any[]) this.spent.add(l.args.nullifier as bigint);

    // Advance the cursor ONLY to the highest block present in the returned logs — a
    // block we provably scanned. Do NOT seed it from a separate getBlockNumber(): on a
    // load-balanced RPC that call can be served by a more-current node than the
    // toBlock:"latest" queries, pushing the cursor PAST blocks those queries never
    // scanned and permanently skipping their events. When a sync returns no logs the
    // cursor holds and the next sync re-scans [from, latest] — cheap, and never misses.
    let cursor = this.syncedToBlock ?? (from > 0n ? from - 1n : 0n);
    for (const l of [...commitmentLogs, ...nullifierLogs, ...swapLogs, ...depositLogs]) {
      const b = (l as any).blockNumber as bigint | null;
      if (b != null && b > cursor) cursor = b;
    }
    this.syncedToBlock = cursor;

    // Reorg guard: the locally-rebuilt root must be a root the pool has held. If a
    // reorg dropped/re-indexed a commitment we consumed, our tree has diverged —
    // reset the incremental cursor and rebuild from scratch (once). Confirm across a
    // few reads first: on a load-balanced RPC a single lagging node can transiently
    // report a legitimately-current root as unknown, and wiping on that would be a
    // needless full rescan.
    if (!isRescan && this.tree.size > 0) {
      const root = this.tree.root();
      let known = false;
      for (let i = 0; i < 3 && !known; i++) {
        known = (await this.client.readContract({
          address: this.pool,
          abi: SHERWOOD_ABI,
          functionName: "isKnownRoot",
          args: [root],
        })) as boolean;
      }
      if (!known) {
        this.tree = new MerkleTree();
        this.owned = [];
        this.spent = new Set();
        this.syncedToBlock = null;
        await this._sync(true);
      }
    }
  }

  /** Snapshot state for a persistent cache; restore with `load` to skip re-scanning. */
  snapshot(): ClientState {
    return {
      version: 3,
      pool: this.pool,
      syncedToBlock: (this.syncedToBlock ?? this.fromBlock - 1n).toString(),
      leaves: this.tree.leaves().map((l) => l.toString()),
      owned: this.owned.map((u) => ({ amount: u.note.amount.toString(), assetId: u.note.assetId.toString(), pubKey: u.note.pubKey.toString(), blinding: u.note.blinding.toString(), label: u.note.label.toString(), index: u.index })),
      spent: [...this.spent].map((n) => n.toString()),
      assoc: this.assoc.labels().map((l) => l.toString()),
    };
  }

  /** Restore from a `snapshot()`; subsequent `sync()` calls only fetch newer blocks. */
  load(s: ClientState): void {
    if (s.pool.toLowerCase() !== this.pool.toLowerCase()) throw new Error("cache is for a different pool");
    // Reject pre-v2 caches (no persisted association set) so the caller falls back to a
    // full scan that rebuilds it — otherwise spends fail with "not in the association set".
    // v2 caches (no per-note pubKey) are accepted and migrated in place: every pre-fix
    // note was owned by the master key, so defaulting pubKey to it is provably correct
    // and avoids a forced rescan.
    const version = (s as { version?: number }).version;
    if (version !== 2 && version !== 3) throw new Error("cache version too old — rescanning");
    this.tree = new MerkleTree();
    this.tree.insertMany(s.leaves.map((x) => BigInt(x)));
    for (const l of s.assoc ?? []) this.assoc.add(BigInt(l));
    this.owned = s.owned.map((o) => {
      const pubKey = o.pubKey !== undefined ? BigInt(o.pubKey) : this.keypair.pubKey;
      const blinding = BigInt(o.blinding);
      let privKey = this.keypair.spendKey;
      if (pubKey !== this.keypair.pubKey) {
        // stealth-owned swap claim note (M-1): re-derive its key and verify it
        // actually opens the stored pubKey — a corrupt cache must not silently
        // produce unspendable notes (caller falls back to a full rescan).
        const stealth = deriveSwapStealthKey(this.keypair.spendKey, blinding);
        if (stealth.pub !== pubKey) throw new Error("cache corrupt: cannot re-derive stealth key for a cached note — rescanning");
        privKey = stealth.priv;
      }
      const note = new Note({ amount: BigInt(o.amount), assetId: BigInt(o.assetId), pubKey, blinding, label: BigInt(o.label ?? "0") });
      return { note, index: o.index, privKey, nullifier: note.nullifierWithKey(privKey, o.index) };
    });
    this.spent = new Set(s.spent.map((x) => BigInt(x)));
    this.syncedToBlock = BigInt(s.syncedToBlock);
  }

  utxos(token?: string): Utxo[] {
    const id = token ? assetIdOf(token) : undefined;
    return this.owned.filter(
      (u) => !this.spent.has(u.nullifier) && !this.reserved.has(u.nullifier) && (id === undefined || u.note.assetId === id)
    );
  }

  /** Release notes reserved by a build that was never submitted (L-1), so they can
   *  be selected again. `invalidate()` also clears all reservations on chain-resync. */
  release(nullifiers: bigint[] = []): void {
    for (const n of nullifiers) this.reserved.delete(n);
  }

  balance(token: string): bigint {
    return this.utxos(token).reduce((a, u) => a + u.note.amount, 0n);
  }

  /** Viewing-key self-disclosure: every note this account has held, with spent
   *  status — decoded from chain events. Pair with `exportViewingKey()` so an
   *  auditor can independently reproduce it (read-only; spending needs the spend key). */
  history(): HistoryEntry[] {
    return this.owned
      .map((u) => ({ index: u.index, asset: getAddress("0x" + u.note.assetId.toString(16).padStart(40, "0")) as `0x${string}`, amount: u.note.amount, spent: this.spent.has(u.nullifier) }))
      .sort((a, b) => a.index - b.index);
  }

  /** The per-account viewing key (hex). Discloses history read-only; never the spend key. */
  exportViewingKey(): { viewKey: `0x${string}`; pubKey: string } {
    return { viewKey: ("0x" + Array.from(this.keypair.viewKey, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`, pubKey: "0x" + this.keypair.pubKey.toString(16) };
  }

  /** Pick up to 2 notes of `token` **sharing one label** that cover `need`. The
   *  circuit requires all real inputs to a join-split to share a label, so a spend
   *  cannot mix two differently-labelled notes (Privacy-Pools threat model). */
  private selectInputs(token: string, need: bigint): { inputs: Utxo[]; txLabel: bigint } {
    const all = this.utxos(token);
    if (all.length === 0) throw new Error(`no ${token} notes`);
    // group by label, then greedily cover within a group
    const byLabel = new Map<string, Utxo[]>();
    for (const u of all) {
      const k = u.note.label.toString();
      (byLabel.get(k) ?? byLabel.set(k, []).get(k)!).push(u);
    }
    for (const group of byLabel.values()) {
      const g = group.sort((a, b) => (b.note.amount > a.note.amount ? 1 : -1));
      if (g[0].note.amount >= need) return { inputs: [g[0]], txLabel: g[0].note.label };
      if (g.length >= 2 && g[0].note.amount + g[1].note.amount >= need) return { inputs: [g[0], g[1]], txLabel: g[0].note.label };
    }
    throw new Error(`no single label of ${token} covers ${need} in a 2-input tx (labels can't be merged); consolidate first`);
  }

  /** Largest amount of `token` spendable in ONE transfer — the biggest top-2 note sum
   *  within a single label. A send/withdraw larger than this must be split across several
   *  transactions (one per label). Returns 0n if there are no notes. */
  maxSpendable(token: string): bigint {
    const byLabel = new Map<string, Utxo[]>();
    for (const u of this.utxos(token)) {
      const k = u.note.label.toString();
      (byLabel.get(k) ?? byLabel.set(k, []).get(k)!).push(u);
    }
    let best = 0n;
    for (const group of byLabel.values()) {
      const g = group.sort((a, b) => (b.note.amount > a.note.amount ? 1 : -1));
      const sum = g[0].note.amount + (g[1]?.note.amount ?? 0n);
      if (sum > best) best = sum;
    }
    return best;
  }

  // ---- action builders ----

  private baseExtData(assetId: bigint): ExtData {
    return {
      recipient: ZERO_ADDR, extAmount: 0n, assetId, relayer: ZERO_ADDR, fee: 0n,
      tokenOut: ZERO_ADDR, minAmountOut: 0n, swapPubKey: 0n, swapBlinding: 0n, poolFee: 0,
      deadline: 0n, swapLabel: 0n, encryptedOutput1: EMPTY_BYTES, encryptedOutput2: EMPTY_BYTES, encryptedSwapNote: EMPTY_BYTES,
    };
  }

  /** Deposit `amount` of `token` into a fresh note with a NEW label (revealed for
   *  the ASP to screen). A deposit is pure (no inputs) and proves no membership. */
  async buildShield(token: string, amount: bigint): Promise<BuiltTx> {
    await this.ensureSynced();
    const assetId = assetIdOf(token);
    const assocRoot = await this.onchainAssociationRoot();
    // The deposit label MUST equal Poseidon(sender, nonce) — the pool derives and
    // enforces the same value on-chain, so a deposit can never reuse an already-approved
    // label to smuggle unscreened value into the set (C-1).
    if (!this.sender) throw new Error("SherwoodClient: `sender` is required to build a shield (deposit-label binding)");
    const nonce = (await this.client.readContract({ address: this.pool, abi: SHERWOOD_ABI, functionName: "depositNonce", args: [this.sender] })) as bigint;
    const label = poseidon([BigInt(this.sender), nonce]);
    const out = Note.own(this.keypair, amount, assetId, label);
    const zero = Note.zero(this.keypair.pubKey, assetId, label);
    const extData = this.baseExtData(assetId);
    extData.extAmount = amount;
    extData.encryptedOutput1 = out.encryptTo(this.keypair.viewPub);
    extData.encryptedOutput2 = zero.encryptTo(this.keypair.viewPub);
    return this.finish({
      inputs: [], outputs: [out, zero], publicAmountSigned: amount, publicAsset: assetId, extData,
      txLabel: label, associationRoot: assocRoot, depositLabel: label, assocPath: AssociationSet.dummyPath(),
    });
  }

  /** Private send of `amount` of `token` to `to`, with change back to self. The
   *  recipient inherits the notes' label (its compliance provenance travels too). */
  async buildTransfer(token: string, amount: bigint, to: PublicAddress, opts: { relayer?: `0x${string}`; fee?: bigint } = {}): Promise<BuiltTx> {
    await this.ensureSynced();
    const assetId = assetIdOf(token);
    const fee = opts.fee ?? 0n;
    const { inputs, txLabel } = this.selectInputs(token, amount + fee);
    const change = inputs.reduce((a, u) => a + u.note.amount, 0n) - amount - fee;
    const outTo = Note.to(to, amount, assetId, txLabel);
    const outChange = Note.own(this.keypair, change, assetId, txLabel);
    const extData = this.baseExtData(assetId);
    extData.relayer = opts.relayer ?? ZERO_ADDR;
    extData.fee = fee;
    extData.encryptedOutput1 = outTo.encryptTo(to.viewPub);
    extData.encryptedOutput2 = outChange.encryptTo(this.keypair.viewPub);
    return this.finishSpend(inputs, [outTo, outChange], 0n - fee, assetId, extData, txLabel);
  }

  /** Withdraw `amount` of `token` to a clear address. */
  async buildUnshield(token: string, amount: bigint, recipient: `0x${string}`, opts: { relayer?: `0x${string}`; fee?: bigint } = {}): Promise<BuiltTx> {
    await this.ensureSynced();
    const assetId = assetIdOf(token);
    const fee = opts.fee ?? 0n;
    const { inputs, txLabel } = this.selectInputs(token, amount + fee);
    const change = inputs.reduce((a, u) => a + u.note.amount, 0n) - amount - fee;
    const outChange = Note.own(this.keypair, change, assetId, txLabel);
    const zero = Note.zero(this.keypair.pubKey, assetId, txLabel);
    const extData = this.baseExtData(assetId);
    extData.recipient = recipient;
    extData.extAmount = -amount;
    extData.relayer = opts.relayer ?? ZERO_ADDR;
    extData.fee = fee;
    extData.encryptedOutput1 = outChange.encryptTo(this.keypair.viewPub);
    extData.encryptedOutput2 = zero.encryptTo(this.keypair.viewPub);
    return this.finishSpend(inputs, [outChange, zero], -amount - fee, assetId, extData, txLabel);
  }

  /** Swap `amountIn` of `token` through the public AMM into `tokenOut`. The
   *  proceeds re-shield with a FRESH label (they are new value from public
   *  liquidity → re-screened by the ASP before they can be spent).
   *
   *  M-1 fix: `extData.swapPubKey` is a per-swap STEALTH pubKey derived from
   *  (spendKey, swapBlinding) — never the master pubKey — so an observer cannot
   *  link an account's swaps to each other or to its other notes. The blinding
   *  already rides inside the ECIES `encryptedSwapNote`, so sync() re-derives
   *  the stealth key with zero extra on-chain data. */
  async buildSwap(token: string, amountIn: bigint, tokenOut: string, opts: { minAmountOut: bigint; poolFee: number; deadline: bigint; relayer?: `0x${string}`; fee?: bigint }): Promise<BuiltTx> {
    await this.ensureSynced();
    const assetId = assetIdOf(token);
    const fee = opts.fee ?? 0n;
    const { inputs, txLabel } = this.selectInputs(token, amountIn + fee);
    const change = inputs.reduce((a, u) => a + u.note.amount, 0n) - amountIn - fee;
    const outChange = Note.own(this.keypair, change, assetId, txLabel);
    const zero = Note.zero(this.keypair.pubKey, assetId, txLabel);

    // claim note (proceeds): amount AND label are unknown until settle — the pool
    // computes the actual amountOut and derives a UNIQUE on-chain label (C-1), both
    // recovered from the SwapExecuted / Deposit events during sync. Its owner is a
    // per-swap stealth key derived from the fresh blinding (M-1).
    const swapBlinding = Note.zero(this.keypair.pubKey).blinding;
    const stealth = deriveSwapStealthKey(this.keypair.spendKey, swapBlinding);
    const claimPlaceholder = new Note({ amount: 0n, assetId: assetIdOf(tokenOut), pubKey: stealth.pub, blinding: swapBlinding, label: 0n });

    const extData = this.baseExtData(assetId);
    extData.extAmount = -amountIn;
    extData.relayer = opts.relayer ?? ZERO_ADDR;
    extData.fee = fee;
    extData.tokenOut = getAddress(tokenOut) as `0x${string}`;
    extData.minAmountOut = opts.minAmountOut;
    extData.swapPubKey = stealth.pub;
    extData.swapBlinding = swapBlinding;
    extData.poolFee = opts.poolFee;
    extData.deadline = opts.deadline;
    extData.swapLabel = 0n; // ignored by the pool — the swap label is contract-derived (C-1)
    extData.encryptedOutput1 = outChange.encryptTo(this.keypair.viewPub);
    extData.encryptedOutput2 = zero.encryptTo(this.keypair.viewPub);
    extData.encryptedSwapNote = claimPlaceholder.encryptTo(this.keypair.viewPub);
    return this.finishSpend(inputs, [outChange, zero], -amountIn - fee, assetId, extData, txLabel);
  }

  // ---- internals ----

  /** A spend: proves the shared input label is in the association set. */
  private async finishSpend(inputs: Utxo[], outputs: Note[], publicAmountSigned: bigint, publicAsset: bigint, extData: ExtData, txLabel: bigint): Promise<BuiltTx> {
    // L-1: lock the selected notes NOW (synchronously, before the first await) so a
    // concurrent build can't pick them; free them if this build fails.
    const nfs = inputs.map((u) => u.nullifier);
    for (const n of nfs) this.reserved.add(n);
    try {
      if (!this.assoc.has(txLabel)) {
        throw new Error(`your note's label is not yet in the association set (awaiting ASP approval); cannot spend`);
      }
      const tx = await this.finish({
        inputs, outputs, publicAmountSigned, publicAsset, extData, txLabel,
        associationRoot: this.assoc.root(), depositLabel: 0n, assocPath: this.assoc.proof(txLabel),
      });
      tx.reservedNullifiers = nfs; // held until submit+resync (spent) or explicit release()
      return tx;
    } catch (e) {
      this.release(nfs);
      throw e;
    }
  }

  private async finish(o: {
    inputs: Utxo[]; outputs: Note[]; publicAmountSigned: bigint; publicAsset: bigint; extData: ExtData;
    txLabel: bigint; associationRoot: bigint; depositLabel: bigint; assocPath: import("./tree.js").MerklePath;
  }): Promise<BuiltTx> {
    const ownedInputs: OwnedInput[] = o.inputs.map((u) => ({ note: u.note, index: u.index, privKey: u.privKey }));
    const proof = await proveTransaction(
      {
        keypair: this.keypair,
        tree: this.tree,
        inputs: ownedInputs,
        outputs: o.outputs,
        publicAmount: mod(o.publicAmountSigned, FIELD_SIZE),
        publicAsset: o.publicAsset,
        extDataHash: extDataHash(o.extData),
        txLabel: o.txLabel,
        associationRoot: o.associationRoot,
        depositLabel: o.depositLabel,
        assocPath: o.assocPath,
      },
      this.artifacts,
      this.fullProve
    );
    return { proof, extData: o.extData };
  }

  private everSynced = false;
  private dirty = false;
  private async ensureSynced(): Promise<void> {
    if (!this.everSynced || this.dirty) {
      await this.sync(); // incremental: only fetches blocks newer than the last sync
      this.everSynced = true;
      this.dirty = false;
    }
  }

  /** Mark that new events may exist (call after a submitted tx confirms); the next
   *  build does an incremental sync, not a full rescan. */
  invalidate(): void {
    this.dirty = true;
    // reconciling with chain: submitted builds become `spent` on the next sync, and
    // any un-submitted reservation should be released so its notes are reusable (L-1).
    this.reserved.clear();
  }
}

export { encodeExtData };
