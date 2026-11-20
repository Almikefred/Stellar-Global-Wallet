import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import {
  ManifestVerificationError,
  canonicalJson,
  signManifest,
  verifySignedManifest,
} from "../src/security/index.js";

const releaseKey = Keypair.random();
const nextReleaseKey = Keypair.random();
const attackerKey = Keypair.random();

const manifest = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  contracts: {
    globeWallet: "CBGLPMNSM4FWMIZ6FFBSRN7FNVCHCI2SLZNODA27LEOXFPLWNYEAEP3K",
    tokenWrapper: "CTOKEN",
  },
};

test("canonicalJson ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: null } }), canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
});

test("a manifest signed by a pinned key verifies", () => {
  const signed = signManifest(manifest, releaseKey.secret());
  assert.deepEqual(verifySignedManifest(signed, [releaseKey.publicKey()]), manifest);
});

test("a tampered contract id is rejected", () => {
  const signed = signManifest(manifest, releaseKey.secret());
  const tampered = {
    ...signed,
    manifest: { ...manifest, contracts: { ...manifest.contracts, globeWallet: "CMALICIOUS" } },
  };
  assert.throws(() => verifySignedManifest(tampered, [releaseKey.publicKey()]), ManifestVerificationError);
});

test("a manifest signed by an unpinned key is rejected", () => {
  const signed = signManifest(manifest, attackerKey.secret());
  assert.throws(() => verifySignedManifest(signed, [releaseKey.publicKey()]), /untrusted key/);
});

test("claiming a pinned public key with someone else's signature is rejected", () => {
  const signed = { ...signManifest(manifest, attackerKey.secret()), publicKey: releaseKey.publicKey() };
  assert.throws(() => verifySignedManifest(signed, [releaseKey.publicKey()]), /signature is invalid/);
});

test("rotation: either pinned key is accepted", () => {
  const pinned = [releaseKey.publicKey(), nextReleaseKey.publicKey()];
  assert.ok(verifySignedManifest(signManifest(manifest, releaseKey.secret()), pinned));
  assert.ok(verifySignedManifest(signManifest(manifest, nextReleaseKey.secret()), pinned));
});

test("unsigned manifests and empty pin lists are rejected", () => {
  assert.throws(() => verifySignedManifest({ manifest } as never, [releaseKey.publicKey()]), /not signed/);
  const signed = signManifest(manifest, releaseKey.secret());
  assert.throws(() => verifySignedManifest(signed, []), /no trusted manifest keys/);
});
