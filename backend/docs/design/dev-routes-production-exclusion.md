# Dev routes: guarantee they can't be enabled in production (issue #253)

**Status:** Proposed. Nothing in this document is implemented yet. It
describes the target design for `src/routes/dev.ts`, `src/app.ts`,
`src/config.ts` and the build. Update the status line in the PR that ships
it.

## Current state

`src/routes/dev.ts` exports `createDevRouter()`. It has one route,
`POST /fund { account }`, which calls Stellar's Friendbot. In `src/app.ts`
it is mounted like this:

```ts
if (config.STELLAR_NETWORK === "testnet") {
  app.use("/api/v1/dev", createDevRouter());
}
```

### Gaps

| # | Gap | Effect |
|---|---|---|
| G1 | **`STELLAR_NETWORK` defaults to `"testnet"`** (`src/config.ts`). | A production deployment that forgets to set `STELLAR_NETWORK` boots on testnet with dev routes mounted. A typo in the variable *name* has the same result. |
| G2 | `NODE_ENV` is not checked at all. | The Dockerfile sets `NODE_ENV=production`, but the dev router ignores it. |
| G3 | `tsc` compiles all of `src/`. | `dist/routes/dev.js` ships in every image, including mainnet images. Turning it on takes only a config change, with no new code. |
| G4 | There is no startup assertion. | A misconfiguration is only found when someone notices the endpoint. |
| G5 | The only gate is a single `if` in `app.ts`. | A refactor that moves route mounting can quietly drop the check. No test asserts that the route is absent. |

Today Friendbot can only fund testnet accounts, so the direct harm is
limited. The problem is the pattern: `/api/v1/dev` is where future
debugging and seeding helpers will go. Those helpers *will* be dangerous,
and they will inherit whatever gate exists then.

## Threat model

**Attacker:** an unauthenticated internet client who finds `/api/v1/dev/*`
on a production deployment.

**Root cause we defend against:** operator misconfiguration. That includes
a missing env var, a variable copied from a staging config, or a wrong
default. A malicious operator is out of scope, because they can deploy any
code they like.

**Goal:** turning on dev routes in production must take *several* separate,
deliberate mistakes. When it does happen, it must fail loudly and early.
Ideally, a production artifact cannot enable them at all.

## Proposed design

Defence in depth uses three independent layers. Any one of them on its own
is enough to keep dev routes off in production.

### Layer 1: compile-time exclusion

- Move dev-only code into `src/dev/`, with `src/dev/router.ts` replacing
  `src/routes/dev.ts`. Add a single entry point, `src/dev/index.ts`, that
  exports `mountDevRoutes(app)`.
- Add `tsconfig.prod.json`, which extends `tsconfig.json` with
  `"exclude": ["src/dev/**", "src/**/__tests__/**"]`.
- Add a `build:prod` script that runs `tsc -p tsconfig.prod.json` and then
  `node scripts/assert-no-dev-code.js`. The assert script fails the build
  if `dist/dev/` exists, or if any file in `dist/` contains the strings
  `friendbot` or `mountDevRoutes`.
- `app.ts` loads the module only after the runtime gate (layer 2) passes:

  ```ts
  if (devRoutesAllowed(config)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("./dev").mountDevRoutes(app);
  }
  ```

  If the gate passes but the module is missing (because this is a prod
  build), the process exits at startup with `DEV_ROUTES_NOT_BUILT`. A gate
  that passes in a prod build is itself a misconfiguration.
- The mainnet `Dockerfile` uses `build:prod`. The Render testnet preview
  (`render.yaml`) keeps the full build, because it needs Friendbot for
  one-click onboarding (#69, #110).

### Layer 2: explicit opt-in gate

Dev routes mount only when **all** of these hold:

| Condition | Why |
|---|---|
| `ENABLE_DEV_ROUTES=true` (new variable, default `false`) | Opting in must be deliberate, never a default |
| `STELLAR_NETWORK=testnet` | Friendbot and seeding only make sense on testnet |
| `DEPLOY_ENV` is not `production` (new variable: `local`, `preview` or `production`, default `production`) | Unlike `NODE_ENV`, this says what the deployment *is*. `NODE_ENV=production` is also set on the testnet preview for performance reasons, so it can't answer that question. |

Note that `DEPLOY_ENV` defaults to `production`. That is the safe failure
direction: forgetting the variable turns dev routes off. `.env.example`
sets `DEPLOY_ENV=local`, and `render.yaml` sets `DEPLOY_ENV=preview`.

### Layer 3: startup assertion

Add a zod `superRefine` in `src/config.ts` that **refuses to boot** (with a
non-zero exit and a clear message) when any of these hold:

- `ENABLE_DEV_ROUTES=true` and `STELLAR_NETWORK=mainnet` → `DEV_ROUTES_ON_MAINNET`
- `ENABLE_DEV_ROUTES=true` and `DEPLOY_ENV=production` → `DEV_ROUTES_IN_PRODUCTION`
- `DEPLOY_ENV=production` and `STELLAR_NETWORK` was not set explicitly → `STELLAR_NETWORK_REQUIRED`
  (this closes G1 without changing the local default)

Crashing is deliberate. The orchestrator then marks the deploy as failed
and keeps the previous version running. That is a better result than
silently serving the dangerous route, or silently skipping a route that
someone believed was on.

When dev routes do mount, startup logs one line:
`{"level":"warn","event":"dev_routes_enabled","deployEnv":…,"network":…}`.

### Data model

There is no persistent state. The gate is decided once, at startup, from
validated config.

### Failure modes

| Failure | Result |
|---|---|
| `STELLAR_NETWORK` is missing in prod | Boot refused (`STELLAR_NETWORK_REQUIRED`) |
| Someone copies `ENABLE_DEV_ROUTES=true` into the prod env | Boot refused (`DEV_ROUTES_IN_PRODUCTION`) |
| `DEPLOY_ENV` is missing | It defaults to `production`, so dev routes are off. If `ENABLE_DEV_ROUTES=true` is also set, boot is refused. |
| A prod image is started with every gate open | Boot refused (`DEV_ROUTES_NOT_BUILT`), because the code is not in the image |
| A refactor removes the gate in `app.ts` | The prod build has no `dev` module, so `require` throws at boot. The route-absence tests below also fail in CI. |
| The preview loses Friendbot after this change | Expected, unless `render.yaml` sets `DEPLOY_ENV=preview` and `ENABLE_DEV_ROUTES=true`. Both must change in the same PR. |

## Test plan

- [ ] **The production build has no dev routes.** A CI job runs
      `npm run build:prod` and asserts that `dist/dev/` does not exist and
      that no file under `dist/` matches `/friendbot|mountDevRoutes/i`.
- [ ] A supertest with `DEPLOY_ENV=production` and `STELLAR_NETWORK=testnet`
      sends `POST /api/v1/dev/fund` and gets `404 ROUTE_NOT_FOUND`
      (negative test).
- [ ] With `STELLAR_NETWORK=mainnet`, the route returns `404` whatever the
      other flags are.
- [ ] With `ENABLE_DEV_ROUTES` unset, the route returns `404` even locally
      on testnet.
- [ ] With `DEPLOY_ENV=local`, `STELLAR_NETWORK=testnet` and
      `ENABLE_DEV_ROUTES=true`, the route is mounted and the existing
      Friendbot tests pass.
- [ ] Config parsing throws `DEV_ROUTES_ON_MAINNET`,
      `DEV_ROUTES_IN_PRODUCTION` and `STELLAR_NETWORK_REQUIRED` in the cases
      listed above. Each one gets its own test.
- [ ] `devRoutesAllowed()` is a pure function with a truth-table test
      covering all 12 combinations of the three variables.

## Rollout and docs checklist

- [ ] Add `ENABLE_DEV_ROUTES` and `DEPLOY_ENV` to `src/config.ts`,
      `.env.example` and `render.yaml`.
- [ ] Add a "Dev routes" row to [`environments.md`](../environments.md)
      showing where each one is enabled (local: opt-in, preview: on,
      production: impossible).
- [ ] Mark `/api/v1/dev/*` in `openapi.yaml` with
      `x-environments: [local, preview]` and a description saying the paths
      return 404 in production.
- [ ] No SDK change, unless the SDK wraps `/dev/fund`. Check
      `packages/sdk` and, if it does, document that the call fails with
      `404` outside dev environments.
- [ ] Mention `build:prod` in `backend/README.md` and the Dockerfile
      comments.

## Open question for maintainers

Should the Render preview use `DEPLOY_ENV=preview`, keeping Friendbot? Or
should onboarding funding move into the client, calling Friendbot directly,
so that dev routes are never deployed anywhere? This design assumes the
first option, because it keeps #69's one-click onboarding working.
