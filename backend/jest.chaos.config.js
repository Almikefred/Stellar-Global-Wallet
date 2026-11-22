/** @type {import('jest').Config} */
// Dedicated Jest config for the live Toxiproxy chaos suite (#234).
// Requires Toxiproxy + Postgres + Redis + stellar/quickstart running via:
//   docker compose --profile local --profile chaos up -d postgres redis stellar toxiproxy
//
// Run locally:
//   npm run test:chaos --workspace backend
const base = require("./jest.config.js");

module.exports = {
  ...base,
  roots: ["<rootDir>/tests/chaos"],
  testMatch: ["**/toxiproxyChaos.test.ts"],
  testPathIgnorePatterns: ["/node_modules/"],
  testTimeout: 120_000,
};
