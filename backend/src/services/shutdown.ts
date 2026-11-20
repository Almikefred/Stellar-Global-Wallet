import { Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { AppError } from "../errors/appError";

export interface SseClient {
  res: Response;
  id: string;
}

export interface ShutdownOptions {
  timeoutMs?: number;
  onDrainStart?: () => Promise<void> | void;
  onDrainComplete?: () => Promise<void> | void;
}

class ShutdownManager {
  private shuttingDown = false;
  private inFlightRequests = 0;
  private inFlightSubmissions = 0;
  private sseClients = new Map<string, Response>();
  private drainResolvers: Array<() => void> = [];

  /** Whether the server is currently draining connections for shutdown. */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Current number of active in-flight HTTP requests. */
  getInFlightRequestCount(): number {
    return this.inFlightRequests;
  }

  /** Current number of active transaction submissions. */
  getInFlightSubmissionCount(): number {
    return this.inFlightSubmissions;
  }

  /** Express middleware to track in-flight requests and reject new traffic during shutdown. */
  requestTrackerMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    if (this.shuttingDown) {
      res.setHeader("Connection", "close");
      next(
        new AppError("Server is shutting down. Please retry shortly.", {
          code: "SERVICE_UNAVAILABLE",
          status: 503,
          retryable: true,
        })
      );
      return;
    }

    this.inFlightRequests++;

    const cleanup = () => {
      res.removeListener("finish", cleanup);
      res.removeListener("close", cleanup);
      this.inFlightRequests--;
      this.checkDrained();
    };

    res.on("finish", cleanup);
    res.on("close", cleanup);
    next();
  };

  /** Track a critical submission operation to ensure it completes before process exit. */
  async trackSubmission<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlightSubmissions++;
    try {
      return await fn();
    } finally {
      this.inFlightSubmissions--;
      this.checkDrained();
    }
  }

  /** Register an active SSE response so it can be gracefully notified and closed during shutdown. */
  registerSseClient(id: string, res: Response): void {
    if (this.shuttingDown) {
      res.write("retry: 3000\nevent: shutdown\ndata: {\"status\":\"shutting_down\",\"retryAfter\":3}\n\n");
      res.end();
      return;
    }
    this.sseClients.set(id, res);
    res.on("close", () => {
      this.sseClients.delete(id);
    });
  }

  /** Unregister an SSE client when closed cleanly. */
  unregisterSseClient(id: string): void {
    this.sseClients.delete(id);
  }

  /** Notify all open SSE streams with reconnect hints and close them. */
  closeSseClients(): void {
    for (const [id, res] of this.sseClients.entries()) {
      try {
        if (!res.writableEnded) {
          res.write("retry: 3000\nevent: shutdown\ndata: {\"status\":\"shutting_down\",\"retryAfter\":3}\n\n");
          res.end();
        }
      } catch {
        // Ignore write errors on closing streams
      }
      this.sseClients.delete(id);
    }
  }

  private checkDrained(): void {
    if (this.shuttingDown && this.inFlightRequests === 0 && this.inFlightSubmissions === 0) {
      const resolvers = [...this.drainResolvers];
      this.drainResolvers = [];
      resolvers.forEach((resolve) => resolve());
    }
  }

  /** Wait until all in-flight requests and submissions have settled. */
  async waitForDrain(timeoutMs = 25_000): Promise<boolean> {
    if (this.inFlightRequests === 0 && this.inFlightSubmissions === 0) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;

      const onDrained = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };

      timer = setTimeout(() => {
        const idx = this.drainResolvers.indexOf(onDrained);
        if (idx !== -1) this.drainResolvers.splice(idx, 1);
        console.warn(
          `[shutdown] Drain timeout reached with ${this.inFlightRequests} requests and ${this.inFlightSubmissions} submissions still active.`
        );
        resolve(false);
      }, timeoutMs);

      this.drainResolvers.push(onDrained);
    });
  }

  /** Mark shutdown started and coordinate closing HTTP server, SSE streams, and waiting for drain. */
  async initiateShutdown(server: Server, options: ShutdownOptions = {}): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const timeoutMs = options.timeoutMs ?? 25_000;

    console.log(`[shutdown] Initiating graceful shutdown (drain timeout: ${timeoutMs}ms)...`);

    // 1. Notify external lifecycle hook (stop watchers, indexer, etc.)
    if (options.onDrainStart) {
      try {
        await options.onDrainStart();
      } catch (err) {
        console.error("[shutdown] onDrainStart hook error:", err);
      }
    }

    // 2. Stop accepting new HTTP connections
    server.close();

    // 3. Close open SSE connections with retry hints
    this.closeSseClients();

    // 4. Wait for in-flight requests and submissions to finish
    await this.waitForDrain(timeoutMs);

    // 5. Final cleanup hook (close db, redis, locks)
    if (options.onDrainComplete) {
      try {
        await options.onDrainComplete();
      } catch (err) {
        console.error("[shutdown] onDrainComplete hook error:", err);
      }
    }

    console.log("[shutdown] Graceful shutdown completed.");
  }

  /** Reset internal state (used by test suites). */
  resetForTests(): void {
    this.shuttingDown = false;
    this.inFlightRequests = 0;
    this.inFlightSubmissions = 0;
    this.sseClients.clear();
    this.drainResolvers = [];
  }
}

export const shutdownManager = new ShutdownManager();
