# Supply-Chain Hardening: SBOM, Signed Images, Pinned Actions

**Issue:** [#236](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/236)  
**Status:** Proposed  
**Difficulty:** Hard  
**Estimated size:** L — roughly 1–2 weeks

---

## Problem

Wallet software is a high-value supply-chain target. Currently:

- Docker images ship without provenance attestations or signatures.
- npm packages (SDK) are published without provenance.
- GitHub Actions workflows reference actions by mutable tags, so a compromised upstream action tag can silently inject malicious code into CI.

---

## Proposed Design

### 1. Software Bill of Materials (SBOM)

Use [Syft](https://github.com/anchore/syft) to generate an SBOM for every Docker image build and every npm package release.

**Docker images**

Add a `syft` step after the `docker build` step in `.github/workflows/`:

```yaml
- name: Generate SBOM
  uses: anchore/sbom-action@<SHA>
  with:
    image: ghcr.io/genghis-codes/stellar-global-wallet-backend:${{ github.sha }}
    format: spdx-json
    output-file: sbom.spdx.json
- name: Attach SBOM to release
  uses: actions/upload-artifact@<SHA>
  with:
    name: sbom
    path: sbom.spdx.json
```

For npm packages, generate an SBOM using `syft packages . -o spdx-json` and attach it as a release asset.

### 2. Image Signing and Provenance (cosign)

Use [cosign](https://github.com/sigstore/cosign) with keyless signing (Sigstore OIDC) so no long-lived private key needs to be stored in GitHub Secrets.

**Sign after push:**

```yaml
- name: Sign image
  uses: sigstore/cosign-installer@<SHA>
- run: |
    cosign sign --yes \
      ghcr.io/genghis-codes/stellar-global-wallet-backend:${{ github.sha }}
```

**Generate SLSA provenance** using the `slsa-github-generator` action (level 2):

```yaml
- uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@<SHA>
  with:
    image: ghcr.io/genghis-codes/stellar-global-wallet-backend
    digest: ${{ steps.build-push.outputs.digest }}
```

**Verify in CI** (deployment gate):

```yaml
- name: Verify image signature
  run: |
    cosign verify \
      --certificate-identity-regexp "https://github.com/Genghis-codes/Stellar-Global-Wallet" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      ghcr.io/genghis-codes/stellar-global-wallet-backend@${{ env.IMAGE_DIGEST }}
```

### 3. Pin GitHub Actions by SHA

All `uses:` lines in `.github/workflows/` must reference a full commit SHA, not a mutable tag. Use a comment to record the human-readable version.

**Before:**
```yaml
uses: actions/checkout@v4
```

**After:**
```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
```

Automate updates with [Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot) configured for `github-actions` in `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

### 4. npm Provenance for SDK

Publish `packages/sdk` with npm provenance so the package links back to the exact commit and workflow run:

```yaml
- name: Publish SDK
  run: npm publish --provenance --access public
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Requires npm ≥ 9.5.0 and the workflow to have `id-token: write` permission.

---

## Threat Model

| Threat | Mitigation |
|---|---|
| Compromised upstream action tag | Pinned SHAs; Dependabot for controlled updates |
| Tampered Docker image in registry | cosign signature + SLSA provenance; `cosign verify` in deploy step |
| Malicious npm package (typosquat / hijack) | npm provenance links package to auditable GitHub Actions run |
| Unknown transitive dependency | SBOM attached to every release; scannable by Grype/Trivy |

---

## CI Changes

The `cosign verify` step must run in any workflow that pulls the image for deployment or integration tests. A verification failure must block the workflow (`exit 1`).

The SBOM and provenance attestations are attached to the GitHub Release and to the GHCR image as OCI referrers, so they are co-located with the artifact.

---

## Tasks

- [ ] Add Syft SBOM generation to Docker build workflow
- [ ] Add Syft SBOM generation to SDK publish workflow
- [ ] Add cosign keyless signing step after image push
- [ ] Add SLSA provenance generation for Docker images
- [ ] Add `cosign verify` gate to deployment/integration workflows
- [ ] Pin all `uses:` lines in `.github/workflows/` to full SHAs
- [ ] Add Dependabot config for `github-actions`
- [ ] Add `--provenance` flag to npm publish step for SDK
- [ ] Update README and contributing guide with verification instructions

---

## Verification Instructions (for contributors)

After a release, verify the backend image locally:

```bash
cosign verify \
  --certificate-identity-regexp "https://github.com/Genghis-codes/Stellar-Global-Wallet" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/genghis-codes/stellar-global-wallet-backend:<tag>
```

Verify the SBOM is attached:

```bash
cosign download attestation \
  ghcr.io/genghis-codes/stellar-global-wallet-backend:<tag> \
  | jq '.payload | @base64d | fromjson | .predicate.packages | length'
```

Verify SDK provenance on npmjs.com:

```
npm info @stellar-global-wallet/sdk dist.attestations
```

---

## Definition of Done

- [ ] Code merged to `main`
- [ ] All acceptance criteria checked (signed artifacts with SBOMs, CI green, no unlinked TODOs)
- [ ] PR description links this issue (`Closes #236`) and lists any deferred work
- [ ] README updated with verification instructions for consumers
