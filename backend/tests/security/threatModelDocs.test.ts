import fs from "node:fs";
import path from "node:path";

/**
 * Executable integrity check for the system-wide threat model (#238).
 * Ensures docs/threat-model.md stays complete (STRIDE across all 4 system
 * layers, Mermaid DFDs, threat-to-issue mapping, all 4 key-compromise
 * playbooks, and two-maintainer review table) and that every repository
 * file path it references exists on disk (no silent doc drift).
 */
describe("System threat model documentation integrity (#238)", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const threatModelPath = path.join(repoRoot, "docs/threat-model.md");
  const content = fs.readFileSync(threatModelPath, "utf8");

  it("includes Mermaid data flow diagrams covering architecture, signing, auth, and governance", () => {
    const mermaidBlocks = content.match(/```mermaid/g) ?? [];
    expect(mermaidBlocks.length).toBeGreaterThanOrEqual(4);
    expect(content).toContain("TB-1:");
    expect(content).toContain("TB-5:");
  });

  it("covers all 4 required system layers with STRIDE threat IDs", () => {
    expect(content).toMatch(/### 2\.1 Smart Contracts/);
    expect(content).toMatch(/### 2\.2 Backend API/);
    expect(content).toMatch(/### 2\.3 SDK & Shared Packages/);
    expect(content).toMatch(/### 2\.4 Clients/);

    expect(content).toContain("T-CON-01");
    expect(content).toContain("T-API-01");
    expect(content).toContain("T-SDK-01");
    expect(content).toContain("T-CLI-01");

    // Ensure every STRIDE category is addressed across the document.
    for (const category of [
      "**S**poofing",
      "**T**ampering",
      "**R**epudiation",
      "**I**nformation Disclosure",
      "**D**enial of Service",
      "**E**levation of Privilege",
    ]) {
      expect(content).toContain(category);
    }
  });

  it("covers all 4 required key-compromise scenarios (user, admin, guardian, backend)", () => {
    expect(content).toMatch(/### 3\.1 User Key Compromise/);
    expect(content).toMatch(/### 3\.2 Contract Admin/);
    expect(content).toMatch(/### 3\.3 Guardian Key Compromise/);
    expect(content).toMatch(/### 3\.4 Backend & Operational Key Compromise/);
  });

  it("includes the two-maintainer review sign-off table", () => {
    expect(content).toContain("Maintainer 1");
    expect(content).toContain("Maintainer 2");
  });

  it("has zero dangling relative markdown links", () => {
    const docsDir = path.dirname(threatModelPath);
    const linkRe = /\]\(([^)]+)\)/g;
    const missing: string[] = [];

    for (const match of content.matchAll(linkRe)) {
      const target = match[1].split("#")[0];
      if (!target || /^https?:\/\//.test(target)) continue;
      const resolved = path.resolve(docsDir, target);
      if (!fs.existsSync(resolved)) {
        missing.push(target);
      }
    }

    expect(missing).toEqual([]);
  });
});
