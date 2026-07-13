import { chainById } from "../../client/src/chains.js";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.POINTS_PORT ?? 8788),
  chainId: Number(process.env.CHAIN_ID ?? 46630),
  rpcUrl: process.env.RPC_URL, // read-only; no wallet needed
  pool: req("POOL_ADDRESS") as `0x${string}`,
  /** Replay Deposit events from here (the pool's first-event block). */
  fromBlock: BigInt(process.env.POINTS_FROM_BLOCK ?? "0"),
  dataFile: process.env.POINTS_DATA ?? "points-data/state.json",
  pollMs: Number(process.env.POINTS_POLL_MS ?? 15000),
  /** Points rules — all on-chain-derivable except referral (needs a signed opt-in). */
  rules: {
    shield: Number(process.env.PTS_SHIELD ?? 100), // per shield/deposit
    day: Number(process.env.PTS_DAY ?? 25), // per distinct active day
    weekStreakBonus: Number(process.env.PTS_WEEK_STREAK ?? 100), // 7+ day streak
    referrer: Number(process.env.PTS_REFERRER ?? 200), // per successful referral
    referee: Number(process.env.PTS_REFEREE ?? 50), // for being referred + shielding
  },
  get chain() {
    return chainById(this.chainId);
  },
};
