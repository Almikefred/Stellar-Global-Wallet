/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests", "<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  // tests/e2e/* hit real testnet or local quickstart (see jest.e2e*.config.js),
  // and toxiproxyChaos.test.ts requires a live Toxiproxy compose stack (see
  // jest.chaos.config.js). Excluded here so `npm test` stays fast and hermetic;
  // tests/chaos/chaosResilience.test.ts and tests/integration/localE2eFlow.test.ts
  // DO run as part of `npm test`.
  testPathIgnorePatterns: [
    "/node_modules/",
    "<rootDir>/tests/e2e/",
    "<rootDir>/tests/chaos/toxiproxyChaos.test.ts",
  ],
  setupFiles: ["<rootDir>/tests/env.setup.ts", "<rootDir>/src/test-utils/setup.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { diagnostics: false }],
    // @stellar/stellar-sdk@16's @noble/* dependencies ship ESM only (no
    // CommonJS build) — transform just those through Babel so Jest's CJS
    // runtime can load them; everything else in node_modules stays
    // untouched (and fast) via transformIgnorePatterns below.
    "^.+\\.jsx?$": "babel-jest",
  },
  // @stellar/stellar-sdk@16 pulls in a growing tree of ESM-only transitive
  // deps (@noble/hashes, @noble/ed25519, uint8array-extras, ...) with no
  // CommonJS build, so naming them individually is a losing game — just
  // transform all of node_modules through Babel instead of the default
  // "ignore everything under node_modules".
  transformIgnorePatterns: [],
};
