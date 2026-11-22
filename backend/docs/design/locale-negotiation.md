# Locale middleware: safe Accept-Language negotiation (issue #255)

**Status:** Proposed. Nothing in this document is implemented yet. It
describes the target design for `src/middleware/locale.ts` and
`src/services/i18nHelper.ts`. Update the status line in the PR that ships
it.

## Current state

`localeMiddleware` runs on every request (`src/app.ts`). It works as
follows:

1. `parseAcceptLanguage(header)` does `split(",")`, then
   `split(";q=")` and `parseFloat`, then sorts by q.
2. It appends `req.user?.locale` (the device locale) as a fallback.
3. `resolveLocale()` reduces each candidate to its base language
   (`"en-US"` → `"en"`), returns the first one found in
   `SUPPORTED_LOCALES = ["en"]`, and otherwise returns `"en"`.

`i18nHelper.resolve(catalogues, key, locale)` does the same base-language
reduction, looks up `catalogues[base] ?? catalogues["en"]`, and fills in
`{var}` placeholders.

The good news: `req.locale` can only ever hold a value from
`SUPPORTED_LOCALES`, so the raw header never reaches a template through
`req.locale`. The gaps are in the parser's robustness and in
`i18nHelper`, which trusts whatever locale string it is given.

### Gaps

| # | Gap | Effect |
|---|---|---|
| G1 | The parser has no limit on header length or entry count. | Node allows a header up to about 16 kb. That means about 8,000 entries, all split, mapped and sorted, on every request including `/health`. The CPU cost is small but has no bound. |
| G2 | `parseFloat` on a q-value like `q=abc` gives `NaN`. | `Array.prototype.sort` with `NaN` comparisons gives a result that depends on the engine. Ordering becomes non-deterministic. |
| G3 | `q=0`, which means "not acceptable" (RFC 9110 §12.4.2), is treated as a candidate. | `Accept-Language: en;q=0, fr` would still choose `en` if `fr` is unsupported. That breaks the spec. It only matters once more locales ship, but it is a correctness bug. |
| G4 | Only `;q=` with no spaces is recognised. | `en; q=0.5` (valid per RFC 9110) is parsed with tag `en; q=0.5` and q `1`. |
| G5 | Tags are not validated. | Any bytes are accepted as a "tag". `resolveLocale` filters them out today, but `parseAcceptLanguage` is exported and returns raw strings to any caller. |
| G6 | `i18nHelper.resolve` indexes a plain object with a locale the caller controls. | `tError(code, "__proto__")` gives `catalogues["__proto__"]`, which is `Object.prototype`. The lookup then reads prototype properties: `tError("constructor", "__proto__")` returns a function, not a string. Every current caller passes `req.locale`, but the helper is exported. |
| G7 | `{var}` values are inserted without escaping. | When a notification or email template is HTML and a var holds user-controlled data (a display name, a memo), that data is injected into the template. This is the "injection into templates" risk the issue names. The header itself does not reach vars today, but the helper offers no safe path. |
| G8 | `req.user.locale` is not validated. | A stored device locale goes through the same unchecked path. |
| G9 | Nothing is cached, and there are no `Vary` or `Content-Language` headers. | Every request is parsed again. Shared caches could serve a response localised for one user to another once more locales exist. |

## Threat model

**Attacker:** any client. They control `Accept-Language` entirely, and they
control `req.user.locale` through device registration.

**Goals the attacker might have:**

1. Inject content into localised output (emails, push notifications, error
   messages) through the locale or the interpolated values.
2. Cause a crash or a wrong lookup through prototype keys.
3. Burn CPU with large headers.
4. Poison shared caches with the wrong locale.

**Invariant we keep:** every locale value that reaches catalogue lookup or
any output is a member of `SUPPORTED_LOCALES`. Values from outside are
*parsed and matched*, never passed through.

## Proposed design

### 1. Strict BCP-47 parsing

Replace `parseAcceptLanguage` with a bounded parser that follows RFC 9110
and RFC 4647:

- **Limits:**
  - Headers over 256 characters are cut at the last comma before 256.
  - Only the first 16 entries are considered.
  - Anything beyond either limit is ignored, never rejected, because
    browsers send long but valid lists.
- **Grammar:** each entry is `language-range [ OWS ";" OWS "q=" qvalue ]`.
  - `language-range` must match a strict subset of BCP-47 / RFC 5646:
    `^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?$`
    (language, optional script, optional region), or `*`.
    Extensions and private-use subtags are dropped. Tags are normalised to
    canonical case (`zh-hant-tw` → `zh-Hant-TW`).
  - `qvalue` must match `^(0(\.\d{0,3})?|1(\.0{0,3})?)$`. A missing qvalue
    means `1`. An invalid qvalue drops the whole entry (fixes G2 and G4).
- `q=0` entries go into an **exclusion set** that matching respects (fixes
  G3).
- The sort is stable: q descending, with ties kept in header order.
- Return type: `{ tag: string; q: number }[]`, already validated (fixes G5).

Malformed input never throws. It produces fewer candidates, and in the
worst case the fallback.

### 2. Fallback chain

Use RFC 4647 §3.4 "lookup", applied in this order:

1. For each header range, in q order: try the exact tag, then cut subtags
   one by one (`zh-Hant-TW` → `zh-Hant` → `zh`). Ranges in the exclusion
   set are skipped. `*` matches the first supported locale that is not
   excluded.
2. Next, `req.user.locale`, validated with the same tag grammar. An invalid
   stored value is ignored and counted
   (`locale_invalid_total{source="device"}`).
3. Finally, `DEFAULT_LOCALE` (`"en"`).

`SUPPORTED_LOCALES` keeps full tags (for example `"pt-BR"` alongside
`"pt"`), so a regional catalogue can ship later with no code change.

### 3. Hardening `i18nHelper`

- Catalogues are stored in a `Map<SupportedLocale, Catalogue>`, or in
  objects made with `Object.create(null)`, so prototype keys can't resolve
  (fixes G6).
- `tError` and `tNotification` accept `SupportedLocale`, not `string`.
  Arbitrary strings become a type error. There is also a runtime guard that
  sends unknown values to `"en"`.
- Lookups use `Object.hasOwn(catalogue, key)`.
- Interpolation gets an explicit output context:
  `t(key, locale, vars, { escape: "html" | "none" })`.
  - Email HTML templates **must** use `"html"`, which escapes `& < > " '` in
    every var value.
  - Push and plain-text templates use `"none"`.
  - Var values are coerced to strings and truncated to 200 characters
    (fixes G7).

### 4. Caching by locale

- **Parse cache:** an LRU mapping the raw `Accept-Language` string to the
  resolved `SupportedLocale`, with at most 256 entries. Only headers up to
  256 characters are cached, so an attacker can't fill the cache with large
  keys. Real traffic sends a small number of distinct header strings, so
  the hit rate is high.
- **Catalogue cache:** catalogues are loaded once per locale at startup and
  frozen with `Object.freeze`. A merged view for each locale and fallback
  (for example `pt-BR` → `pt` → `en`) is computed once and memoised, so
  each lookup is a single `Map.get`.
- **HTTP caching:** responses that depend on `req.locale` (error bodies,
  `/me/email` messages) set `Content-Language: <locale>` and add
  `Vary: Accept-Language` (fixes G9).

### Data model

There is no persistent state. The new in-memory state is the bounded parse
LRU and the frozen catalogues. `req.user.locale` keeps its current storage,
but is now validated on write in the device-registration route, at the
edge, using the same tag grammar.

### Failure modes

| Input | Result |
|---|---|
| No header | Device locale, then `en` |
| Empty header, or only commas and whitespace | `en` |
| A 16 kb header | Cut to 256 characters / 16 entries, then parsed normally |
| `en;q=abc`, `en;q=2`, `en;q=-1` | Entry dropped |
| `"><script>`, `../../etc`, `__proto__` | Entry dropped (fails the grammar) |
| `en;q=0, *` | Nothing supported is acceptable. The result is still `en`: the default is the last resort even when excluded, because RFC 9110 lets a server ignore the header rather than return `406` |
| `fr-CA` while only `en` is supported | `en` |
| `tError(code, "__proto__" as any)` | Runtime guard gives `en`, and the code's message is returned |
| A catalogue key is missing | The key itself is returned (current behaviour). The CI missing-key check (#92) prevents this. |

## Test plan

Add these to a new file, `src/__tests__/locale.test.ts`:

- [ ] **Malformed headers fall back safely.** Use a table of malformed
      inputs, each resolving to `en` without throwing: empty, `,,,`, `;q=1`,
      `en;q=abc`, `en;q=1.5`, control characters, 16 kb of `a,`, a
      `__proto__` tag, a `<script>` tag.
- [ ] RFC 9110 examples parse correctly, including with whitespace around
      `;` (`en; q=0.5`).
- [ ] `q=0` excludes a locale, and is tested once a second locale exists.
      Until then, use a fixture with `SUPPORTED_LOCALES` stubbed.
- [ ] Equal q values keep header order, so the sort is stable.
- [ ] Subtag truncation works: `en-Latn-US` → `en`.
- [ ] An invalid device locale is ignored and counted.
- [ ] `i18nHelper`: prototype-key lookups return the key, never a
      function. `escape: "html"` escapes all five characters.
- [ ] The parse LRU never grows past 256 entries after 10,000 distinct
      headers.
- [ ] Localised error responses carry `Content-Language` and
      `Vary: Accept-Language`.
- [ ] Performance: parsing a 16 kb header finishes in under 1 ms.
      Measure before and after, and record both numbers in the PR.

## Rollout and docs checklist

- [ ] Add a "Localisation" section to `backend/README.md` covering
      supported locales, the fallback order, and the escaping rule for
      templates.
- [ ] In `openapi.yaml`, document `Accept-Language` as an optional request
      header on every operation (a shared parameter), and `Content-Language`
      on error responses.
- [ ] No SDK change is required. Optionally, `packages/sdk` could expose a
      `locale` option that sets `Accept-Language`.
- [ ] Update the doc comments in `locale.ts` and `i18nHelper.ts` to point
      here.
