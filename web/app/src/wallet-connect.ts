// One connection surface over Privy (primary) + Reown AppKit (kept for power users).
// Returns the same shape App.tsx already consumed from the Reown hooks, so the derive-shielded
// flow doesn't care where the wallet came from. Privy wins when authenticated; otherwise Reown.
import { useEffect, useState } from "react";
import { useAppKit, useAppKitAccount, useAppKitProvider, useDisconnect, type Provider } from "@reown/appkit/react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

export interface WalletConn {
  address?: string;
  isConnected: boolean;
  walletProvider: any;
  /** Privy readiness — the login button waits for it, then falls back to Reown if Privy is down. */
  ready: boolean;
  /** email/social/wallet via the Privy modal (embedded wallet auto-created for new users). */
  connect: () => void;
  disconnect: () => Promise<void>;
}

export function useWallet(): WalletConn {
  const { open } = useAppKit();
  const ak = useAppKitAccount();
  const { walletProvider: reownProvider } = useAppKitProvider<Provider>("eip155");
  const { disconnect: reownDisconnect } = useDisconnect();

  const privy = usePrivy();
  const { wallets } = useWallets();
  // Prefer the embedded WOODIE wallet; else the first wallet Privy connected (external via Privy).
  const active = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  const [pp, setPp] = useState<any>(null);
  useEffect(() => {
    let live = true;
    if (privy.authenticated && active) active.getEthereumProvider().then((p) => { if (live) setPp(p); }).catch(() => { if (live) setPp(null); });
    else setPp(null);
    return () => { live = false; };
  }, [privy.authenticated, active?.address]);

  const viaPrivy = privy.authenticated && !!active && !!pp;
  return {
    address: viaPrivy ? active!.address : ak.address,
    isConnected: viaPrivy || ak.isConnected,
    walletProvider: viaPrivy ? pp : reownProvider,
    ready: privy.ready,
    connect: () => { if (privy.ready) privy.login(); else open(); },
    disconnect: async () => {
      try { if (privy.authenticated) await privy.logout(); } catch { /* */ }
      try { reownDisconnect(); } catch { /* */ }
    },
  };
}
