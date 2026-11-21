import { migrations } from "../migrations/runner";

describe("Database Migrations & Evolution (#219)", () => {
  it("defines reversible migrations with up and down handlers", () => {
    expect(migrations.length).toBeGreaterThanOrEqual(3);
    for (const m of migrations) {
      expect(typeof m.name).toBe("string");
      expect(typeof m.up).toBe("function");
      expect(typeof m.down).toBe("function");
    }
  });

  it("includes hot index definitions in migrations", async () => {
    const executedSql: string[] = [];
    const mockClient = {
      query: async (sql: string) => {
        executedSql.push(sql);
        return { rows: [] };
      },
    };

    const indexMigration = migrations.find((m) => m.name === "002_hot_indexes");
    expect(indexMigration).toBeDefined();

    // @ts-expect-error mock client
    await indexMigration!.up(mockClient);

    const fullSql = executedSql.join(" ");
    expect(fullSql).toContain("pending_txs_account_status_idx");
    expect(fullSql).toContain("idempotency_keys_created_at_idx");
  });
});
