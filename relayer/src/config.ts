import { chainById } from "../../client/src/chains.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  chainId: Number(process.env.CHAIN_ID ?? 31337),
  rpcUrl: process.env.RPC_URL, // optional override; else chain default
  pool: required("POOL_ADDRESS") as `0x${string}`,
  relayerKey: required("RELAYER_PRIVATE_KEY") as `0x${string}`,
  /** Minimum fee (in the tx asset's smallest unit) the relayer will accept. */
  minFee: BigInt(process.env.MIN_FEE ?? "0"),
  /** Anti-abuse rate limits on /transact (the only gas-spending route). Public
   *  exposure without these lets anyone drain the relayer's gas. */
  ratePerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 10), // per client IP
  rateGlobalPerMin: Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN ?? 120), // all clients
  /** Behind a reverse proxy (Caddy) use X-Forwarded-For for the client IP. */
  trustProxy: (process.env.TRUST_PROXY ?? "1") !== "0",
  get chain() {
    return chainById(this.chainId);
  },
};
