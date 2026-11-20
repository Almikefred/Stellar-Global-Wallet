import express, { Request, Response } from "express";
import request from "supertest";
import { shutdownManager } from "../services/shutdown";
import { errorHandler } from "../middleware/errorHandler";

describe("Graceful Shutdown (#220)", () => {
  beforeEach(() => {
    shutdownManager.resetForTests();
  });

  it("passes requests through normally when not shutting down", async () => {
    const app = express();
    app.use(shutdownManager.requestTrackerMiddleware);
    app.get("/test", (_req, res) => res.json({ status: "ok" }));
    app.use(errorHandler);

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("rejects new incoming requests with 503 and Connection: close when shutting down", async () => {
    const app = express();
    app.use(shutdownManager.requestTrackerMiddleware);
    app.get("/test", (_req, res) => res.json({ status: "ok" }));
    app.use(errorHandler);

    const server = app.listen(0);
    try {
      // Initiate shutdown
      const shutdownPromise = shutdownManager.initiateShutdown(server, { timeoutMs: 500 });

      const res = await request(app).get("/test");
      expect(res.status).toBe(503);
      expect(res.headers["connection"]).toBe("close");
      expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");

      await shutdownPromise;
    } finally {
      server.close();
    }
  });

  it("tracks in-flight submissions and drains them cleanly", async () => {
    let completed = false;

    const submission = shutdownManager.trackSubmission(async () => {
      await new Promise((r) => setTimeout(r, 50));
      completed = true;
      return "done";
    });

    expect(shutdownManager.getInFlightSubmissionCount()).toBe(1);
    const result = await submission;
    expect(result).toBe("done");
    expect(completed).toBe(true);
    expect(shutdownManager.getInFlightSubmissionCount()).toBe(0);
  });
});
