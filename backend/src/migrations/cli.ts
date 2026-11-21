import "dotenv/config";
import { pool } from "../db";
import { runMigrations } from "./runner";

async function main() {
  const direction = process.argv[2] === "down" ? "down" : "up";
  console.log(`[migrations] Running migrations (${direction})...`);
  const applied = await runMigrations(pool, direction);
  console.log(`[migrations] Successfully finished (${applied.length} migrations applied/rolled back).`);
  await pool.end();
}

main().catch((err) => {
  console.error("[migrations] Fatal error running migrations:", err);
  process.exit(1);
});
