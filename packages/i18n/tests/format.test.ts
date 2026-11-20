import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, formatMessage, pseudoLocalize } from "../src/format";
import errorsEn from "../errors/en.json";
import notificationsEn from "../notifications/en.json";

const items = "{count, plural, =0 {No payments} one {# payment} other {# payments}}";

test("plural picks exact, one and other branches", () => {
  assert.equal(formatMessage(items, { count: 0 }), "No payments");
  assert.equal(formatMessage(items, { count: 1 }), "1 payment");
  assert.equal(formatMessage(items, { count: 1200 }), "1,200 payments");
});

test("plural uses the locale's plural rules", () => {
  const ar = "{n, plural, one {one} two {two} few {few} many {many} other {other}}";
  assert.equal(formatMessage(ar, { n: 2 }, "ar"), "two");
  assert.equal(formatMessage(ar, { n: 3 }, "ar"), "few");
});

test("select and nested placeholders render", () => {
  const msg = "{role, select, guardian {Guardian {name}} other {Someone}} approved";
  assert.equal(formatMessage(msg, { role: "guardian", name: "Ada" }), "Guardian Ada approved");
  assert.equal(formatMessage(msg, { role: "x" }), "Someone approved");
});

test("missing variables are left in place", () => {
  assert.equal(formatMessage("You received {amount} {asset}", { amount: "10" }), "You received 10 {asset}");
});

test("amounts are locale formatted and bidi-isolated", () => {
  const out = formatAmount(1234.5, "XLM", "de");
  assert.equal(out, "⁨1.234,5 XLM⁩");
});

test("pseudo-localisation keeps every catalogue message renderable", () => {
  for (const [key, msg] of Object.entries({ ...errorsEn, ...notificationsEn })) {
    const pseudo = pseudoLocalize(msg as string);
    assert.ok(pseudo.length > (msg as string).length, key);
    const vars = Object.fromEntries([...(msg as string).matchAll(/\{(\w+)\}/g)].map((m) => [m[1], "X"]));
    assert.doesNotMatch(formatMessage(pseudo, vars), /\{\w+\}/, key);
  }
});
