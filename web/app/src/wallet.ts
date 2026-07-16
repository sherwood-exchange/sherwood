// Wallet connection + deterministic Sherwood account derivation.
import { createWalletClient, createPublicClient, custom, http, keccak256, hexToBytes, type Address } from "viem";
import { Keypair, chainById } from "@sherwood/client";
import { accountMessage, rpcTransport, type NetworkConfig } from "./config";

declare global {
  interface Window {
    ethereum?: any;
  }
}

export interface Connection {
  address: Address;
  walletClient: ReturnType<typeof createWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
  keypair: Keypair;
}

/** Build a Connection from an already-connected EIP-1193 provider (e.g. Reown AppKit's
 *  wallet provider). Switches the wallet to the target chain, then derives the shielded
 *  keypair from a signature — the seed never leaves the browser. */
export async function connectWithProvider(net: NetworkConfig, provider: any, address: Address): Promise<Connection> {
  const chain = chainById(net.chainId);
  const walletClient = createWalletClient({ account: address, chain, transport: custom(provider) });

  // ensure the wallet is on the right chain (best-effort)
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x" + net.chainId.toString(16) }],
    });
  } catch {
    /* user can switch manually */
  }

  const publicClient = createPublicClient({ chain, transport: rpcTransport(net) }) as ReturnType<typeof createPublicClient>;

  const signature = await walletClient.signMessage({ account: address, message: accountMessage(net) });
  const seed = hexToBytes(keccak256(signature));
  const keypair = Keypair.fromSeed(seed);

  return { address, walletClient, publicClient, keypair };
}

export async function connect(net: NetworkConfig): Promise<Connection> {
  if (!window.ethereum) throw new Error("No injected wallet found. Install Robinhood Wallet or MetaMask.");
  const chain = chainById(net.chainId);
  const walletClient = createWalletClient({ chain, transport: custom(window.ethereum) });
  const [address] = await walletClient.requestAddresses();

  // ensure the wallet is on the right chain (best-effort)
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x" + net.chainId.toString(16) }],
    });
  } catch {
    /* user can switch manually */
  }

  const publicClient = createPublicClient({ chain, transport: rpcTransport(net) }) as ReturnType<typeof createPublicClient>;

  // derive a stable seed from a signature — never leaves the browser
  const signature = await walletClient.signMessage({ account: address, message: accountMessage(net) });
  const seed = hexToBytes(keccak256(signature));
  const keypair = Keypair.fromSeed(seed);

  return { address, walletClient, publicClient, keypair };
}
