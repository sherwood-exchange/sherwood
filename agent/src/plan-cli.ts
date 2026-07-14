// plan-cli — conversational investing planner REPL. Turns "I want AI exposure, $100, play it safe"
// into a diversified basket of Sherwood's tokenized stocks, then offers to execute it (dry-run
// unless --send). No new deps — just node readline.
//
//   npm run plan                                   # interactive: asks goal / budget / risk
//   npm run plan -- "AI exposure" 100 balanced     # one-shot, prints the basket
//   npm run plan -- "chip makers" 250 bold --send  # one-shot, then broadcasts (needs EXEC_PRIVATE_KEY)
import "dotenv/config";
import { createInterface } from "node:readline";
import { buildPlan, executePlan, type Plan, type RiskTier } from "./planner.js";

const RISKS: RiskTier[] = ["cautious", "balanced", "bold"];
const argv = process.argv.slice(2);
const send = argv.includes("--send");
const pos = argv.filter((a) => !a.startsWith("--"));

function rl() { return createInterface({ input: process.stdin, output: process.stdout }); }
function ask(q: string): Promise<string> { const r = rl(); return new Promise((res) => r.question(q, (a) => { r.close(); res(a.trim()); })); }

function pad(s: string, n: number) { return (s + " ".repeat(n)).slice(0, n); }

function printPlan(p: Plan) {
  console.log(`\n  Goal: ${p.goal}   Budget: $${p.budgetUsd}   Risk: ${p.risk.label}`);
  console.log("  " + "─".repeat(78));
  console.log("  " + pad("SYMBOL", 8) + pad("CATEGORY", 11) + pad("%", 5) + pad("$", 9) + "RATIONALE");
  console.log("  " + "─".repeat(78));
  for (const h of p.holdings) {
    console.log("  " + pad(h.symbol, 8) + pad(h.category, 11) + pad(String(h.allocPct), 5) + pad("$" + h.usd, 9) + h.rationale);
  }
  console.log("  " + "─".repeat(78));
  console.log(`  Risk — ${p.risk.label}: ${p.risk.note}`);
  console.log(`  ${p.disclaimer}\n`);
}

async function main() {
  let goal = pos[0], budgetStr = pos[1], riskStr = pos[2];
  const interactive = !goal && process.stdin.isTTY;

  if (interactive) {
    console.log("\nSherwood investing planner — describe your goal in plain language.");
    goal = await ask("  What are you after? (e.g. 'AI exposure, keep it safe') > ");
    budgetStr = await ask("  Budget in USD? > ");
    riskStr = await ask("  Risk — cautious / balanced / bold? > ");
  }
  goal = goal || "broad market";
  const budgetUsd = Math.max(1, Math.round(Number(budgetStr) || 100));
  const riskTier = (RISKS.includes(String(riskStr).toLowerCase() as RiskTier) ? String(riskStr).toLowerCase() : "balanced") as RiskTier;

  console.log(`\n  …building a live basket for "${goal}" ($${budgetUsd}, ${riskTier})`);
  const plan = await buildPlan({ goal, budgetUsd, riskTier });
  printPlan(plan);

  // execute stage — interactive asks; one-shot runs a dry-run (or broadcasts with --send).
  let go = send || !interactive;
  if (interactive) {
    const a = (await ask(`  Execute this basket? ${send ? "(WILL BROADCAST)" : "(dry-run)"} [y/N] > `)).toLowerCase();
    go = a === "y" || a === "yes";
  }
  if (!go) { console.log("  Not executing. Re-run with --send to broadcast.\n"); return; }

  console.log(`\n  ${send ? "▶ EXECUTING (broadcasting)" : "◇ DRY-RUN"} — funding each leg ETH → token via the AggRouter…`);
  const results = await executePlan(plan, { privateKey: process.env.EXEC_PRIVATE_KEY, send });
  for (const r of results) {
    console.log(`   • ${pad(r.symbol, 7)} ${pad(r.status, 10)} ${r.amountOut ? "≈ " + r.amountOut : ""}${r.txHash ? "  tx " + r.txHash : ""}`);
  }
  if (!send) console.log("  (dry-run — nothing broadcast. Add --send with EXEC_PRIVATE_KEY set to execute.)");
  console.log();
}

main().catch((e) => { console.error("plan error:", e?.message ?? e); process.exit(1); });
