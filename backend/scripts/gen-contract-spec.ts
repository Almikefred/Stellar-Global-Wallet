/**
 * Regenerates the backend's mirror of the globe-wallet contract interface:
 *
 *   src/services/contracts/generated/walletErrors.generated.ts
 *   src/services/contracts/generated/walletEvents.generated.ts
 *   ../contract/docs/errors.md  (block between the GENERATED ERROR CODES markers)
 *
 * and enforces the frozen error-code snapshot
 * (contract/contracts/globe-wallet/error-codes.snapshot.json).
 *
 *   npx tsx scripts/gen-contract-spec.ts          # write
 *   npx tsx scripts/gen-contract-spec.ts --check  # exit 1 if stale / incompatible
 */
import fs from "fs";
import path from "path";
import {
  checkErrorSnapshot,
  parseEventStructs,
  parseEventVersion,
  parseWalletErrors,
  renderErrorsDocTable,
  renderErrorsModule,
  renderEventsModule,
  spliceGeneratedBlock,
} from "../src/services/contracts/contractSpec";

const repo = path.resolve(__dirname, "../..");
const libRs = path.join(repo, "contract/contracts/globe-wallet/src/lib.rs");
const snapshotPath = path.join(repo, "contract/contracts/globe-wallet/error-codes.snapshot.json");
const generatedDir = path.join(repo, "backend/src/services/contracts/generated");
const errorsDoc = path.join(repo, "contract/docs/errors.md");

const check = process.argv.includes("--check");
const source = fs.readFileSync(libRs, "utf-8");
const errors = parseWalletErrors(source);
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as Record<string, number>;

const problems = checkErrorSnapshot(errors, snapshot);
if (problems.length > 0) {
  console.error("WalletError discriminants are incompatible with error-codes.snapshot.json:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const outputs: Array<[string, string]> = [
  [path.join(generatedDir, "walletErrors.generated.ts"), renderErrorsModule(errors)],
  [
    path.join(generatedDir, "walletEvents.generated.ts"),
    renderEventsModule(parseEventVersion(source), parseEventStructs(source)),
  ],
  [errorsDoc, spliceGeneratedBlock(fs.readFileSync(errorsDoc, "utf-8"), renderErrorsDocTable(errors))],
];

let stale = false;
for (const [file, content] of outputs) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  if (current === content) continue;
  if (check) {
    console.error(`stale: ${path.relative(repo, file)}`);
    stale = true;
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote ${path.relative(repo, file)}`);
  }
}
if (stale) {
  console.error("Run `npx tsx scripts/gen-contract-spec.ts` in backend/ and commit the result.");
  process.exit(1);
}
