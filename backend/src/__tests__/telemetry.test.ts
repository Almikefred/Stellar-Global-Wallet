import express, { Request, Response, NextFunction } from "express";
import request from "supertest";
import { parseTraceparent, withSpan, telemetryRegistry } from "../telemetry/tracer";
import { telemetryMiddleware } from "../telemetry/middleware";
import { errorHandler } from "../middleware/errorHandler";
import { AppError } from "../errors/appError";

describe("OpenTelemetry Distributed Tracing (#221)", () => {
  beforeEach(() => {
    telemetryRegistry.clear();
  });

  it("parses valid W3C traceparent headers correctly", () => {
    const validHeader = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const parsed = parseTraceparent(validHeader);
    expect(parsed).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentId: "00f067aa0ba902b7",
    });
  });

  it("handles malformed traceparent headers safely", () => {
    expect(parseTraceparent("invalid-traceparent")).toBeNull();
    expect(parseTraceparent("")).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it("creates custom spans and records parent-child relationships", async () => {
    await withSpan("parent.operation", { "test.parent": true }, async (parentSpan) => {
      expect(parentSpan.name).toBe("parent.operation");

      await withSpan("child.operation", { "test.child": true }, async (childSpan) => {
        expect(childSpan.parentId).toBe(parentSpan.spanId);
        expect(childSpan.traceId).toBe(parentSpan.traceId);
      });
    });

    const spans = telemetryRegistry.getRecentSpans();
    expect(spans.length).toBe(2);
    expect(spans.some((s) => s.name === "child.operation")).toBe(true);
    expect(spans.some((s) => s.name === "parent.operation")).toBe(true);
  });

  it("injects X-Trace-Id and traceparent on HTTP responses", async () => {
    const app = express();
    app.use(telemetryMiddleware);
    app.get("/traced", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/traced");
    expect(res.status).toBe(200);
    expect(res.headers).toHaveProperty("x-trace-id");
    expect(res.headers).toHaveProperty("traceparent");
    expect(res.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("attaches traceId to the error envelope on API failures", async () => {
    const app = express();
    app.use(telemetryMiddleware);
    app.get("/error", (_req, _res, next) => {
      next(new AppError("Failure with trace", { code: "TEST_ERROR", status: 400 }));
    });
    app.use(errorHandler);

    const res = await request(app).get("/error");
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("traceId");
    expect(res.body.error.traceId).toBe(res.headers["x-trace-id"]);
  });
});
