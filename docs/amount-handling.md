# Amount Handling: Stroop-Precise Arithmetic Everywhere

## Why IEEE-754 Floats Are Prohibited

Stellar amounts are fixed-point numbers with 7 decimal digits of precision ($1 \text{ stroop} = 0.0000001 \text{ XLM}$). JavaScript `Number` uses IEEE-754 double-precision floating-point numbers, which cannot represent all 7-decimal fractions exactly (e.g. $0.1 + 0.2 \ne 0.3$).

Floating point rounding drift can:
1. Inadvertently drop or create dust payments.
2. Cause fee calculations or balance reservations to fail off-by-one checks.
3. Lose precision for large balances above $2^{53}$ stroops (~900 million XLM).

## Shared SDK & Backend Primitives

All amount arithmetic must use `BigInt` stroops via `@globe-wallet/sdk` or `backend/src/utils/stroops.ts`:

- `toStroops(amount: string): bigint`: Parses decimal string to BigInt stroops.
- `fromStroops(stroops: bigint): string`: Converts BigInt stroops to formatted 7-decimal string.
- `compareAmounts(a: string, b: string): number`: Returns -1, 0, or 1.
- `addAmounts(a: string, b: string): string`: Adds amounts with exact stroop precision.
- `subtractAmounts(a: string, b: string): string`: Subtracts amounts without floating-point error.

## Linting & Best Practices

Codebases in this repository must not call `parseFloat()` or `Number()` on amount variables.
Unit and property tests in `backend/src/__tests__/amountHandling.test.ts` verify round-trip accuracy up to extreme bounds.
