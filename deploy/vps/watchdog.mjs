// Sherwood ops watchdog: keeps the relayer + ASP hot wallets funded and reports service
// health. Runs on an interval, tops up low wallets from a funder key, warns (logs +
// optional webhook) when a service is unhealthy or the funder itself is running low.
// Zero SDK deps — just viem. Config from env (see deploy/vps/.env).
import http from "node:http";
import { createPublicClient, createWalletClient, http as vhttp, defineChain, formatEther, parseEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const FUNDER_KEY = process.env.FUNDER_PRIVATE_KEY || "";
const INTERVAL = Number(process.env.WATCHDOG_INTERVAL_SECONDS || 120) * 1000;
const WEBHOOK = process.env.WATCHDOG_WEBHOOK_URL || "";

const MIN = parseEther(process.env.WATCHDOG_MIN_ETH || "0.0008"); // top up below this
const TOPUP = parseEther(process.env.WATCHDOG_TOPUP_ETH || "0.002"); // top up to add
const FUNDER_LOW = parseEther(process.env.WATCHDOG_FUNDER_LOW_ETH || "0.001"); // warn below this
const FUNDER_RESERVE = parseEther("0.0003"); // keep for the topup tx's own gas

// Wallets to keep funded (relayer + ASP), and internal health endpoints.
const RELAYER = getAddress(process.env.WATCH_RELAYER || "0x6289e26713ce598Bf9b58A99490e569Bee986765");
const ASP = getAddress(process.env.WATCH_ASP || "0xABc3468B093A349Cfaa952c0a305CF6560E80D9d");
const WATCHED = [["relayer", RELAYER], ["asp", ASP]];
const HEALTH = [
  ["relayer", "http://relayer:8787/health"],
  ["points", "http://points:8788/health"],
  ["rpc", "http://rpc:8791/health"],
  ["asp", "http://asp:8792/health"],
];

const chain = defineChain({ id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const transport = vhttp(RPC_URL);
const pc = createPublicClient({ chain, transport });
const haveKey = /^0x[0-9a-fA-F]{64}$/.test(FUNDER_KEY);
const funder = haveKey ? privateKeyToAccount(FUNDER_KEY) : null;
const wc = funder ? createWalletClient({ account: funder, chain, transport }) : null;

const ts = () => new Date().toISOString();
const state = { lastCheck: null, balances: {}, health: {}, alerts: [] };

function log(m) { console.log(`${ts()} ${m}`); }
async function warn(m) {
  console.error(`${ts()} WARN ${m}`);
  state.alerts = [`${ts()} ${m}`, ...state.alerts].slice(0, 20);
  if (WEBHOOK) { try { await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `Sherwood watchdog: ${m}` }) }); } catch { /* best effort */ } }
}

async function feeOverride() {
  const head = await pc.getBlock({ blockTag: "latest" });
  return head.baseFeePerGas != null ? { maxFeePerGas: head.baseFeePerGas * 2n, maxPriorityFeePerGas: 0n } : {};
}

async function tick() {
  try {
    const funderBal = funder ? await pc.getBalance({ address: funder.address }) : 0n;
    for (const [name, addr] of WATCHED) {
      const bal = await pc.getBalance({ address: addr });
      state.balances[name] = formatEther(bal);
      if (bal >= MIN) continue;
      if (!wc) { await warn(`${name} ${addr} low (${formatEther(bal)} ETH) but FUNDER_PRIVATE_KEY not set`); continue; }
      let amt = TOPUP;
      if (amt + FUNDER_RESERVE > funderBal) amt = funderBal > FUNDER_RESERVE ? funderBal - FUNDER_RESERVE : 0n;
      if (amt === 0n) { await warn(`${name} low but funder ${funder.address} has only ${formatEther(funderBal)} ETH — cannot top up`); continue; }
      const hash = await wc.sendTransaction({ to: addr, value: amt, ...(await feeOverride()) });
      await pc.waitForTransactionReceipt({ hash });
      log(`topped up ${name} ${addr}: +${formatEther(amt)} ETH (was ${formatEther(bal)})  tx ${hash}`);
    }
    if (funder) {
      state.balances.funder = formatEther(funderBal);
      if (funderBal < FUNDER_LOW) await warn(`funder ${funder.address} low: ${formatEther(funderBal)} ETH — refill it so top-ups keep working`);
    }
    for (const [name, url] of HEALTH) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); state.health[name] = r.ok ? "ok" : `http ${r.status}`; if (!r.ok) await warn(`service ${name} unhealthy: HTTP ${r.status}`); }
      catch (e) { state.health[name] = "unreachable"; await warn(`service ${name} unreachable: ${e?.message ?? e}`); }
    }
    state.lastCheck = ts();
  } catch (e) {
    console.error(`${ts()} tick error:`, e?.shortMessage ?? e?.message ?? e);
  }
}

http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }
  if (req.url === "/status") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(state, null, 2)); }
  res.writeHead(404); res.end();
}).listen(8793, () => log(`watchdog on :8793  interval ${INTERVAL / 1000}s  funder ${funder ? funder.address : "(none — monitor only)"}`));

for (;;) { await tick(); await new Promise((r) => setTimeout(r, INTERVAL)); }
