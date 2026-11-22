import { Router } from "express";
import { body, header } from "express-validator";
import { AppError } from "../errors/appError";
import { jwtAuth } from "../middleware/jwtAuth";
import { assertSignedXdrAccountMatch, requireAccountMatch } from "../middleware/requireAccountMatch";
import { assertValidRequest, rejectUnknownBodyFields } from "../middleware/requestValidation";
import {
  cacheResult,
  claimIdempotencyKey,
  commitIdempotencyResult,
  getCachedResult,
  releaseIdempotencyKey,
  requestFingerprint,
} from "../services/idempotency";
import { StellarService } from "../services/stellar";
import { shutdownManager } from "../services/shutdown";
import { baseAccountId } from "../services/transactionEnvelope";
import { publicKeyMessage } from "../utils/stellarAddress";
import {
  assetParamMessage,
  destinationOrMuxedMessage,
  isValidAssetParam,
  isValidDestination,
} from "../validation/buildRequest";
import { isValidAccountId } from "../validation/historyQuery";
import { isValidSlippageBps, MAX_SLIPPAGE_BPS } from "../utils/slippage";
import { validatePathAssets } from "../validation/stellarAsset";
import { amountMessage, isValidMemoText, isValidStellarAmount, memoTextMessage } from "@globe-wallet/sdk";

/** A signed envelope is a few KB; this leaves room for multi-signature and fee-bump wrappers. */
const MAX_SIGNED_XDR_LENGTH = 64 * 1024;

/**
 * Non-custodial wallet endpoints (docs/client-signing.md): the server builds
 * an unsigned transaction, the client signs it with its own wallet, and the
 * server submits the signed envelope. None of these routes accepts a secret
 * key — `rejectUnknownBodyFields` turns one away with a 400.
 *
 * Kept in its own router, mounted by `createWalletRouter`, so these routes
 * can be exercised without the rest of the wallet router. Each route gates
 * itself with `jwtAuth` for the same reason.
 */
export function createClientSigningRouter(stellar: StellarService): Router {
  const router = Router();

  // #1 — unsigned payment XDR for the client to sign (Freighter, xBull, a
  // local key, ...).
  router.post(
    "/send/build",
    jwtAuth,
    requireAccountMatch(),
    rejectUnknownBodyFields(["sourcePublicKey", "destinationPublicKey", "amount", "asset", "memo"]),
    body("sourcePublicKey").custom(isValidAccountId).withMessage(publicKeyMessage),
    body("destinationPublicKey").custom(isValidDestination).withMessage(destinationOrMuxedMessage),
    body("amount").custom(isValidStellarAmount).withMessage(amountMessage),
    body("asset").optional().custom(isValidAssetParam).withMessage(assetParamMessage),
    body("memo").optional().isString().custom(isValidMemoText).withMessage(memoTextMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { sourcePublicKey, destinationPublicKey, amount, asset, memo } = req.body;
        res.json(await stellar.buildPayment({ sourcePublicKey, destinationPublicKey, amount, asset, memo }));
      } catch (err) {
        next(err);
      }
    }
  );

  // #3 — path payments (swaps / cross-asset sends). The client passes back
  // the route and quoted amount it picked from /paths/*; destMin / sendMax
  // are derived here from `slippageBps` (default 50, max 500).
  const pathPaymentFields = [
    "sourcePublicKey",
    "destinationPublicKey",
    "sendAsset",
    "destAsset",
    "path",
    "slippageBps",
    "memo",
  ];
  const pathPaymentValidation = [
    body("sourcePublicKey").custom(isValidAccountId).withMessage(publicKeyMessage),
    body("destinationPublicKey").custom(isValidDestination).withMessage(destinationOrMuxedMessage),
    body("sendAsset").optional().custom(isValidAssetParam).withMessage(assetParamMessage),
    body("destAsset").custom(isValidAssetParam).withMessage(assetParamMessage),
    // The thrown message ("Path must contain at most 5 assets", ...) becomes the validation message.
    body("path")
      .optional()
      .custom((path: unknown) => {
        validatePathAssets(path);
        return true;
      }),
    body("slippageBps")
      .optional()
      .custom(isValidSlippageBps)
      .withMessage(`slippageBps must be an integer between 0 and ${MAX_SLIPPAGE_BPS}`),
    body("memo").optional().isString().custom(isValidMemoText).withMessage(memoTextMessage),
  ];

  router.post(
    "/path-payment-strict-send/build",
    jwtAuth,
    requireAccountMatch(),
    rejectUnknownBodyFields([...pathPaymentFields, "sendAmount", "quotedDestAmount"]),
    ...pathPaymentValidation,
    body("sendAmount").custom(isValidStellarAmount).withMessage(amountMessage),
    body("quotedDestAmount").custom(isValidStellarAmount).withMessage(amountMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { sendAmount, quotedDestAmount, ...rest } = req.body;
        res.json(await stellar.buildPathPaymentStrictSend({ ...rest, sendAmount, quotedDestAmount }));
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    "/path-payment-strict-receive/build",
    jwtAuth,
    requireAccountMatch(),
    rejectUnknownBodyFields([...pathPaymentFields, "destAmount", "quotedSendAmount"]),
    ...pathPaymentValidation,
    body("destAmount").custom(isValidStellarAmount).withMessage(amountMessage),
    body("quotedSendAmount").custom(isValidStellarAmount).withMessage(amountMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { destAmount, quotedSendAmount, ...rest } = req.body;
        res.json(await stellar.buildPathPaymentStrictReceive({ ...rest, destAmount, quotedSendAmount }));
      } catch (err) {
        next(err);
      }
    }
  );

  // #2 — submit a client-signed envelope (plain or fee-bump). Repeating a
  // request with the same Idempotency-Key header or `idempotencyKey` field
  // replays the first result instead of submitting again.
  router.post(
    "/submit",
    jwtAuth,
    rejectUnknownBodyFields(["signedXdr", "idempotencyKey"]),
    body("signedXdr").isString().isLength({ min: 1, max: MAX_SIGNED_XDR_LENGTH }),
    body("idempotencyKey").optional().isString().isLength({ min: 1, max: 255 }),
    header("Idempotency-Key").optional().isString().isLength({ min: 1, max: 255 }),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { signedXdr } = req.body;
        const idempotencyKey: string | undefined = req.header("Idempotency-Key") ?? req.body.idempotencyKey;

        const parsed = stellar.parseSignedTransaction(signedXdr);
        const { sourcePublicKey } = parsed;
        const feeSource =
          "innerTransaction" in parsed.transaction
            ? baseAccountId(parsed.transaction.feeSource)
            : undefined;
        // #233 — enforce account scoping on the signed envelope's source (or fee source).
        assertSignedXdrAccountMatch(req.user?.sub, sourcePublicKey, feeSource);

        // #198 / #234 — use atomic claim/commit/release when available to eliminate
        // concurrent duplicate submissions under network latency or retries.
        const useAtomicClaim =
          typeof claimIdempotencyKey === "function" && typeof requestFingerprint === "function";
        const fingerprint =
          idempotencyKey && useAtomicClaim ? requestFingerprint({ signedXdr }) : undefined;

        if (idempotencyKey) {
          if (useAtomicClaim && fingerprint) {
            const claim = await claimIdempotencyKey(sourcePublicKey, idempotencyKey, fingerprint);
            if (claim.status === "hit") {
              res.json({ hash: claim.result.hash, successful: claim.result.successful });
              return;
            }
            if (claim.status === "conflict") {
              next(
                new AppError(
                  "This idempotency key was already used for a different request body. Use a new key.",
                  { code: "IDEMPOTENCY_KEY_REUSED", status: 422, retryable: false }
                )
              );
              return;
            }
            if (claim.status === "in-flight") {
              next(
                new AppError("This request is still being processed. Retry in a moment.", {
                  code: "IDEMPOTENCY_KEY_IN_FLIGHT",
                  status: 409,
                  retryable: true,
                })
              );
              return;
            }
          } else {
            const cached = await getCachedResult(sourcePublicKey, idempotencyKey);
            if (cached) {
              res.json({ hash: cached.hash, successful: cached.successful });
              return;
            }
          }
        }

        let result;
        try {
          result = await shutdownManager.trackSubmission(() =>
            stellar.submitSigned({ signedXdr })
          );
        } catch (execErr) {
          if (idempotencyKey && useAtomicClaim && typeof releaseIdempotencyKey === "function") {
            await releaseIdempotencyKey(sourcePublicKey, idempotencyKey).catch(() => undefined);
          }
          throw execErr;
        }

        if ("status" in result) {
          // Horizon timed out; the transaction may still land. Keep the in-flight
          // claim (do not release) so concurrent retries do not duplicate.
          res.status(202).json(result);
          return;
        }
        if (idempotencyKey) {
          if (useAtomicClaim && fingerprint && typeof commitIdempotencyResult === "function") {
            await commitIdempotencyResult(
              sourcePublicKey,
              idempotencyKey,
              fingerprint,
              result.hash,
              result.successful
            );
          } else {
            await cacheResult(sourcePublicKey, idempotencyKey, result.hash, result.successful);
          }
        }
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
