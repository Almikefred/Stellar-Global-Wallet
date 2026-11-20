import { config } from "../config";

/**
 * Builds a network-scoped Redis key to prevent cross-network key collisions
 * between testnet, mainnet, or local environments.
 *
 * Example:
 *   scopedKey("soroban-cache:C123:method") => "orbit-wal:testnet:soroban-cache:C123:method"
 */
export function scopedKey(key: string, network: string = config.STELLAR_NETWORK): string {
  // Strip any existing "orbit-wal:" prefix if present before tagging
  const cleanKey = key.startsWith("orbit-wal:") ? key.slice("orbit-wal:".length) : key;
  return `orbit-wal:${network}:${cleanKey}`;
}

/**
 * Returns the current active network identifier.
 */
export function currentNetwork(): string {
  return config.STELLAR_NETWORK;
}
