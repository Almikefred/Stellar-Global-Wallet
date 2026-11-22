/**
 * Real loopback TCP / HTTP fault-injection proxy (#234).
 *
 * Used by `chaosResilience.test.ts` (which runs in standard PR `npm test`)
 * to inject real kernel-level TCP faults — connection refusal (partition),
 * TCP RST (`resetAndDestroy`), silent blackhole timeouts, latency spikes,
 * and HTTP 502/503/504 responses — without requiring Docker or external hosts.
 */

import http from "node:http";
import net from "node:net";

export type FaultMode =
  | { type: "ok" }
  | { type: "partition" }
  | { type: "reset_peer"; delayMs?: number }
  | { type: "latency"; delayMs: number }
  | { type: "timeout" }
  | { type: "http_status"; status: 502 | 503 | 504; delayMs?: number };

export class LocalTcpFaultProxy {
  private server: net.Server | null = null;
  private activeSockets = new Set<net.Socket>();
  private mode: FaultMode = { type: "ok" };
  private _port = 0;
  public connectionCount = 0;

  constructor(
    private readonly upstreamHost: string,
    private readonly upstreamPort: number
  ) {}

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  setMode(mode: FaultMode): void {
    this.mode = mode;
    // Always tear down existing keep-alive sockets on mode transitions so
    // pooled HTTP/1.1 connections never bypass the newly configured fault mode.
    for (const sock of this.activeSockets) {
      if (mode.type === "reset_peer" && typeof sock.resetAndDestroy === "function") {
        sock.resetAndDestroy();
      } else {
        sock.destroy();
      }
    }
    this.activeSockets.clear();
  }

  resetStats(): void {
    this.connectionCount = 0;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = net.createServer((clientSocket) => {
      this.connectionCount += 1;
      this.activeSockets.add(clientSocket);
      clientSocket.on("close", () => this.activeSockets.delete(clientSocket));
      clientSocket.on("error", () => undefined);

      const currentMode = this.mode;

      if (currentMode.type === "partition") {
        clientSocket.destroy();
        return;
      }

      if (currentMode.type === "reset_peer") {
        const triggerReset = () => {
          if (typeof clientSocket.resetAndDestroy === "function") {
            clientSocket.resetAndDestroy();
          } else {
            clientSocket.destroy();
          }
        };
        if (currentMode.delayMs && currentMode.delayMs > 0) {
          setTimeout(triggerReset, currentMode.delayMs).unref();
        } else {
          // Wait for first byte from client so TCP RST happens mid-request.
          clientSocket.once("data", triggerReset);
        }
        return;
      }

      if (currentMode.type === "timeout") {
        // Silent TCP blackhole: accept the socket and never write a byte.
        return;
      }

      if (currentMode.type === "http_status") {
        clientSocket.once("data", () => {
          const sendError = () => {
            if (clientSocket.destroyed) return;
            const body = JSON.stringify({ status: currentMode.status, title: "Injected Chaos Error" });
            clientSocket.end(
              `HTTP/1.1 ${currentMode.status} Chaos Injected\r\n` +
                `Content-Type: application/json\r\n` +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                `Connection: close\r\n\r\n${body}`
            );
          };
          if (currentMode.delayMs && currentMode.delayMs > 0) {
            setTimeout(sendError, currentMode.delayMs).unref();
          } else {
            sendError();
          }
        });
        return;
      }

      const connectUpstream = () => {
        if (clientSocket.destroyed) return;
        const upstreamSocket = net.createConnection(
          { host: this.upstreamHost, port: this.upstreamPort },
          () => {
            clientSocket.pipe(upstreamSocket);
            upstreamSocket.pipe(clientSocket);
          }
        );
        this.activeSockets.add(upstreamSocket);
        upstreamSocket.on("close", () => this.activeSockets.delete(upstreamSocket));
        upstreamSocket.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstreamSocket.destroy());
      };

      if (currentMode.type === "latency") {
        setTimeout(connectUpstream, currentMode.delayMs).unref();
      } else {
        connectUpstream();
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr !== "string") {
          this._port = addr.port;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const sock of this.activeSockets) {
      sock.destroy();
    }
    this.activeSockets.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

/**
 * Helper to obtain an unused closed loopback port (guarantees immediate
 * kernel `ECONNREFUSED` for partition tests).
 */
export async function getRefusedPort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const addr = srv.address();
  const port = addr && typeof addr !== "string" ? addr.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}
