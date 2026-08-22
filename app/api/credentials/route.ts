import { requireAuth } from "@/lib/auth/guard";
import { privateAdapter } from "@/lib/private";
import {
  accountSupported,
  credentialKind,
  credentialStatuses,
  deleteCredentials,
  encryptionAvailable,
  getCredentials,
  recordVerification,
  requiresPassphrase,
  saveCredentials,
  setCredentialEnabled,
} from "@/lib/db/credentials";
import { recordAudit } from "@/lib/db/audit";
import { clearLiveVenue } from "@/lib/db/live";
import { getLiveRuntime } from "@/lib/private/runtime";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  optionalExactString,
  optionalString,
  requireBoolean,
  requireExchange,
  requireString,
} from "@/lib/api/validate";

/**
 * Credential management.
 *
 * Write-only by design: GET returns status and a 4-character key tail, never a
 * secret — not even encrypted. There is deliberately no endpoint that can read
 * a stored secret back out.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    return jsonOk({
      credentials: credentialStatuses(),
      // Tells the UI whether the DB path is usable at all.
      encryptionAvailable: encryptionAvailable(),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const action = typeof parsed.action === "string" ? parsed.action : "save";
    const exchange = requireExchange(parsed.exchange);

    if (action === "delete") {
      deleteCredentials(exchange);
      // Cached positions and balances came from a key that no longer exists, so
      // leaving them would show a stale account as if it were current.
      clearLiveVenue(exchange);
      recordAudit({ action: "credentials.delete", exchange, outcome: "deleted" });
      getLiveRuntime().resync();
      return jsonOk({ credentials: credentialStatuses() });
    }

    if (action === "toggle") {
      const enabled = requireBoolean(parsed.enabled);
      setCredentialEnabled(exchange, enabled);
      recordAudit({
        action: "credentials.toggle",
        exchange,
        payload: { enabled },
        outcome: enabled ? "enabled" : "disabled",
      });
      getLiveRuntime().resync();
      return jsonOk({ credentials: credentialStatuses() });
    }

    if (action === "verify") {
      const creds = getCredentials(exchange);
      if (!creds) return jsonError(`No credentials configured for ${exchange}`, 404);
      const adapter = privateAdapter(exchange);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        // A real authenticated call, so a bad key or missing permission is
        // reported now rather than at order time.
        await adapter.verify(creds, controller.signal);
        recordVerification(exchange, true);
        recordAudit({ action: "credentials.verify", exchange, outcome: "ok" });
        return jsonOk({ ok: true, credentials: credentialStatuses() });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        recordVerification(exchange, false, detail);
        recordAudit({ action: "credentials.verify", exchange, outcome: "failed", error: detail });
        return jsonOk({ ok: false, error: detail, credentials: credentialStatuses() });
      } finally {
        clearTimeout(timer);
      }
    }

    // action === "save"
    if (!accountSupported(exchange)) {
      // Refused at the route as well as in the storage layer: a credential for a
      // venue nothing can authenticate against is pure liability, and for a DEX
      // that liability is an unrevocable wallet key.
      return jsonError(
        `${exchange} account access is not implemented in this app, so a credential for it would be unusable. Market data works without one.`,
        400,
      );
    }
    if (!encryptionAvailable()) {
      return jsonError(
        "APP_PASSWORD is not set on the server, so credentials cannot be encrypted. Set it in .env.local and restart.",
        503,
      );
    }

    const kind = credentialKind(exchange);
    // For a CEX this is the API key; for a DEX it is the public wallet address.
    // Both are the venue-visible identifier, so they share the field.
    const apiKey = requireString(parsed.apiKey, kind === "dex" ? "walletAddress" : "apiKey", 200);

    if (kind === "dex" && !/^0x[0-9a-fA-F]{40}$/.test(apiKey)) {
      return jsonError("Wallet address must be 0x followed by 40 hex characters.", 400);
    }

    /**
     * The secret is optional for a wallet-signed venue and required for an
     * API-key one.
     *
     * A wallet address alone is enough to read positions and balances on
     * Hyperliquid, and that is a genuinely useful configuration: it exposes
     * nothing, because a public address cannot authorise anything. Demanding a
     * private key to watch an account would push operators into handing over more
     * than the task needs.
     *
     * Aster is the exception and is checked below: it has no public account
     * endpoint, so an address without a key would store a credential that fails on
     * every call.
     */
    const apiSecret =
      kind === "dex"
        ? optionalExactString(parsed.apiSecret, "privateKey", 200) ?? ""
        : requireString(parsed.apiSecret, "apiSecret", 400);

    if (exchange === "aster" && !apiSecret) {
      return jsonError(
        "Aster needs the API wallet private key as well as the account address: it has no public " +
          "account endpoint, so even reading positions requires a signature.",
        400,
      );
    }
    const passphrase =
      kind === "cex" && requiresPassphrase(exchange)
        ? requireString(parsed.passphrase, "passphrase", 200)
        : undefined;
    const label = optionalString(parsed.label, 60) ?? null;
    const readOnly = requireBoolean(parsed.readOnly, true);
    const enabled = requireBoolean(parsed.enabled, true);

    saveCredentials({ exchange, apiKey, apiSecret, passphrase, label, readOnly, enabled });
    // Payload is redacted by the audit layer, so no secret is recorded.
    recordAudit({
      action: "credentials.save",
      exchange,
      payload: { kind, readOnly, enabled, signing: apiSecret.length > 0 },
      outcome: "saved",
    });
    getLiveRuntime().resync();

    return jsonOk({ credentials: credentialStatuses() });
  } catch (err) {
    return handleRouteError(err);
  }
}
