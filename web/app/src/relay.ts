// Relay.link client — cross-chain execution layer that Sherwood's Private Bridge piggybacks on.
// Sherwood adds the privacy: the funds are unshielded via the relayer (breaking the link to the
// shielded pool) BEFORE being bridged out through Relay. Relay itself is a public bridge.
// Docs: https://docs.relay.link — POST /quote returns a single deposit tx; status by requestId.

const RELAY_API = "https://api.relay.link";
const NATIVE = "0x0000000000000000000000000000000000000000";

export interface RelayChain {
  id: number;
  name: string;
  displayName: string;
  currencySymbol: string;
  currencyName: string;
  currencyDecimals: number;
  rpcUrl?: string;
  explorerUrl?: string;
  logo?: string;
  depositEnabled: boolean;
}

export interface RelayTx { to: `0x${string}`; value: bigint; data: `0x${string}`; chainId: number }
export interface RelayQuote {
  requestId: string;
  /** Ordered txs to execute (ERC20 origin = approve then deposit; native = one deposit). */
  txs: RelayTx[];
  outAmount: bigint;
  outDecimals: number;
  outSymbol: string;
  inAmount: bigint;
  feeUsd?: number;
  timeEstimateSec?: number;
}

/** Chains Relay can bridge to/from — used to populate the destination picker. */
export async function relayChains(): Promise<RelayChain[]> {
  const r = await fetch(`${RELAY_API}/chains`);
  const j = await r.json();
  const chains = (j.chains ?? j) as any[];
  return chains
    .filter((c) => c.vmType === "evm" && c.depositEnabled !== false)
    .map((c) => ({
      id: c.id,
      name: c.name,
      displayName: c.displayName ?? c.name,
      currencySymbol: c.currency?.symbol ?? "ETH",
      currencyName: c.currency?.name ?? c.currency?.symbol ?? "Ether",
      currencyDecimals: c.currency?.decimals ?? 18,
      rpcUrl: c.httpRpcUrl,
      explorerUrl: c.explorerUrl,
      logo: c.iconUrl ?? c.currency?.metadata?.logoURI,
      depositEnabled: c.depositEnabled !== false,
    }));
}

/** Get a bridge quote. `originCurrency`/`destinationCurrency` are token addresses (0x0 = native). */
export async function relayQuote(params: {
  user: `0x${string}`;
  recipient: `0x${string}`;
  originChainId: number;
  destinationChainId: number;
  amount: bigint;
  originCurrency?: string;
  destinationCurrency?: string;
}): Promise<RelayQuote> {
  const body = {
    user: params.user,
    recipient: params.recipient,
    originChainId: params.originChainId,
    destinationChainId: params.destinationChainId,
    originCurrency: params.originCurrency ?? NATIVE,
    destinationCurrency: params.destinationCurrency ?? NATIVE,
    amount: params.amount.toString(),
    tradeType: "EXACT_INPUT",
  };
  const r = await fetch(`${RELAY_API}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.message ?? j?.error ?? `Relay quote failed (${r.status})`);
  const txs: RelayTx[] = [];
  let requestId = j.requestId as string | undefined;
  for (const step of j.steps ?? []) {
    for (const item of step.items ?? []) {
      const d = item.data;
      if (d?.to) txs.push({ to: d.to, value: BigInt(d.value ?? "0"), data: (d.data ?? "0x") as `0x${string}`, chainId: d.chainId ?? params.originChainId });
      if (!requestId) requestId = step.requestId ?? item.check?.endpoint?.match(/requestId=([0-9a-fx]+)/i)?.[1];
    }
  }
  if (!txs.length) throw new Error("Relay returned no executable step (token may not be bridgeable)");
  const out = j.details?.currencyOut;
  return {
    requestId: requestId ?? "",
    txs,
    outAmount: BigInt(out?.amount ?? "0"),
    outDecimals: out?.currency?.decimals ?? 18,
    outSymbol: out?.currency?.symbol ?? "?",
    inAmount: params.amount,
    feeUsd: j.fees?.relayer?.amountUsd ? Number(j.fees.relayer.amountUsd) : undefined,
    timeEstimateSec: j.details?.timeEstimate,
  };
}

export type RelayStatus = "pending" | "success" | "failure" | "refund" | "unknown";

/** Poll bridge status by requestId. */
export async function relayStatus(requestId: string): Promise<{ status: RelayStatus; destTxHash?: string }> {
  try {
    const r = await fetch(`${RELAY_API}/intents/status?requestId=${requestId}`);
    const j = await r.json();
    const s = (j.status ?? "unknown") as string;
    const status: RelayStatus = s === "success" ? "success" : s === "failure" ? "failure" : s === "refund" ? "refund" : s === "pending" || s === "waiting" ? "pending" : "unknown";
    const destTxHash = j.destinationTx?.hash ?? j.txHashes?.[0] ?? undefined;
    return { status, destTxHash };
  } catch {
    return { status: "unknown" };
  }
}
