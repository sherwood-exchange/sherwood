// 0x (Matcha) Swap API proxy — best-execution swaps on the big EVM chains (notably Base, the
// Sherwood gateway). The API key is backend-only, so this fronts api.0x.org behind /0x/*:
//
//   GET /0x/providers                                   -> { zeroex: bool }
//   GET /0x/price?chainId=&sellToken=&buyToken=&sellAmount=[&taker=]   (indicative, cached 10s)
//   GET /0x/quote?chainId=&sellToken=&buyToken=&sellAmount=&taker=     (firm, tx data, no cache)
//
// Uses the v2 allowance-holder flavor: one plain ERC-20 approval + one swap tx, no EIP-712
// signing — matches what the web wallet flow can execute everywhere.
// No key configured → 503 with a clear reason so the UI hides the routes.
import { IncomingMessage, ServerResponse } from "node:http";

const ZEROEX = "https://api.0x.org";
const key = () => process.env.ZEROEX_API_KEY ?? null;

export const zeroexEnabled = () => key() !== null;

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

const PRICE_TTL = 10_000;
const priceCache = new Map<string, { at: number; status: number; body: string }>();

async function proxy(res: ServerResponse, path: string, qs: URLSearchParams, cacheable: boolean) {
  const url = `${ZEROEX}${path}?${qs}`;
  if (cacheable) {
    const hit = priceCache.get(url);
    if (hit && Date.now() - hit.at < PRICE_TTL) {
      res.writeHead(hit.status, { "content-type": "application/json", "access-control-allow-origin": "*", "x-cache": "hit" });
      return res.end(hit.body);
    }
  }
  const r = await fetch(url, { headers: { "0x-api-key": key()!, "0x-version": "v2" }, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  if (cacheable && r.status === 200) {
    priceCache.set(url, { at: Date.now(), status: r.status, body: text });
    if (priceCache.size > 500) { const k = priceCache.keys().next().value; if (k) priceCache.delete(k); }
  }
  res.writeHead(r.status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(text);
}

/** Route /0x/* requests. Returns true when handled. */
export async function handleZeroex(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const u = new URL(req.url ?? "/", "http://x");
  if (!u.pathname.startsWith("/0x/")) return false;
  if (req.method !== "GET") { json(res, 405, { error: "GET only" }); return true; }

  if (u.pathname === "/0x/providers") { json(res, 200, { zeroex: zeroexEnabled() }); return true; }
  if (!zeroexEnabled()) { json(res, 503, { error: "0x not configured", detail: "ZEROEX_API_KEY missing" }); return true; }

  const want = (name: string) => { const v = u.searchParams.get(name); if (!v) throw new Error(`missing ${name}`); return v; };
  try {
    if (u.pathname === "/0x/price" || u.pathname === "/0x/quote") {
      const firm = u.pathname === "/0x/quote";
      const qs = new URLSearchParams({
        chainId: want("chainId"),
        sellToken: want("sellToken"),
        buyToken: want("buyToken"),
        sellAmount: want("sellAmount"),
      });
      const taker = u.searchParams.get("taker");
      if (firm && !taker) throw new Error("missing taker");
      if (taker) qs.set("taker", taker);
      const slip = u.searchParams.get("slippageBps");
      if (slip) qs.set("slippageBps", slip);
      await proxy(res, firm ? "/swap/allowance-holder/quote" : "/swap/allowance-holder/price", qs, !firm);
      return true;
    }
    json(res, 404, { error: "not found" });
  } catch (e: any) {
    json(res, 400, { error: e?.message ?? String(e) });
  }
  return true;
}
