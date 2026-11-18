import { test } from "node:test";
import assert from "node:assert/strict";
import { Asset } from "@stellar/stellar-sdk";

import { isTokenId, sacTokenId } from "../src/token/index.js";

const TESTNET = "Test SDF Network ; September 2015";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

test("sacTokenId matches the stellar-sdk SAC derivation", () => {
  assert.equal(sacTokenId("USDC", USDC_ISSUER, TESTNET), new Asset("USDC", USDC_ISSUER).contractId(TESTNET));
  assert.equal(sacTokenId("XLM", null, TESTNET), Asset.native().contractId(TESTNET));
});

test("different assets never share a token id (no code-based aliasing)", () => {
  assert.notEqual(sacTokenId("USDC", USDC_ISSUER, TESTNET), sacTokenId("XLM", null, TESTNET));
});

test("isTokenId accepts contract ids only", () => {
  assert.ok(isTokenId(sacTokenId("XLM", null, TESTNET)));
  assert.ok(!isTokenId(USDC_ISSUER));
  assert.ok(!isTokenId("XLM"));
});
