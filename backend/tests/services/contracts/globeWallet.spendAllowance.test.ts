import { toSpendAllowance } from "../../../src/services/contracts/globeWallet";

describe("toSpendAllowance rolling window (#177, #179)", () => {
  it("maps next_refill_at to an ISO time", () => {
    const a = toSpendAllowance("XLM", {
      limit: 1000n,
      spent: 400n,
      remaining: 600n,
      window_start: 1_700_000_000n,
      window_resets_at: 1_700_090_000n,
      next_refill_at: 1_700_086_400n,
    });
    expect(a.nextRefillAt).toBe(new Date(1_700_086_400 * 1000).toISOString());
    expect(a.remaining).toBe("600");
  });

  it("returns null nextRefillAt when nothing is counted or the field is missing", () => {
    const base = { limit: 0n, spent: 0n, remaining: 0n, window_start: 0n, window_resets_at: 0n };
    expect(toSpendAllowance("XLM", { ...base, next_refill_at: 0n }).nextRefillAt).toBeNull();
    expect(toSpendAllowance("XLM", base).nextRefillAt).toBeNull();
  });

  it("reports spend for unlimited assets (#179)", () => {
    const a = toSpendAllowance("XLM", {
      limit: 0n,
      spent: 10_000n,
      remaining: 0n,
      window_start: 0n,
      window_resets_at: 0n,
      next_refill_at: 90_000n,
    });
    expect(a.unlimited).toBe(true);
    expect(a.spent).toBe("10000");
    expect(a.remaining).toBeNull();
  });
});
