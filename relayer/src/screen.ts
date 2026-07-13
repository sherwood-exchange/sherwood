// Compliance hook: sanctions screening on the PUBLIC legs only (never on the
// shielded internals — screening those would defeat the privacy design). This
// ships as a *pluggable stub*: an env denylist plus an explicit fail-closed
// switch. It has NO real intelligence. Before handling regulated value you MUST
// wire a real provider (Chainalysis / TRM — both Robinhood Chain ecosystem
// integrations) inside `screenAddress` and set PROVIDER_WIRED = true.

const DENY = new Set<string>(
  (process.env.SANCTIONS_DENYLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

// I-1: when no real provider is wired, be explicit about the no-op instead of
// silently "approving" everyone as if screening happened:
//   - default (testnet): PASS clear, non-denylisted addresses (an honest no-op).
//   - SANCTIONS_FAIL_CLOSED=1 (regulated value): REJECT until a provider is
//     integrated, so an operator can never run compliance-theatre on mainnet.
const FAIL_CLOSED = process.env.SANCTIONS_FAIL_CLOSED === "1";
const PROVIDER_WIRED = false; // flip to true only when a real provider is added below

export interface ScreenResult {
  ok: boolean;
  reason?: string;
}

/** Screen a clear address that value will touch (e.g. an unshield recipient). */
export async function screenAddress(address: string): Promise<ScreenResult> {
  if (!address || address === "0x0000000000000000000000000000000000000000") return { ok: true };
  if (DENY.has(address.toLowerCase())) return { ok: false, reason: `address ${address} is denylisted` };
  // TODO(mainnet): call the real provider here, e.g.
  //   const r = await provider.check(address); if (!r.clear) return { ok: false, reason: r.category };
  if (!PROVIDER_WIRED && FAIL_CLOSED) {
    return { ok: false, reason: "sanctions provider not configured (fail-closed)" };
  }
  return { ok: true };
}
