import type { Express } from "express";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EnumeratedRoute {
  method: HttpMethod;
  path: string;
  /** Canonical unique key: `${method} ${path}`. */
  key: string;
}

const SUPPORTED_METHODS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
]);

interface ExpressLayer {
  name?: string;
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
  regexp?: RegExp & { fast_slash?: boolean };
  handle?: {
    stack?: ExpressLayer[];
  };
}

/**
 * Extracts the static mount prefix from an Express 4 router layer's compiled
 * regexp (e.g. `/^\/api\/v1\/wallet\/?(?=\/|$)/i` -> `"/api/v1/wallet"`).
 */
function extractMountPath(layer: ExpressLayer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return "";
  let src = layer.regexp.source;
  // Strip standard Express mount prefix / suffix anchors.
  src = src
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\(\?=\\\/\|\$\)$/, "")
    .replace(/\\\/\?$/, "")
    .replace(/\$$/, "");
  // Unescape escaped forward slashes and dots.
  src = src.replace(/\\\//g, "/").replace(/\\\./g, ".");
  if (!src || src === "/") return "";
  return src.startsWith("/") ? src : `/${src}`;
}

function joinPaths(prefix: string, suffix: string): string {
  const combined = `${prefix}/${suffix}`.replace(/\/+/g, "/");
  if (combined.length > 1 && combined.endsWith("/")) {
    return combined.slice(0, -1);
  }
  return combined || "/";
}

function walkStack(stack: ExpressLayer[], prefix: string, out: EnumeratedRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const routePaths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route?.methods[m] && SUPPORTED_METHODS.has(m.toLowerCase()))
        .map((m) => m.toUpperCase() as HttpMethod);

      for (const routePath of routePaths) {
        const fullPath = joinPaths(prefix, routePath);
        for (const method of methods) {
          out.push({ method, path: fullPath, key: `${method} ${fullPath}` });
        }
      }
      continue;
    }

    if (layer.name === "router" && Array.isArray(layer.handle?.stack)) {
      const mountPath = extractMountPath(layer);
      const nextPrefix = mountPath ? joinPaths(prefix, mountPath) : prefix;
      walkStack(layer.handle.stack, nextPrefix, out);
    }
  }
}

/**
 * Introspects a mounted Express application and returns every unique
 * `(method, path)` route sorted deterministically by path then method (#233).
 */
export function enumerateAppRoutes(app: Express): EnumeratedRoute[] {
  const router = (app as unknown as { _router?: { stack?: ExpressLayer[] } })._router;
  if (!router || !Array.isArray(router.stack)) {
    return [];
  }

  const raw: EnumeratedRoute[] = [];
  walkStack(router.stack, "", raw);

  const unique = new Map<string, EnumeratedRoute>();
  for (const route of raw) {
    unique.set(route.key, route);
  }

  return [...unique.values()].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)
  );
}
