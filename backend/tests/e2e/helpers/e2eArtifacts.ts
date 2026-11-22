import fs from "node:fs";
import path from "node:path";

export interface RecordedStep {
  timestamp: string;
  phase: string;
  detail: string;
  data?: unknown;
}

export interface ArtifactSummary {
  suite: string;
  failedAt: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  environment: Record<string, string | undefined>;
  steps: RecordedStep[];
}

const SECRET_SEED_RE = /\bS[A-Z2-7]{55}\b/g;
const BEARER_JWT_RE = /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi;
const SENSITIVE_KEY_RE = /(secret|password|token|authorization|api[_-]?key)/i;

/**
 * Recursively strips Stellar secret seeds, Bearer JWTs, and sensitive fields
 * before writing any failure artifact to disk so CI artifacts never leak
 * credentials (#232).
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(SECRET_SEED_RE, "[REDACTED_SECRET_SEED]")
      .replace(BEARER_JWT_RE, "Bearer [REDACTED_JWT]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

export class E2eArtifactRecorder {
  private readonly steps: RecordedStep[] = [];
  private readonly artifactDir: string;

  constructor(
    private readonly suite: string,
    artifactDir: string = process.env.E2E_ARTIFACT_DIR ??
      path.resolve(__dirname, "../../../artifacts/e2e")
  ) {
    this.artifactDir = artifactDir;
  }

  record(phase: string, detail: string, data?: unknown): void {
    this.steps.push({
      timestamp: new Date().toISOString(),
      phase,
      detail: String(redactSecrets(detail)),
      ...(data !== undefined ? { data: redactSecrets(data) } : {}),
    });
  }

  getSteps(): readonly RecordedStep[] {
    return this.steps;
  }

  clear(): void {
    this.steps.length = 0;
  }

  /**
   * Writes both a machine-readable JSON snapshot and a concise Markdown
   * timeline report to `artifactDir` when an E2E test fails.
   */
  writeFailureArtifact(testName: string, err: unknown): { jsonPath: string; mdPath: string } {
    fs.mkdirSync(this.artifactDir, { recursive: true });
    const slug = `${this.suite}-${testName}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(this.artifactDir, `${stamp}-${slug}`);

    const errorObj =
      err instanceof Error
        ? {
            name: err.name,
            message: String(redactSecrets(err.message)),
            stack: err.stack ? String(redactSecrets(err.stack)) : undefined,
          }
        : { name: "UnknownError", message: String(redactSecrets(String(err))) };

    const summary: ArtifactSummary = {
      suite: `${this.suite}: ${testName}`,
      failedAt: new Date().toISOString(),
      error: errorObj,
      environment: {
        HORIZON_URL: process.env.E2E_LOCAL_HORIZON_URL ?? process.env.HORIZON_URL,
        SOROBAN_RPC_URL: process.env.E2E_LOCAL_RPC_URL ?? process.env.SOROBAN_RPC_URL,
        NETWORK_PASSPHRASE:
          process.env.E2E_LOCAL_NETWORK_PASSPHRASE ?? process.env.NETWORK_PASSPHRASE,
        GLOBE_WALLET_CONTRACT_ID: process.env.GLOBE_WALLET_CONTRACT_ID,
      },
      steps: [...this.steps],
    };

    const jsonPath = `${base}.json`;
    const mdPath = `${base}.md`;

    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

    const lines = [
      `# E2E Failure Artifact: ${summary.suite}`,
      "",
      `- **Failed at:** ${summary.failedAt}`,
      `- **Error:** \`${summary.error.name}\` — ${summary.error.message}`,
      "",
      "## Environment",
      "",
      ...Object.entries(summary.environment).map(([k, v]) => `- \`${k}\`: \`${v ?? "(unset)"}\``),
      "",
      "## Step Timeline",
      "",
      ...summary.steps.map(
        (s, idx) =>
          `${idx + 1}. **[${s.timestamp}] (${s.phase})** ${s.detail}` +
          (s.data !== undefined ? `\n   \`\`\`json\n   ${JSON.stringify(s.data)}\n   \`\`\`` : "")
      ),
      "",
    ];
    fs.writeFileSync(mdPath, lines.join("\n"), "utf8");

    return { jsonPath, mdPath };
  }
}
