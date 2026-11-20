export type MessageVars = Record<string, string | number>;

const FSI = "⁨"; // first-strong isolate
const PDI = "⁩"; // pop directional isolate

/** Index of the brace closing the one opened at `open`, honouring nesting. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Parse `=0 {..} one {..} other {..}` into a selector → sub-message map. */
function parseOptions(body: string): Map<string, string> {
  const options = new Map<string, string>();
  const re = /\s*(=?\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(body, open);
    if (close === -1) break;
    options.set(m[1], body.slice(open + 1, close));
    re.lastIndex = close + 1;
  }
  return options;
}

/**
 * Render an ICU MessageFormat subset: `{name}`, `{n, plural, ...}` (with
 * `=N` exact matches and `#`) and `{key, select, ...}`. Unknown placeholders
 * are left as-is so partial renders are still useful.
 */
export function formatMessage(template: string, vars: MessageVars = {}, locale = "en"): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open === -1) return out + template.slice(i);
    const close = matchBrace(template, open);
    if (close === -1) return out + template.slice(i);
    out += template.slice(i, open);
    const inner = template.slice(open + 1, close);
    const [name, type, ...rest] = inner.split(",");
    const key = name.trim();
    const has = Object.prototype.hasOwnProperty.call(vars, key);

    if (type === undefined) {
      out += has ? String(vars[key]) : template.slice(open, close + 1);
    } else if (!has) {
      out += template.slice(open, close + 1);
    } else {
      const options = parseOptions(rest.join(","));
      const value = vars[key];
      let chosen: string | undefined;
      if (type.trim() === "plural") {
        const n = Number(value);
        chosen = options.get(`=${n}`) ?? options.get(new Intl.PluralRules(locale).select(n));
        chosen = (chosen ?? options.get("other") ?? "").replace(/#/g, new Intl.NumberFormat(locale).format(n));
      } else {
        chosen = options.get(String(value)) ?? options.get("other") ?? "";
      }
      out += formatMessage(chosen, vars, locale);
    }
    i = close + 1;
  }
  return out;
}

/**
 * Locale-aware asset amount, isolated with FSI/PDI so digits and the asset
 * code keep their order when embedded in right-to-left (e.g. Arabic) text.
 */
export function formatAmount(
  amount: number | string,
  asset: string,
  locale = "en",
  maximumFractionDigits = 7
): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits }).format(n);
  return `${FSI}${formatted} ${asset}${PDI}`;
}

const ACCENTS: Record<string, string> = {
  a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", c: "ç", n: "ñ",
};

/**
 * Pseudo-localise a message: accent letters and pad ~30% to surface
 * hard-coded strings and truncation, leaving ICU `{...}` syntax intact.
 */
export function pseudoLocalize(template: string): string {
  let depth = 0;
  let out = "";
  for (const ch of template) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    out += depth === 0 ? (ACCENTS[ch] ?? ch) : ch;
  }
  return `[${out}${"~".repeat(Math.ceil(template.length * 0.3))}]`;
}
