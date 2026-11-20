/**
 * Exact decimal <-> stroop conversion for Stellar amounts (#218).
 * Amounts travel as strings everywhere in this API and must NEVER be
 * converted to JS IEEE-754 numbers for calculation or comparison.
 * Precision loss above 2^53 stroops and floating-point drift (0.1 + 0.2)
 * can flip balance or fee checks.
 *
 * 1 XLM = 10,000,000 stroops (7 decimal places).
 */
export const STROOPS_PER_UNIT = 10_000_000n;

/**
 * Converts a Stellar decimal string amount to integer stroops (BigInt).
 * Throws if the input has more than 7 decimal places or invalid characters.
 */
export function toStroops(amount: string): bigint {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d{1,7})?$/.test(unsigned)) {
    throw new Error(`Invalid Stellar amount: "${amount}"`);
  }
  const [whole, fraction = ""] = unsigned.split(".");
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0"));
  return negative ? -stroops : stroops;
}

/**
 * Converts integer stroops (BigInt) to a canonical 7-decimal string.
 */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const fraction = (abs % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Compares two decimal amount strings using stroop arithmetic.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
export function compareStroops(a: string, b: string): number {
  const sa = toStroops(a);
  const sb = toStroops(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/**
 * Adds two decimal amount strings with exact stroop precision.
 */
export function addStroops(a: string, b: string): string {
  return fromStroops(toStroops(a) + toStroops(b));
}

/**
 * Subtracts b from a with exact stroop precision.
 */
export function subStroops(a: string, b: string): string {
  return fromStroops(toStroops(a) - toStroops(b));
}
