/**
 * Fee-sponsorship service (#195).
 *
 * New users can't transact without XLM for fees. This service lets a funded
 * sponsor account pay fees on behalf of users by wrapping their signed
 * transactions in a CAP-15 fee-bump envelope.
 *
 * Policy engine:
 *   - Each account has a per-day budget (stroops). Budget is reset every
 *     calendar day (UTC). The global default is FEE_SPONSOR_DAILY_STROOPS.
 *   - Operations that exceed the budget are rejected; the user must fund
 *     their own account.
 *   - Only accounts whose balance is below FEE_SPONSOR_MIN_XLM_BALANCE are
 *     eligible for sponsorship. Once a user has enough XLM they pay for
 *     themselves.
 *   - The number of operations in the inner transaction is bounded by
 *     FEE_SPONSOR_MAX_OPS to prevent abuse.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { pool } from "../db";
import { config } from "../config";
import { AccountMismatchError, AppError } from "../errors/appError";
import { baseAccountId } from "./transactionEnvelope";

// ---------------------------------------------------------------------------
// Policy constants (overridable via env — config.ts validates them).
// ---------------------------------------------------------------------------

/** Default per-account daily fee budget expressed in stroops (1 XLM = 10^7 stroops). */
const DEFAULT_DAILY_BUDGET_STROOPS = 100_000; // 0.01 XLM

/** An account with at least this many XLM is considered self-sufficient. */
const MIN_XLM_BALANCE_ELIGIBLE = 1.0; // XLM

/** Inner transactions with more operations than this are not sponsored. */
const MAX_OPS_PER_TX = 10;

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

export async function ensureFeeSponsorshipTable(db: typeof pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS fee_sponsorship_budgets (
      account VARCHAR(56) PRIMARY KEY,
      used_stroops BIGINT NOT NULL DEFAULT 0,
      window_date DATE NOT NULL DEFAULT CURRENT_DATE,
      -- Optional per-account override; NULL means use the global default.
      daily_budget_stroops BIGINT
    )
  `);
}

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

interface PolicyDecision {
  eligible: boolean;
  reason?: string;
  /** Effective budget for the account (stroops). */
  dailyBudget: number;
  /** Stroops already consumed today. */
  usedToday: number;
}

/**
 * Evaluate whether `account` is eligible for fee sponsorship.
 * This does NOT modify the budget; call `chargeBudget` after the fee-bump
 * transaction succeeds.
 */
export async function evaluatePolicy(
  account: string,
  feeStroops: number,
  innerTx: StellarSdk.Transaction
): Promise<PolicyDecision> {
  if (innerTx.operations.length > MAX_OPS_PER_TX) {
    return {
      eligible: false,
      reason: `Too many operations (${innerTx.operations.length} > ${MAX_OPS_PER_TX})`,
      dailyBudget: 0,
      usedToday: 0,
    };
  }

  // Look up (or create) the budget row for this account.
  const { rows } = await pool.query<{
    used_stroops: string;
    window_date: string;
    daily_budget_stroops: string | null;
  }>(
    `INSERT INTO fee_sponsorship_budgets (account)
     VALUES ($1)
     ON CONFLICT (account) DO UPDATE
       -- Reset the counter when the calendar day rolls over.
       SET used_stroops = CASE
             WHEN fee_sponsorship_budgets.window_date < CURRENT_DATE THEN 0
             ELSE fee_sponsorship_budgets.used_stroops
           END,
           window_date = CURRENT_DATE
     RETURNING used_stroops, window_date, daily_budget_stroops`,
    [account]
  );

  const row = rows[0];
  const dailyBudget =
    row.daily_budget_stroops !== null
      ? Number(row.daily_budget_stroops)
      : DEFAULT_DAILY_BUDGET_STROOPS;
  const usedToday = Number(row.used_stroops);

  if (usedToday + feeStroops > dailyBudget) {
    return {
      eligible: false,
      reason: `Daily fee budget exhausted (used ${usedToday} + ${feeStroops} > ${dailyBudget} stroops)`,
      dailyBudget,
      usedToday,
    };
  }

  return { eligible: true, dailyBudget, usedToday };
}

/**
 * Atomically debit `feeStroops` from the account's daily budget.
 * Call only after the sponsored fee-bump has been successfully submitted.
 */
export async function chargeBudget(account: string, feeStroops: number): Promise<void> {
  await pool.query(
    `UPDATE fee_sponsorship_budgets
     SET used_stroops = used_stroops + $2
     WHERE account = $1`,
    [account, feeStroops]
  );
}

// ---------------------------------------------------------------------------
// Public sponsorship entry-point
// ---------------------------------------------------------------------------

export interface SponsorResult {
  hash: string;
  successful: boolean;
}

/**
 * Wrap `transactionXdr` (a fully-signed inner transaction) in a fee-bump
 * envelope signed with the sponsor keypair, then submit it to Horizon.
 *
 * The sponsoring keypair is sourced from `FEE_SPONSOR_SECRET_KEY`. If the
 * env var is not set the endpoint returns 503 (sponsorship not configured).
 *
 * @param innerAccount  - Stellar G-address of the inner transaction's source.
 * @param transactionXdr - Base64 XDR of the signed inner transaction.
 * @param horizonUrl    - Horizon endpoint to submit to.
 * @param networkPassphrase
 */
export async function sponsorFeeBump(
  innerAccount: string,
  transactionXdr: string,
  horizonUrl: string,
  networkPassphrase: string
): Promise<SponsorResult> {
  const sponsorSecret = (config as unknown as Record<string, string>)["FEE_SPONSOR_SECRET_KEY"];
  if (!sponsorSecret) {
    throw new AppError("Fee sponsorship is not configured on this server", {
      code: "FEE_SPONSOR_NOT_CONFIGURED",
      status: 503,
    });
  }

  const sponsorKeypair = StellarSdk.Keypair.fromSecret(sponsorSecret);

  const innerTx = new StellarSdk.Transaction(transactionXdr, networkPassphrase);

  // #233 — Ensure the signed inner transaction actually belongs to `innerAccount`,
  // preventing an authenticated caller from passing their own `innerAccount` to
  // sponsor a transaction for a different account.
  const actualInnerSource = baseAccountId(innerTx.source);
  if (actualInnerSource !== innerAccount) {
    throw new AccountMismatchError(
      "Inner transaction source account does not match innerAccount",
      { requested: actualInnerSource, authenticated: innerAccount }
    );
  }

  // Check eligibility BEFORE submitting.
  const feeStroops = Number(StellarSdk.BASE_FEE) * Math.max(innerTx.operations.length, 1);
  const policy = await evaluatePolicy(innerAccount, feeStroops, innerTx);
  if (!policy.eligible) {
    throw new AppError(policy.reason ?? "Fee sponsorship denied by policy", {
      code: "FEE_SPONSOR_BUDGET_EXCEEDED",
      status: 402,
    });
  }

  // Check if the inner account is self-sufficient (has enough XLM).
  const server = new StellarSdk.Horizon.Server(horizonUrl, {
    allowHttp: horizonUrl.startsWith("http://"),
  });
  try {
    const account = await server.loadAccount(innerAccount);
    const native = account.balances.find((b) => b.asset_type === "native");
    const xlmBalance = parseFloat((native as { balance?: string })?.balance ?? "0");
    if (xlmBalance >= MIN_XLM_BALANCE_ELIGIBLE) {
      throw new AppError(
        `Account ${innerAccount} has ${xlmBalance} XLM and does not qualify for fee sponsorship`,
        { code: "FEE_SPONSOR_INELIGIBLE", status: 400 }
      );
    }
  } catch (err) {
    // 404 — account not yet funded; allow sponsorship so the first tx can land.
    if (!(err instanceof AppError) && (err as { response?: { status?: number } }).response?.status !== 404) {
      throw err;
    }
    if (err instanceof AppError) throw err;
  }

  // Build and sign the fee-bump envelope.
  const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    sponsorKeypair.publicKey(),
    String(feeStroops),
    innerTx,
    networkPassphrase
  );
  feeBumpTx.sign(sponsorKeypair);

  const response = await server.submitTransaction(feeBumpTx);

  // Debit the budget only after a confirmed submission.
  await chargeBudget(innerAccount, feeStroops);

  return {
    hash: response.hash,
    successful: response.successful,
  };
}
