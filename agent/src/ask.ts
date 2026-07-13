// Standalone runner for economyOS — call any economy function directly, without the GAME cloud.
// Useful while GAME's reasoning backend is upgrading, or just to exercise the live data layer.
//
//   npm run ask                                  # list functions
//   npm run ask -- get_live_quote ETH USDG 1     # 1 ETH -> USDG
//   npm run ask -- get_bridge_quote 0.1 base     # bridge 0.1 ETH -> Base
//   npm run ask -- get_swood_utility
//   npm run ask -- get_fee_tier 0xYourWallet
//   npm run ask -- get_governance
//   npm run ask -- demo                          # run a representative sample of all functions
import { economyFunctions, callByName } from "./economyos.js";

// Positional args are mapped onto each function's declared arg names, in order.
const argNames: Record<string, string[]> = {
  get_live_quote: ["token_in", "token_out", "amount"],
  get_bridge_quote: ["amount", "chain"],
  get_staking_stats: ["address"],
  get_fee_tier: ["address"],
  get_token_universe: ["query"],
  get_portfolio: ["address"],
};

function usage() {
  console.log("economyOS — standalone function runner (no GAME cloud needed)\n");
  console.log("Usage: npm run ask -- <function> [args...]\n\nFunctions:");
  for (const f of economyFunctions) {
    const names = argNames[f.name] ?? f.args.map((a: any) => a.name);
    console.log(`  ${f.name}${names.length ? " " + names.map((n) => `<${n}>`).join(" ") : ""}`);
  }
  console.log("\nExamples:\n  npm run ask -- get_live_quote ETH USDG 1\n  npm run ask -- get_bridge_quote 0.1 base\n  npm run ask -- demo");
}

async function run(name: string, positionals: string[]) {
  const names = argNames[name] ?? [];
  const args: Record<string, string> = {};
  names.forEach((n, i) => { if (positionals[i] !== undefined) args[n] = positionals[i]; });
  const out = await callByName(name, args);
  console.log(`\n▸ ${name}${positionals.length ? " " + positionals.join(" ") : ""}\n${out}\n`);
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  usage();
} else if (cmd === "demo") {
  const demo: [string, string[]][] = [
    ["explain_sherwood", []],
    ["get_live_quote", ["ETH", "USDG", "1"]],
    ["get_live_quote", ["ETH", "AAPL", "1"]],
    ["get_live_quote", ["ETH", "SWOOD", "1"]],
    ["get_bridge_quote", ["0.1", "base"]],
    ["get_swood_utility", []],
    ["get_governance", []],
    ["get_token_universe", ["stock"]],
    ["get_bridge_info", []],
  ];
  for (const [n, a] of demo) { try { await run(n, a); } catch (e: any) { console.error(`  ✗ ${n}: ${e.message}\n`); } }
} else {
  try { await run(cmd, rest); }
  catch (e: any) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
}
