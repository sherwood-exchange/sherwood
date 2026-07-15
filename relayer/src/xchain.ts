// Cross-chain private on/off-ramp proxy — HoudiniSwap Partner API v2 + AnySwap Exchange API.
// The web app must never see the API keys (Houdini explicitly requires backend-only use), so
// this module fronts both providers behind a stable /xchain/* surface:
//
//   GET  /xchain/providers                      -> { houdini: bool, anyswap: bool }
//   GET  /xchain/chains                         -> Houdini networks (cached 10 min)
//   GET  /xchain/tokens?search=&hasCex=&chain=  -> Houdini token search (cached per query 10 min)
//   POST /xchain/quote   { provider, ... }      -> houdini: GET /v2/quotes    | anyswap: GET rate
//   POST /xchain/create  { provider, ... }      -> houdini: POST /v2/exchanges| anyswap: POST create
//   GET  /xchain/status?provider=&id=           -> houdini: GET /v2/orders/id | anyswap: GET status/id
//
// Compliance: Houdini mandates x-user-ip / x-user-agent / x-user-timezone on every call; we
// forward the real client values. AnySwap requires ipAddress in create bodies — injected here.
// No keys configured → 503 with a clear reason, so the UI can hide the feature.
import { IncomingMessage, ServerResponse } from "node:http";

const HOUDINI = "https://api-partner.houdiniswap.com/v2";
const ANYSWAP = process.env.ANYSWAP_BASE_URL ?? "https://anyswap-api-docs-593632042838.europe-west4.run.app";

const houdiniAuth = () => {
  const key = process.env.HOUDINI_API_KEY, secret = process.env.HOUDINI_API_SECRET;
  return key && secret ? `${key}:${secret}` : null;
};
const anyswapKey = () => process.env.ANYSWAP_API_KEY ?? null;

export const providers = () => ({ houdini: houdiniAuth() !== null, anyswap: anyswapKey() !== null });

// ---- helpers ----
function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
/** Houdini's mandatory compliance headers, forwarded from the real client. */
function complianceHeaders(req: IncomingMessage, clientIp: string): Record<string, string> {
  const ua = req.headers["user-agent"];
  const tz = req.headers["x-user-timezone"]; // the web app sends the browser TZ through
  return {
    "x-user-ip": clientIp,
    "x-user-agent": (Array.isArray(ua) ? ua[0] : ua) ?? "SherwoodRelayer/1.0",
    "x-user-timezone": (Array.isArray(tz) ? tz[0] : tz) ?? "UTC",
  };
}
async function upstream(res: ServerResponse, r: Response) {
  const text = await r.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  return json(res, r.status, body);
}
const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; body: string; status: number }>();
async function cachedGet(res: ServerResponse, url: string, headers: Record<string, string>) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) {
    res.writeHead(hit.status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    return res.end(hit.body);
  }
  const r = await fetch(url, { headers });
  const text = await r.text();
  if (r.ok) cache.set(url, { at: Date.now(), body: text, status: r.status });
  res.writeHead(r.status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(text);
}

/** Route an /xchain/* request. Returns true if handled. `clientIp` comes from the server's
 *  trust-proxy-aware resolver so Houdini sees the real user, not our VPS. */
export async function handleXchain(req: IncomingMessage, res: ServerResponse, clientIp: string): Promise<boolean> {
  const [path, qs = ""] = (req.url ?? "").split("?");
  if (!path.startsWith("/xchain/")) return false;
  const q = new URLSearchParams(qs);
  try {
    if (req.method === "GET" && path === "/xchain/providers") { json(res, 200, providers()); return true; }

    // ---- Houdini catalog (needs auth even to read) ----
    if (req.method === "GET" && (path === "/xchain/chains" || path === "/xchain/tokens")) {
      const auth = houdiniAuth();
      if (!auth) { json(res, 503, { error: "houdini not configured" }); return true; }
      const upstreamPath = path === "/xchain/chains" ? "/chains" : "/tokens";
      const pass = new URLSearchParams();
      for (const k of ["search", "hasCex", "hasDex", "chain", "limit", "offset"]) if (q.get(k) != null) pass.set(k, q.get(k)!);
      await cachedGet(res, `${HOUDINI}${upstreamPath}${pass.size ? `?${pass}` : ""}`,
        { authorization: auth, ...complianceHeaders(req, clientIp) });
      return true;
    }

    if (req.method === "POST" && path === "/xchain/quote") {
      const b = await readBody(req);
      if (b.provider === "anyswap") {
        const key = anyswapKey();
        if (!key) { json(res, 503, { error: "anyswap not configured" }); return true; }
        const pass = new URLSearchParams();
        for (const k of ["send", "receive", "amount", "sendNetwork", "receiveNetwork"]) if (b[k] != null) pass.set(k, String(b[k]));
        await upstream(res, await fetch(`${ANYSWAP}/api/v1/anyswap/rate?${pass}`, { headers: { "x-api-key": key } }));
        return true;
      }
      const auth = houdiniAuth();
      if (!auth) { json(res, 503, { error: "houdini not configured" }); return true; }
      const pass = new URLSearchParams();
      for (const k of ["amount", "from", "to", "fixed", "useXmr", "refundAddress", "amountType", "senderAddress", "receiverAddress", "slippage"]) {
        if (b[k] != null) pass.set(k, String(b[k]));
      }
      if (Array.isArray(b.types)) for (const t of b.types) pass.append("types", String(t));
      await upstream(res, await fetch(`${HOUDINI}/quotes?${pass}`, { headers: { authorization: auth, ...complianceHeaders(req, clientIp) } }));
      return true;
    }

    if (req.method === "POST" && path === "/xchain/create") {
      const b = await readBody(req);
      if (b.provider === "anyswap") {
        const key = anyswapKey();
        if (!key) { json(res, 503, { error: "anyswap not configured" }); return true; }
        const { provider: _p, ...body } = b;
        body.ipAddress = clientIp; // AnySwap compliance field — always the real client
        await upstream(res, await fetch(`${ANYSWAP}/api/v1/anyswap/create`, {
          method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body),
        }));
        return true;
      }
      const auth = houdiniAuth();
      if (!auth) { json(res, 503, { error: "houdini not configured" }); return true; }
      const body: Record<string, unknown> = {};
      for (const k of ["quoteId", "addressTo", "addressFrom", "refundAddress", "destinationTag", "walletInfo"]) if (b[k] != null) body[k] = b[k];
      if (!body.quoteId || !body.addressTo) { json(res, 400, { error: "quoteId and addressTo are required" }); return true; }
      await upstream(res, await fetch(`${HOUDINI}/exchanges`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth, ...complianceHeaders(req, clientIp) },
        body: JSON.stringify(body),
      }));
      return true;
    }

    if (req.method === "GET" && path === "/xchain/status") {
      const id = q.get("id") ?? "";
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { json(res, 400, { error: "bad id" }); return true; }
      if (q.get("provider") === "anyswap") {
        const key = anyswapKey();
        if (!key) { json(res, 503, { error: "anyswap not configured" }); return true; }
        await upstream(res, await fetch(`${ANYSWAP}/api/v1/anyswap/status/${id}`, { headers: { "x-api-key": key } }));
        return true;
      }
      const auth = houdiniAuth();
      if (!auth) { json(res, 503, { error: "houdini not configured" }); return true; }
      await upstream(res, await fetch(`${HOUDINI}/orders/${id}`, { headers: { authorization: auth, ...complianceHeaders(req, clientIp) } }));
      return true;
    }

    json(res, 404, { error: "unknown /xchain route" });
    return true;
  } catch (e: any) {
    json(res, 502, { error: "upstream failure", detail: String(e?.message ?? e).slice(0, 200) });
    return true;
  }
}
