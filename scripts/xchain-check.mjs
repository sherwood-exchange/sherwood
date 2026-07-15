// One-shot capability check for the cross-chain ramp providers. Run once the keys are in env:
//   HOUDINI_API_KEY=... HOUDINI_API_SECRET=... ANYSWAP_API_KEY=... node scripts/xchain-check.mjs
// Answers the roadmap's open questions: which networks Houdini supports (is Robinhood Chain
// listed? which chains can serve as the Relay bridge leg?), whether BTC/XMR/SOL are quotable,
// and whether the AnySwap key works / which networks its rate endpoint accepts.
const HOUDINI = "https://api-partner.houdiniswap.com/v2";
const ANYSWAP = process.env.ANYSWAP_BASE_URL ?? "https://anyswap-api-docs-593632042838.europe-west4.run.app";

const hAuth = process.env.HOUDINI_API_KEY && process.env.HOUDINI_API_SECRET
  ? `${process.env.HOUDINI_API_KEY}:${process.env.HOUDINI_API_SECRET}` : null;
const aKey = process.env.ANYSWAP_API_KEY ?? null;

const hHeaders = {
  authorization: hAuth ?? "",
  "x-user-ip": "203.0.113.7", "x-user-agent": "SherwoodCheck/1.0", "x-user-timezone": "Asia/Jakarta",
};
const get = async (url, headers) => {
  const r = await fetch(url, { headers });
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, j };
};

if (hAuth) {
  console.log("== Houdini /me ==");
  console.log(JSON.stringify((await get(`${HOUDINI}/me`, hHeaders)).j)?.slice(0, 300));

  console.log("\n== Houdini /chains ==");
  const { status, j } = await get(`${HOUDINI}/chains`, hHeaders);
  const chains = j?.chains ?? j ?? [];
  console.log("status", status, "count", chains.length ?? "?");
  for (const c of chains) console.log(` - ${c.shortName ?? c.name} kind=${c.kind} chainId=${c.chainId ?? "-"} enabled=${c.enabled}`);
  const rh = chains.find?.((c) => c.chainId === 4663 || /robinhood/i.test(c.name ?? ""));
  console.log("Robinhood Chain listed?", rh ? JSON.stringify(rh) : "NO — two-leg design confirmed (last hop = Relay)");

  console.log("\n== Houdini token spot-checks (hasCex) ==");
  for (const s of ["BTC", "XMR", "SOL", "ETH", "USDC"]) {
    const { j } = await get(`${HOUDINI}/tokens?search=${s}&hasCex=true&limit=5`, hHeaders);
    const items = j?.tokens ?? j?.items ?? j ?? [];
    console.log(` ${s}:`, (Array.isArray(items) ? items : []).slice(0, 5).map((t) => `${t.symbol}@${t.chain} id=${t.id} priv=${t.hasSelfPrivate ?? "?"}`).join(" | ") || JSON.stringify(j)?.slice(0, 120));
  }
} else console.log("HOUDINI_API_KEY/SECRET not set — skipping Houdini");

if (aKey) {
  console.log("\n== AnySwap rate probes ==");
  for (const [send, sN, recv, rN] of [
    ["BTC", "BTC", "ETH", "ARBITRUM"], ["USDT", "TRC20", "USDC", "BASE"], ["ETH", "ETH", "ETH", "BASE"],
    ["ETH", "ROBINHOOD", "ETH", "BASE"], // does it know RH chain at all?
  ]) {
    const u = `${ANYSWAP}/api/v1/anyswap/rate?send=${send}&receive=${recv}&amount=1&sendNetwork=${sN}&receiveNetwork=${rN}`;
    const { status, j } = await get(u, { "x-api-key": aKey });
    console.log(` ${send}(${sN}) -> ${recv}(${rN}): ${status} ${JSON.stringify(j)?.slice(0, 160)}`);
  }
} else console.log("ANYSWAP_API_KEY not set — skipping AnySwap");
