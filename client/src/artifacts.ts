// Node-only: filesystem paths to the compiled circuit artifacts. Do NOT import
// this from browser code — use URLs there instead (see the web app).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Artifacts } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

/** client/src -> ../../circuits/build */
export const nodeArtifacts: Artifacts = {
  wasm: resolve(here, "../../circuits/build/transaction_js/transaction.wasm"),
  zkey: resolve(here, "../../circuits/build/transaction_final.zkey"),
};
