import type { LiveAccountSnapshot } from "@/lib/types";
import { PrivateWsManager } from "@/lib/private/ws-manager";
import { liveSnapshot } from "@/lib/db/live";

/**
 * Long-lived private-stream runtime.
 *
 * Starts lazily on the first account request, so no authenticated connection is
 * opened until something actually needs live data. Like the market runtime, it
 * needs a process that stays alive and will not work on serverless.
 */
class LiveRuntime {
  private readonly ws = new PrivateWsManager();
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.ws.sync();
    // Re-sync periodically so credentials added or removed in Settings take
    // effect without restarting the server.
    this.timer = setInterval(() => this.ws.sync(), 30_000);
  }

  /** Called after a credential change so the streams react immediately. */
  resync(): void {
    this.ws.sync();
  }

  snapshot(): LiveAccountSnapshot {
    return liveSnapshot(this.ws.statuses());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws.stop();
    this.started = false;
  }
}

// Survive dev-server hot reloads; otherwise each recompile would open a second
// set of authenticated sockets and leak the first.
const globalRef = globalThis as typeof globalThis & {
  __frwLiveRuntime?: LiveRuntime;
};

export function getLiveRuntime(): LiveRuntime {
  if (!globalRef.__frwLiveRuntime) {
    globalRef.__frwLiveRuntime = new LiveRuntime();
  }
  const runtime = globalRef.__frwLiveRuntime;
  runtime.start();
  return runtime;
}
