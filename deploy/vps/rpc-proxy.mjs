// Tiny CORS-enabled JSON-RPC proxy. The VPS can reach the Robinhood RPC directly, so
// browsers on networks that DNS-hijack *.chain.robinhood.com can use this instead of a VPN:
//   browser ──▶ http://<VPS_IP>:8791 ──▶ https://rpc.mainnet.chain.robinhood.com
// Zero dependencies (Node 22 global fetch).
import http from "node:http";

const UPSTREAM = process.env.RPC_UPSTREAM || "https://rpc.mainnet.chain.robinhood.com";
const PORT = Number(process.env.PORT || 8791);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { ...CORS, "content-type": "application/json" });
    return res.end('{"ok":true}');
  }
  if (req.method !== "POST") { res.writeHead(405, CORS); return res.end(); }

  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
  req.on("end", async () => {
    try {
      const r = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const text = await r.text();
      res.writeHead(r.status, { ...CORS, "content-type": "application/json" });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { ...CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
});

server.listen(PORT, () => console.log(`🔁 RPC proxy on :${PORT} → ${UPSTREAM}`));
