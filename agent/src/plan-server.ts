// plan-server — tiny HTTP surface for WOODIE, Sherwood's on-chain copilot, so the web page can
// call it with the LLM key kept server-side. Node http only, no express.
// (Filename kept as plan-server.ts because the VPS Docker CMD runs `src/plan-server.ts`.)
//
//   POST /chat      {message[, shielded]}  -> Reply { say, action? }
//   GET  /universe                         -> getUniverse() (live liquidity tiers)
//   GET  /health                           -> {ok:true}
//
//   npm run woodie:serve               # listens on PLAN_PORT (default 8795)
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getUniverse } from "./planner.js";
import { chat } from "./woodie.js";

const PORT = Number(process.env.PLAN_PORT) || 8795;
const ALLOW_ORIGIN = "https://sherwood.spot";

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = String(req.headers.origin ?? "");
  res.setHeader("access-control-allow-origin", origin === ALLOW_ORIGIN ? ALLOW_ORIGIN : "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}
function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let s = ""; req.on("data", (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (req.method === "GET" && url === "/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && url === "/universe") return send(res, 200, await getUniverse());
    if (req.method === "POST" && url === "/chat") {
      const b = await readBody(req);
      const message = String(b.message ?? "").trim();
      if (!message) return send(res, 400, { error: "message is required" });
      const shielded = Array.isArray(b.shielded) ? b.shielded.map(String) : undefined;
      return send(res, 200, await chat(message, shielded ? { shielded } : undefined));
    }
    return send(res, 404, { error: "not found", routes: ["GET /health", "GET /universe", "POST /chat"] });
  } catch (e: any) {
    return send(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(PORT, () => console.log(`🌲 WOODIE — Sherwood copilot on http://localhost:${PORT}  (POST /chat · GET /universe · GET /health)`));
