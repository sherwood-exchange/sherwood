// Bridges the SDK's FullProveFn to a Web Worker, so proof generation never
// blocks the UI thread.
import type { FullProveFn } from "@sherwood/client";

export function makeWorkerProver(): FullProveFn {
  const worker = new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module" });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  worker.onmessage = (e: MessageEvent) => {
    const { id, proof, publicSignals, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve({ proof, publicSignals });
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || "worker error"));
    pending.clear();
  };

  return (input, artifacts) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, input, artifacts });
    });
}
