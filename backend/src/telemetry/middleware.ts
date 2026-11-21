import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { Span, parseTraceparent, withSpan } from "./tracer";

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      span?: Span;
    }
  }
}

/**
 * Express middleware that initializes an OpenTelemetry-compatible SERVER span
 * for each inbound HTTP request, parses W3C TraceContext headers, and injects
 * trace IDs into response headers.
 */
export function telemetryMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingTrace = parseTraceparent(req.headers["traceparent"] ?? req.headers["x-traceparent"]);
  const traceId = incomingTrace?.traceId ?? (typeof req.headers["x-trace-id"] === "string" ? req.headers["x-trace-id"] : crypto.randomBytes(16).toString("hex"));
  const parentId = incomingTrace?.parentId;

  req.traceId = traceId;

  // Echo trace information on the response headers
  res.setHeader("X-Trace-Id", traceId);

  const spanName = `HTTP ${req.method} ${req.baseUrl || req.path || "/"}`;
  const span = new Span(spanName, {
    traceId,
    parentId,
    kind: "SERVER",
    attributes: {
      "http.method": req.method,
      "http.url": req.originalUrl || req.url,
      "http.target": req.path,
      "http.client_ip": req.ip || "",
      "http.user_agent": (req.headers["user-agent"] as string) || "",
    },
  });

  res.setHeader("traceparent", span.toTraceparent());
  req.span = span;

  const onFinish = () => {
    res.removeListener("finish", onFinish);
    res.removeListener("close", onFinish);

    span.setAttribute("http.status_code", res.statusCode);
    if (req.route?.path) {
      span.setAttribute("http.route", String(req.route.path));
    }

    if (res.statusCode >= 500) {
      span.end({ code: "ERROR", message: `HTTP status ${res.statusCode}` });
    } else {
      span.end({ code: "OK" });
    }
  };

  res.on("finish", onFinish);
  res.on("close", onFinish);

  next();
}
