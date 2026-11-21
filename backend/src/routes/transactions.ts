import { Router } from "express";
import { param, query } from "express-validator";
import { assertValidRequest } from "../middleware/requestValidation";
import { jwtAuth } from "../middleware/jwtAuth";
import { requireAccountMatch } from "../middleware/requireAccountMatch";
import { AppError, NotFoundError } from "../errors/appError";
import { StellarService } from "../services/stellar";
import { isValidAccountId } from "../validation/historyQuery";
import { PgTransactionStore, TransactionSubmitter } from "../services/transactionStatus";
import { config } from "../config";
import * as StellarSdk from "@stellar/stellar-sdk";

/**
 * #60 — single transaction by hash, for the transaction detail screen and
 * shared links. Public, like the /account read routes: everything returned
 * is already public on-ledger data.
 */
export function createTransactionsRouter(
  stellar?: StellarService,
  txStore?: PgTransactionStore,
  _txSubmitter?: TransactionSubmitter
): Router {
  const router = Router();

  // Transaction status endpoint (for async submission) — registered before `/:hash`
  // so `/status/:hash` is matched explicitly rather than falling through.
  router.get(
    "/status/:hash",
    param("hash")
      .matches(/^[0-9a-fA-F]{64}$/)
      .withMessage("hash must be a 64-character hex transaction hash"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);

        if (!txStore) {
          throw new AppError("Transaction status tracking not configured", {
            code: "SERVICE_UNAVAILABLE",
            status: 503,
            retryable: false,
          });
        }

        const hash = req.params.hash.toLowerCase();
        const record = await txStore.get(hash);

        if (!record) {
          throw new NotFoundError("Transaction not found", "TRANSACTION_NOT_FOUND");
        }

        res.json(record);
      } catch (err) {
        next(err);
      }
    }
  );

  // Per-account submission status feed — authenticated & account-scoped (#233)
  // because pending/failed submission records are user-private operational state.
  router.get(
    "/account/:accountId/statuses",
    jwtAuth,
    requireAccountMatch((req) => req.params.accountId),
    param("accountId").custom(isValidAccountId).withMessage("account must be a valid G... address"),
    query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be between 1 and 100"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);

        if (!txStore) {
          throw new AppError("Transaction status tracking not configured", {
            code: "SERVICE_UNAVAILABLE",
            status: 503,
            retryable: false,
          });
        }

        const accountId = req.params.accountId;
        const limit = parseInt(req.query.limit as string, 10) || 20;

        const records = await txStore.listForAccount(accountId, limit);
        res.json({ transactions: records });
      } catch (err) {
        next(err);
      }
    }
  );

  // Existing transaction detail endpoint (public read)
  router.get(
    "/:hash",
    param("hash")
      .matches(/^[0-9a-fA-F]{64}$/)
      .withMessage("hash must be a 64-character hex transaction hash"),
    query("account")
      .optional()
      .custom(isValidAccountId)
      .withMessage("account must be a valid G... address"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);

        if (stellar) {
          const detail = await stellar.getTransactionDetail(
            req.params.hash.toLowerCase(),
            req.query.account as string | undefined
          );
          res.json(detail);
        } else if (txStore) {
          const hash = req.params.hash.toLowerCase();
          const record = await txStore.get(hash);

          if (!record) {
            throw new NotFoundError("Transaction not found", "TRANSACTION_NOT_FOUND");
          }

          res.json({
            hash: record.hash,
            ledger: record.ledger,
            createdAt: record.createdAt,
            successful: record.status === "success",
            sourceAccount: record.accountId,
            feeAccount: record.accountId,
            fee: record.fee ?? "0",
            maxFee: "0",
            memo: null,
            memoType: null,
            operationCount: record.operationCount ?? 0,
            perspective: record.accountId,
            operations: [],
            explorerUrl: null,
          });
        } else {
          throw new AppError("Service not configured", {
            code: "SERVICE_UNAVAILABLE",
            status: 503,
            retryable: false,
          });
        }
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

/**
 * Create a TransactionSubmitter instance for async submission.
 */
export function createTransactionSubmitter(): TransactionSubmitter {
  const server = new StellarSdk.Horizon.Server(config.HORIZON_URL);
  
  // In production, use Redis for pub/sub
  const publisher = new (class {
    async publish(_hash: string, _status: string, _details?: any) {}
  })();

  return new TransactionSubmitter({
    server,
    store: new PgTransactionStore(null as any), // Will be replaced in production
    publisher,
    pollingIntervalMs: 2000,
    pollingTimeoutMs: 60_000,
    maxRetries: 3,
  });
}
