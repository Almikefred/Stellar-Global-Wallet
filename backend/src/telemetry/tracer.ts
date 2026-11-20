import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

export type SpanKind = "SERVER" | "CLIENT" | "INTERNAL" | "PRODUCER" | "CONSUMER";

export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

export interface SpanStatus {
  code: "UNSET" | "OK" | "ERROR";
  message?: string;
}

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes?: Record<string, unknown>;
}

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId?: string;
  readonly kind: SpanKind;
  readonly startTimeMs: number;
  name: string;
  endTimeMs?: number;
  durationMs?: number;
  status: SpanStatus = { code: "UNSET" };
  attributes: Record<string, string | number | boolean> = {};
  events: SpanEvent[] = [];

  constructor(
    name: string,
    options: {
      traceId?: string;
      spanId?: string;
      parentId?: string;
      kind?: SpanKind;
      attributes?: Record<string, string | number | boolean>;
    } = {}
  ) {
    this.name = name;
    this.traceId = options.traceId ?? crypto.randomBytes(16).toString("hex");
    this.spanId = options.spanId ?? crypto.randomBytes(8).toString("hex");
    this.parentId = options.parentId;
    this.kind = options.kind ?? "INTERNAL";
    this.startTimeMs = Date.now();
    if (options.attributes) {
      Object.assign(this.attributes, options.attributes);
    }
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, string | number | boolean>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }

  recordException(err: unknown): this {
    this.status = {
      code: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    };
    this.addEvent("exception", {
      "exception.type": err instanceof Error ? err.name : typeof err,
      "exception.message": err instanceof Error ? err.message : String(err),
      "exception.stacktrace": err instanceof Error ? err.stack : undefined,
    });
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): this {
    this.events.push({
      name,
      timeMs: Date.now(),
      attributes,
    });
    return this;
  }

  end(status?: SpanStatus): void {
    if (this.endTimeMs !== undefined) return;
    this.endTimeMs = Date.now();
    this.durationMs = this.endTimeMs - this.startTimeMs;
    if (status) {
      this.status = status;
    } else if (this.status.code === "UNSET") {
      this.status = { code: "OK" };
    }
    telemetryRegistry.record(this.toRecord());
  }

  toRecord(): SpanRecord {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentId: this.parentId,
      name: this.name,
      kind: this.kind,
      startTimeMs: this.startTimeMs,
      endTimeMs: this.endTimeMs,
      durationMs: this.durationMs,
      status: this.status,
      attributes: { ...this.attributes },
      events: [...this.events],
    };
  }

  /** W3C Traceparent string: 00-{traceId}-{spanId}-01 */
  toTraceparent(): string {
    return `00-${this.traceId}-${this.spanId}-01`;
  }
}

class TelemetryRegistry {
  private spans: SpanRecord[] = [];
  private maxSpans = 1000;

  record(span: SpanRecord): void {
    this.spans.push(span);
    if (this.spans.length > this.maxSpans) {
      this.spans.shift();
    }
  }

  getRecentSpans(): SpanRecord[] {
    return [...this.spans];
  }

  clear(): void {
    this.spans = [];
  }
}

export const telemetryRegistry = new TelemetryRegistry();

const asyncLocalStorage = new AsyncLocalStorage<Span>();

/** Parse W3C traceparent header: 00-{traceId}-{spanId}-{flags} */
export function parseTraceparent(header?: string | string[]): { traceId: string; parentId: string } | null {
  if (typeof header !== "string") return null;
  const match = header.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  if (!match) return null;
  return { traceId: match[1].toLowerCase(), parentId: match[2].toLowerCase() };
}

/** Get the currently active span in the async context. */
export function getActiveSpan(): Span | undefined {
  return asyncLocalStorage.getStore();
}

/** Get the active trace ID (or empty string if none active). */
export function getActiveTraceId(): string | undefined {
  return asyncLocalStorage.getStore()?.traceId;
}

/**
 * Execute an async function within a custom span.
 * Automatically links parent-child spans and records exceptions.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> = {},
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = "INTERNAL"
): Promise<T> {
  const parent = getActiveSpan();
  const traceId = parent?.traceId ?? crypto.randomBytes(16).toString("hex");
  const parentId = parent?.spanId;

  const span = new Span(name, {
    traceId,
    parentId,
    kind,
    attributes,
  });

  return asyncLocalStorage.run(span, async () => {
    try {
      const result = await fn(span);
      span.end({ code: "OK" });
      return result;
    } catch (err) {
      span.recordException(err);
      span.end({ code: "ERROR", message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  });
}

/**
 * Run a synchronous function within a span.
 */
export function withSpanSync<T>(
  name: string,
  attributes: Record<string, string | number | boolean> = {},
  fn: (span: Span) => T,
  kind: SpanKind = "INTERNAL"
): T {
  const parent = getActiveSpan();
  const traceId = parent?.traceId ?? crypto.randomBytes(16).toString("hex");
  const parentId = parent?.spanId;

  const span = new Span(name, {
    traceId,
    parentId,
    kind,
    attributes,
  });

  return asyncLocalStorage.run(span, () => {
    try {
      const result = fn(span);
      span.end({ code: "OK" });
      return result;
    } catch (err) {
      span.recordException(err);
      span.end({ code: "ERROR", message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  });
}
