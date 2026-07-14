// woodie-cli — interactive WOODIE REPL. Type a plain-language message; WOODIE returns ONE
// structured action. On an executable action it prints the action JSON and (DRY-RUN) describes
// how the web app would execute it — the CLI never signs or broadcasts. No new deps (node readline).
//
//   npm run woodie                         # interactive REPL
//   npm run woodie -- "shield 0.01 ETH"    # one-shot
import "dotenv/config";
import { createInterface } from "node:readline";
import { chat, type Reply, type Action } from "./woodie.js";

function rl() { return createInterface({ input: process.stdin, output: process.stdout }); }
function ask(q: string): Promise<string> { const r = rl(); return new Promise((res) => r.question(q, (a) => { r.close(); res(a.trim()); })); }

const EXECUTABLE = new Set(["shield", "private_transfer", "unshield", "shielded_swap"]);

/** One-line, human description of how the web app would execute an action (dry-run). */
function describe(a: Action): string {
  switch (a.kind) {
    case "shield": return `→ web calls shieldToken(${a.symbol}, ${a.amount}) — deposit into the private pool.`;
    case "private_transfer": return `→ web calls sendMulti(${a.symbol}, ${a.amount}, to=${a.to.slice(0, 16)}…) — private transfer.`;
    case "unshield": return `→ web calls withdrawMulti(${a.symbol}, ${a.amount}, recipient=${a.to}) — unshield to a clear address.`;
    case "shielded_swap": return `→ web quotes minOut then swapMulti(${a.symbolIn} → ${a.symbolOut}, ${a.amount}) — shielded swap.`;
    case "quote": return `→ web calls quoteRoute(${a.symbolIn} → ${a.symbolOut}, ${a.amount}) and shows the number.`;
    case "portfolio": return "→ web renders your shielded + clear balances.";
    case "route": return `→ web deep-links the ${a.to} page${a.note ? ` (${a.note})` : ""}.`;
    default: return "";
  }
}

function print(r: Reply) {
  console.log(`\n  WOODIE: ${r.say}`);
  if (r.action) {
    console.log(`  action: ${JSON.stringify(r.action)}`);
    if (EXECUTABLE.has(r.action.kind)) console.log("  ⚠ executable — the web app shows a CONFIRM card before signing.");
    const d = describe(r.action);
    if (d) console.log(`  ${d}  (DRY-RUN — the CLI never signs.)`);
  }
  console.log();
}

async function main() {
  const oneShot = process.argv.slice(2).join(" ").trim();
  if (oneShot) { print(await chat(oneShot)); return; }
  if (!process.stdin.isTTY) return;

  console.log("\n🌲 WOODIE — Sherwood's on-chain copilot. Ask me to shield, send privately, unshield, or swap.");
  console.log("   e.g. \"shield 0.01 ETH\"  ·  \"privately swap 0.005 ETH into AAPL\"  ·  \"withdraw 50 USDG to 0x…\"");
  console.log("   (Ctrl-C to quit.)\n");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const msg = await ask("  you > ");
    if (!msg) continue;
    if (/^(quit|exit|:q)$/i.test(msg)) break;
    try { print(await chat(msg)); }
    catch (e: any) { console.log(`  (error: ${e?.message ?? e})\n`); }
  }
}

main().catch((e) => { console.error("woodie error:", e?.message ?? e); process.exit(1); });
