import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const env = { ...process.env };
for (const f of [".env", ".env.local"]) { if (!existsSync(f)) continue; for (const l of readFileSync(f,"utf8").split(/\r?\n/)){const m=l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);if(m){const v=m[2].replace(/\s+#.*$/,"").trim();if(v)env[m[1]]=v;}} }
const rpc = env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const chainId = Number(env.CHAIN_ID || 4663);
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const chain = defineChain({ id: chainId, name: "Robinhood Chain", nativeCurrency: { name:"Ether", symbol:"ETH", decimals:18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const art = JSON.parse(readFileSync("out/SwoodStaking.sol/SwoodStaking.json","utf8"));
const SWOOD = getAddress("0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const OWNER = getAddress("0xABc3468B093A349Cfaa952c0a305CF6560E80D9d");
const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [SWOOD, USDG, OWNER] });
const r = await pub.waitForTransactionReceipt({ hash });
console.log("SwoodStaking:", r.contractAddress, "status", r.status);
const f = "deploy/mainnet.json"; const d = JSON.parse(readFileSync(f,"utf8")); d.swoodStaking = r.contractAddress; writeFileSync(f, JSON.stringify(d,null,2));
