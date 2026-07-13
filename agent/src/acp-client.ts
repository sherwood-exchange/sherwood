// economyOS ACP client helper — hire an ACP provider and drive the job to settlement, handling the
// socket SESSION automatically. ACP v2 requires an `acp events listen` session running from BEFORE
// create-job through settlement, or `fund`/`complete` fail with SESSION_NOT_FOUND. This script spawns
// that listener as a child, keeps it alive for the whole flow, then: create-job → fund on budget.set
// → (show deliverable) → complete on job.submitted. Escrow settles to the provider.
//
//   npm run acp:hire -- --requirements '{"action":"quote","token_in":"ETH","token_out":"USDG","amount":"1"}'
//   npm run acp:hire -- --provider 0x5e8f… --offering sherwood_economy --requirements '{…}' [--no-approve]
//
// Defaults target Sherwood Exchange's `sherwood_economy` offering on Base (8453). Needs the active
// agent to be a funded CLIENT with a signer (acp configure + acp agent add-signer + USDC on Base).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = ["-y", "@virtuals-protocol/acp-cli@1.0.24"];
const argv = process.argv.slice(2);
const opt = (name: string, def = "") => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const PROVIDER = opt("provider", "0x5e8f2599169a9f1d088165076aa323b6ce6623ce");
const OFFERING = opt("offering", "sherwood_economy");
const REQUIREMENTS = opt("requirements", '{"action":"explain"}');
const CHAIN = opt("chain-id", "8453");
const REASON = opt("reason", "Approved — deliverable verified");
const AUTO_APPROVE = !argv.includes("--no-approve");
const POLL_MS = Number(opt("poll", "6000"));
const MAX_WAIT_MS = Number(opt("timeout", "900000")); // 15 min

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run an acp-cli command with --json; return parsed JSON (last JSON line) or null. */
function acp(args: string[]): any {
  const r = spawnSync("npx", [...CLI, ...args, "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const out = (r.stdout || "") + "\n" + (r.stderr || "");
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{") || l.startsWith("["));
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* keep scanning */ } }
  return null;
}

function events(hist: any): any[] { return (hist?.entries ?? []).map((e: any) => e.event).filter(Boolean); }
const evt = (evs: any[], type: string) => evs.find((e) => e?.type === type);

async function main() {
  console.log(`[hire] provider ${PROVIDER} · offering ${OFFERING} · chain ${CHAIN}`);
  console.log(`[hire] requirements: ${REQUIREMENTS}`);

  // 1) start the socket-session listener BEFORE creating the job (kept alive for the whole flow).
  const evFile = join(mkdtempSync(join(tmpdir(), "acp-hire-")), "events.jsonl");
  const listener = spawn("npx", [...CLI, "events", "listen", "--output", evFile, "--json"], { stdio: "ignore" });
  const cleanup = () => { try { listener.kill("SIGTERM"); } catch { /* */ } };
  process.on("exit", cleanup); process.on("SIGINT", () => { cleanup(); process.exit(130); });
  console.log("[hire] listener starting… (session for fund/complete)");
  await sleep(9000);

  // 2) create the job.
  const created = acp(["client", "create-job", "--provider", PROVIDER, "--offering-name", OFFERING, "--requirements", REQUIREMENTS, "--chain-id", CHAIN]);
  const jobId = created?.jobId;
  if (!jobId) { console.error("[hire] create-job failed:", JSON.stringify(created)); cleanup(); process.exit(1); }
  console.log(`[hire] job ${jobId} created.`);

  // 3) drive: fund on budget.set → complete on job.submitted → done on completed.
  let fundIssued = false, completeIssued = false, deliverableShown = false;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    const hist = acp(["job", "history", "--job-id", String(jobId), "--chain-id", CHAIN]);
    const status = String(hist?.status ?? "").toLowerCase();
    const evs = events(hist);

    if (status === "completed") { console.log(`[hire] ✅ job ${jobId} COMPLETED — escrow released to provider.`); cleanup(); return; }
    if (status === "rejected") { console.log(`[hire] ✗ job ${jobId} rejected.`); cleanup(); process.exit(2); }
    if (status === "expired") { console.log(`[hire] ✗ job ${jobId} expired (escrow refunds to you).`); cleanup(); process.exit(3); }

    const submitted = evt(evs, "job.submitted");
    const budget = evt(evs, "budget.set");
    const funded = evt(evs, "job.funded");

    if (submitted) {
      if (!deliverableShown) {
        let dv: any = submitted.deliverable;
        if (typeof dv === "string") { try { dv = JSON.parse(dv); } catch { /* keep string */ } }
        console.log(`[hire] 📦 deliverable: ${typeof dv === "object" ? (dv.result ?? JSON.stringify(dv)) : dv}`);
        deliverableShown = true;
      }
      if (!AUTO_APPROVE) { console.log("[hire] --no-approve set: run `acp client complete --job-id " + jobId + " --chain-id " + CHAIN + "` to settle, or `acp client reject …`."); cleanup(); return; }
      if (!completeIssued) {
        const r = acp(["client", "complete", "--job-id", String(jobId), "--chain-id", CHAIN, "--reason", REASON]);
        if (r?.success) { completeIssued = true; console.log("[hire] complete submitted — confirming…"); }
        else console.error("[hire] complete failed, retrying:", JSON.stringify(r)?.slice(0, 160));
      }
    } else if (budget && !funded) {
      if (!fundIssued) {
        const amt = String(budget.amount ?? "");
        console.log(`[hire] 💰 budget.set ${amt} USDC → funding escrow…`);
        const r = acp(["client", "fund", "--job-id", String(jobId), ...(amt ? ["--amount", amt] : []), "--chain-id", CHAIN]);
        if (r?.success) { fundIssued = true; console.log("[hire] funded."); }
        else console.error("[hire] fund failed, retrying:", JSON.stringify(r)?.slice(0, 160));
      }
    } else {
      console.log(`[hire] job ${jobId} status=${status || "…"} (waiting)…`);
    }
    await sleep(POLL_MS);
  }
  console.error(`[hire] timed out after ${Math.round(MAX_WAIT_MS / 1000)}s — job ${jobId} not settled. Check \`acp job history --job-id ${jobId} --chain-id ${CHAIN}\`.`);
  cleanup(); process.exit(4);
}

main().catch((e) => { console.error("[hire] error:", e?.message ?? e); process.exit(1); });
