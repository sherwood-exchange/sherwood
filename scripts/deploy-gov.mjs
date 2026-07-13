import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const env = { ...process.env };
for (const f of [".env"]) { if (!existsSync(f)) continue; for (const l of readFileSync(f,"utf8").split(/\r?\n/)){const m=l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);if(m){const v=m[2].replace(/\s+#.*$/,"").trim();if(v)env[m[1]]=v;}} }
const rpc = env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const chain = defineChain({ id: Number(env.CHAIN_ID||4663), name:"RH", nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18}, rpcUrls:{default:{http:[rpc]}} });
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const art = JSON.parse(readFileSync("out/SwoodGovernor.sol/SwoodGovernor.json","utf8"));
const STAKING = "0x34677e5dd609d79ca2a413c51976154db7c1973f";
const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [STAKING, 259200n, parseEther("100000")] });
const r = await pub.waitForTransactionReceipt({ hash });
console.log("SwoodGovernor:", r.contractAddress, "status", r.status);
const f="deploy/mainnet.json"; const d=JSON.parse(readFileSync(f,"utf8")); d.swoodGovernor=r.contractAddress; writeFileSync(f, JSON.stringify(d,null,2));
