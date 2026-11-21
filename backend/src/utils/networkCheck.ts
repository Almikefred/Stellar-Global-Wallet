import { config } from "../config";

export interface NetworkVerificationResult {
  horizonPassphrase: string;
  rpcPassphrase: string;
  expectedNetwork: string;
  verified: boolean;
}

/**
 * Known network passphrases used across Stellar ecosystems.
 */
export const KNOWN_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  standalone: "Standalone Network ; February 2017",
} as const;

/**
 * Startup check (#223): Queries Horizon and Soroban RPC endpoints to verify
 * that the live networks they report match the local configuration.
 *
 * Prevents catastrophic mix-ups where a mainnet config accidentally communicates
 * with testnet (or vice versa), or where envelopes are built with the wrong
 * network passphrase.
 */
export async function assertNetworkConfigurationMatches(timeoutMs = 10_000): Promise<NetworkVerificationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1. Verify Horizon network passphrase
    const horizonRes = await fetch(config.HORIZON_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "GlobeWallet-Backend/NetworkCheck" },
    });
    if (!horizonRes.ok) {
      throw new Error(`Failed to query Horizon at ${config.HORIZON_URL}: HTTP ${horizonRes.status}`);
    }
    const horizonData = (await horizonRes.json()) as { network_passphrase?: string };
    const horizonPassphrase = horizonData.network_passphrase;

    if (!horizonPassphrase) {
      throw new Error(`Horizon root endpoint at ${config.HORIZON_URL} did not report a network_passphrase.`);
    }

    if (horizonPassphrase !== config.NETWORK_PASSPHRASE) {
      throw new Error(
        `[Network Safety Mismatch] Configured NETWORK_PASSPHRASE does not match Horizon!\n` +
          `Configured: "${config.NETWORK_PASSPHRASE}"\n` +
          `Horizon (${config.HORIZON_URL}): "${horizonPassphrase}"`
      );
    }

    // 2. Verify Soroban RPC network passphrase
    const rpcRes = await fetch(config.SOROBAN_RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "GlobeWallet-Backend/NetworkCheck",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getNetwork" }),
      signal: controller.signal,
    });
    if (!rpcRes.ok) {
      throw new Error(`Failed to query Soroban RPC at ${config.SOROBAN_RPC_URL}: HTTP ${rpcRes.status}`);
    }
    const rpcData = (await rpcRes.json()) as {
      result?: { passphrase?: string };
      error?: { message?: string };
    };

    if (rpcData.error) {
      throw new Error(`Soroban RPC getNetwork returned error: ${rpcData.error.message}`);
    }

    const rpcPassphrase = rpcData.result?.passphrase;
    if (!rpcPassphrase) {
      throw new Error(`Soroban RPC endpoint at ${config.SOROBAN_RPC_URL} did not return a network passphrase.`);
    }

    if (rpcPassphrase !== config.SOROBAN_NETWORK_PASSPHRASE) {
      throw new Error(
        `[Network Safety Mismatch] Configured SOROBAN_NETWORK_PASSPHRASE does not match Soroban RPC!\n` +
          `Configured: "${config.SOROBAN_NETWORK_PASSPHRASE}"\n` +
          `Soroban RPC (${config.SOROBAN_RPC_URL}): "${rpcPassphrase}"`
      );
    }

    // 3. Consistency check between STELLAR_NETWORK enum and passphrases
    if (config.STELLAR_NETWORK === "mainnet") {
      if (config.NETWORK_PASSPHRASE === KNOWN_PASSPHRASES.testnet) {
        throw new Error(
          `[Network Safety Mismatch] STELLAR_NETWORK is "mainnet" but NETWORK_PASSPHRASE is the Testnet passphrase!`
        );
      }
    } else if (config.STELLAR_NETWORK === "testnet") {
      if (config.NETWORK_PASSPHRASE === KNOWN_PASSPHRASES.mainnet) {
        throw new Error(
          `[Network Safety Mismatch] STELLAR_NETWORK is "testnet" but NETWORK_PASSPHRASE is the Mainnet passphrase!`
        );
      }
    }

    return {
      horizonPassphrase,
      rpcPassphrase,
      expectedNetwork: config.STELLAR_NETWORK,
      verified: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
