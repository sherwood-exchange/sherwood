// Reown AppKit (WalletConnect) setup — multi-wallet connect (injected + QR + mobile).
// The connected EIP-1193 provider is consumed by viem in wallet.ts; we don't use ethers
// directly — the ethers adapter is only what bootstraps AppKit's EVM connection layer.
import { createAppKit } from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import type { AppKitNetwork } from "@reown/appkit/networks";
import { mainnet, base, arbitrum, optimism, polygon } from "@reown/appkit/networks";
import { robinhoodChain } from "@sherwood/client";

const projectId = "5d96d2d56137d716879b9154fd3252cf";

// Robinhood Chain is the home network, but the Private Bridge (Bridge in) needs the wallet
// to sit on a SOURCE chain (Base, Ethereum, …) to send the Relay deposit. Registering those
// chains here keeps AppKit from treating them as "unsupported" and blocking with a
// Switch-Network modal mid-bridge. Robinhood Chain stays the default.
const networks = [robinhoodChain, base, mainnet, arbitrum, optimism, polygon] as unknown as [
  AppKitNetwork,
  ...AppKitNetwork[],
];

export const appKit = createAppKit({
  adapters: [new EthersAdapter()],
  networks,
  defaultNetwork: robinhoodChain as unknown as AppKitNetwork,
  projectId,
  metadata: {
    name: "Sherwood",
    description: "Private DEX on Robinhood Chain — shield, swap, settle. Leave no trace.",
    url: "https://sherwood.spot",
    icons: ["https://sherwood.spot/icon-192.png"],
  },
  // Wallet-connect only — no email/social login, no built-in swap/onramp UI.
  features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
  themeMode: "dark",
  themeVariables: {
    "--w3m-accent": "#ccff00",
    "--w3m-color-mix": "#0a0e0c",
    "--w3m-color-mix-strength": 24,
    "--w3m-font-family": "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    "--w3m-border-radius-master": "2px",
  },
});
