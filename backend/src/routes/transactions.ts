import { Router } from "express";
import { param, query } from "express-validator";
import { assertValidRequest } from "../middleware/requestValidation";
import { StellarService } from "../services/stellar";
import { isValidAccountId } from "../validation/historyQuery";
import { PgTransactionStore, TransactionSubmitter } from "../services/transactionStatus";
import { HorizonService } from "../services/horizonService";
import { AccountLock, InProcessAccountLock } from "../services/locks/accountLock";
import { BuiltTransactionRegistry } from "../services/builtTransactions";
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
  txSubmitter?: TransactionSubmitter
): Router {
  const router = Router();

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
          // Use existing service for backward compatibility
          const detail = await stellar.getTransactionDetail(
            req.params.hash.toLowerCase(),
            req.query.account as string | undefined
          );
          res.json(detail);
        } else if (txStore) {
          // Use transaction status store for newer deployments
          const hash = req.params.hash.toLowerCase();
          const record = await txStore.get(hash);
          
          if (!record) {
            return res.status(404).json({ error: "Transaction not found" });
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
          res.status(500).json({ error: "Service not configured" });
        }
      } catch (err) {
        next(err);
      }
    }
  );

  // New transaction status endpoint (for async submission)
  router.get(
    "/status/:hash",
    param("hash")
      .matches(/^[0-9a-fA-F]{64}$/)
      .withMessage("hash must be a 64-character hex transaction hash"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        
        if (!txStore) {
          return res.status(500).json({ error: "Transaction status tracking not configured" });
        }

        const hash = req.params.hash.toLowerCase();
        const record = await txStore.get(hash);
        
        if (!record) {
          return res.status(404).json({ error: "Transaction not found" });
        }

        res.json(record);
      } catch (err) {
        next(err);
      }
    }
  );

  // Transaction history for an account
  router.get(
    "/account/:accountId/statuses",
    param("accountId").custom(isValidAccountId).withMessage("account must be a valid G... address"),
    query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be between 1 and 100"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        
        if (!txStore) {
          return res.status(500).json({ error: "Transaction status tracking not configured" });
        }

        const accountId = req.params.accountId;
        const limit = parseInt(req.query.limit as string) || 20;
        
        const records = await txStore.listForAccount(accountId, limit);
        res.json({ transactions: records });
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
