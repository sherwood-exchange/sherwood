// Web Worker: runs the Groth16 witness+prove off the main thread so the UI stays
// responsive during the (multi-second) proof generation. snarkjs fetches the
// wasm/zkey by URL inside the worker.
import * as snarkjs from "snarkjs";

self.onmessage = async (e: MessageEvent) => {
  const { id, input, artifacts } = e.data;
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
    (self as any).postMessage({ id, proof, publicSignals });
  } catch (err: any) {
    (self as any).postMessage({ id, error: String(err?.message ?? err) });
  }
};
