import type request from "supertest";
import { isErrorCode } from "../../src/errors/codes";

const STACK_TRACE_RE = /\n\s+at\s+\S+/;
const SECRET_LEAK_RE = /(postgresql?:\/\/|redis:\/\/|\bS[A-Z2-7]{55}\b|127\.0\.0\.1:\d{4,5})/i;

export interface ExpectedEnvelope {
  statuses: number[];
  codes?: string[];
  retryable?: boolean;
}

/**
 * Asserts the pass criteria required for every chaos scenario (#234):
 *  1. Status code is in the expected failure range (never a false 200).
 *  2. Body follows the shared `{ error: { code, message, ... } }` envelope.
 *  3. `error.code` is a registered member of `ERROR_CODES`.
 *  4. No stack traces, credentials, secret seeds, or internal socket addresses
 *     are leaked in the response payload.
 */
export function assertChaosErrorEnvelope(
  res: request.Response,
  expected: ExpectedEnvelope
): void {
  expect(expected.statuses).toContain(res.status);
  expect(res.body).toHaveProperty("error");
  expect(typeof res.body.error).toBe("object");
  expect(typeof res.body.error.code).toBe("string");
  expect(isErrorCode(res.body.error.code)).toBe(true);
  expect(typeof res.body.error.message).toBe("string");
  expect(res.body.error.message.length).toBeGreaterThan(0);

  if (expected.codes && expected.codes.length > 0) {
    expect(expected.codes).toContain(res.body.error.code);
  }
  if (expected.retryable !== undefined) {
    expect(res.body.error.retryable).toBe(expected.retryable);
  }

  const serialized = JSON.stringify(res.body);
  expect(serialized).not.toMatch(STACK_TRACE_RE);
  expect(serialized).not.toMatch(SECRET_LEAK_RE);
}
