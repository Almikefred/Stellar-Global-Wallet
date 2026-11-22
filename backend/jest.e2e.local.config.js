/** @type {import('jest').Config} */
// Dedicated Jest config for the hermetic local stellar/quickstart E2E suite (#232).
// Kept separate from jest.config.js (unit tests) and jest.e2e.config.js (public testnet)
// so PR CI can run full contract + backend + SDK scenarios against a local container
// with zero dependency on public testnet or Friendbot rate limits.
//
// Run locally:
//   docker compose --profile local up -d stellar postgres redis
//   ./contract/scripts/deploy-local.sh
//   npm run test:e2e:local --workspace backend
const base = require("./jest.config.js");

module.exports = {
  ...base,
  roots: ["<rootDir>/tests/e2e"],
  testMatch: ["**/localQuickstart.test.ts"],
  testPathIgnorePatterns: ["/node_modules/"],
  testTimeout: 180_000,
};
