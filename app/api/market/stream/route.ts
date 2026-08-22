import { getMarketRuntime } from "@/lib/market/runtime";
import { parseViewQuery, parseViewerId } from "@/lib/market/query";

// Streams one page of the live market to the browser. The websockets to the venues
// live on the server, so every tab shares one set of upstream connections — and one
// serialised frame per store version per distinct view, built by the runtime rather
// than here.
//
// Each push also renews this connection's Book Focus lease, which is what keeps bid/ask
// subscribed for the rows on screen. Renewing on push rather than on connect means a
// client that stops reading releases its quotes without having to say goodbye, which a
// closed laptop lid never does.
//
// This endpoint is public and unauthenticated, which is fine for public market data.
// Do not extend it to anything key-derived without adding auth first.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUSH_INTERVAL_MS = 1_000;

const KEEPALIVE = new TextEncoder().encode(": keepalive\n\n");

export async function GET(request: Request) {
  const market = getMarketRuntime();
  const url = new URL(request.url);
  const query = parseViewQuery(url);
  const viewerId = parseViewerId(url);

  let closed = false;
  let tick: NodeJS.Timeout | null = null;

  /**
   * Closes down exactly once, from whichever of the three paths gets there first:
   * the request aborting, the stream being cancelled, or an enqueue failing
   * because the client is already gone.
   *
   * The timer is cleared here and nowhere else, and this lives outside the stream
   * source so `cancel()` can reach it. An earlier version cleared it only on
   * abort, so a stream cancelled without an abort — or a failed enqueue, which set
   * a `closed` flag but left the interval running — kept a 1 Hz timer building and
   * serialising a full snapshot forever for a client that no longer existed. That
   * is the one defect here that grew with uptime rather than with load: every
   * reload or proxy timeout could add another.
   *
   * The focus lease is dropped here too. It would expire on its own within a minute,
   * but releasing it now means closing a tab stops its order-book subscriptions
   * immediately rather than at the end of the TTL.
   */
  const cleanup = (controller?: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    if (tick) clearInterval(tick);
    tick = null;
    market.releaseViewer(viewerId);
    try {
      controller?.close();
    } catch {
      // Already closed by the platform.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastVersion = -1;

      /** Enqueues bytes, treating any failure as the client having gone away. */
      const push = (bytes: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(bytes);
        } catch {
          cleanup(controller);
        }
      };

      // First frame is always a full view so a fresh tab renders at once.
      const first = market.viewFrame(viewerId, query);
      lastVersion = first.version;
      push(first.bytes);

      tick = setInterval(() => {
        if (closed) return;
        const frame = market.viewFrame(viewerId, query);
        if (frame.version === lastVersion) {
          // Comment frame keeps proxies from closing an idle connection.
          push(KEEPALIVE);
          return;
        }
        lastVersion = frame.version;
        push(frame.bytes);
      }, PUSH_INTERVAL_MS);

      request.signal.addEventListener("abort", () => cleanup(controller));
    },
    cancel() {
      // The platform can cancel a stream without aborting the request signal, so
      // this is not redundant with the abort listener above. No controller here —
      // the stream is already being torn down; only the timer needs clearing.
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy buffering so events arrive promptly.
      "x-accel-buffering": "no",
    },
  });
}
