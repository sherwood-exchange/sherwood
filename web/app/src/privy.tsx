// Privy — email/social login that provisions an embedded EVM wallet ("your WOODIE wallet").
// Sherwood's shielded account is still derived from a signature (wallet.ts), so an embedded
// Privy wallet works exactly like an external one: sign once → shielded keypair. Reown stays
// available for power users who bring their own wallet (see wallet-connect.ts).
import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { robinhoodChain } from "@sherwood/client";
import { base, mainnet, arbitrum, optimism, polygon } from "viem/chains";

const APP_ID = ((import.meta as any).env?.VITE_PRIVY_APP_ID as string | undefined) || "cmroamrqk017h0cjtdv34q5z3";
// The RH RPC is DNS-blocked on some browsers — the embedded wallet must broadcast through the proxy.
const RH_RPC = ((import.meta as any).env?.VITE_RPC_URL as string | undefined) || "https://sherwood.spot/rpc";
const rhChain = { ...robinhoodChain, rpcUrls: { default: { http: [RH_RPC] } } };

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        // Front door: email + external wallets in one modal. Embedded wallet auto-created for
        // anyone who logs in without one — that's the "WOODIE wallet". (Add "google"/"twitter"
        // once OAuth is configured in the Privy dashboard.)
        loginMethods: ["email", "wallet"],
        // showWalletUIs:false — our own confirmations (slide-to-confirm, confirm cards) are the
        // consent step; Privy's per-tx modal on top of them is a double-confirm. External wallets
        // (Reown/MetaMask) still show their native prompt regardless.
        embeddedWallets: { createOnLogin: "users-without-wallets", showWalletUIs: false },
        defaultChain: rhChain as any,
        supportedChains: [rhChain as any, base, mainnet, arbitrum, optimism, polygon],
        appearance: {
          theme: "dark",
          accentColor: "#c6f432",
          logo: "https://sherwood.spot/woodie-icon-192.png",
          landingHeader: "Sign in to Sherwood",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
