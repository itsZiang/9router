/**
 * chatCore per-request API-key health updater (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Byte-identical extraction of the `recordKeyHealthStatus` closure that lived at the top of
 * handleChatCore. Translates an upstream HTTP status into the in-memory key-health state
 * (apiKeyRotator) for the connection's currently-selected key, and persists the change to the
 * provider connection so it survives process restarts:
 *   - 401 → record a failure (warning, then invalid at the threshold), always persisted.
 *   - 402 → terminal (insufficient balance); mark the current key invalid immediately (#5239),
 *           persisted on the active→invalid transition.
 *   - 2xx → record a success, persisted only when recovering from a warning/invalid state.
 * Any other status only refreshes the tracked extra-key set. The handler binds its `log` once and
 * delegates here, keeping the existing call sites unchanged.
 */

import { recordKeyFailure, recordKeySuccess, recordKeyTerminal, trackConnectionExtraKeys } from "../../services/apiKeyRotator";
// Real SQLite repo (NOT the no-op stub) — see chatCore.js import note.
// apiKeyHealth persists must actually write to the DB.
import { updateProviderConnection } from "@/lib/localDb";
import { isCreditsExhausted } from "../../services/accountFallback";

/**
 * Persist the updated health for the current key to the provider connection's
 * providerSpecificData.apiKeyHealth. Shared by every terminal/failure branch.
 */
function persistKeyHealth(connId, psd, health, currentKeyId, prevStatus, updatedHealth, log) {
  if (updatedHealth.status === prevStatus) return;
  updateProviderConnection(connId, {
    providerSpecificData: {
      ...psd,
      apiKeyHealth: {
        ...health,
        [currentKeyId]: updatedHealth
      }
    }
  }).catch(err => {
    log?.error?.("DB", `Failed to persist apiKeyHealth: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function recordKeyHealthStatus(status, creds, log, opts = {}) {
  const connId = creds?.connectionId;
  if (!connId) return;
  const psd = creds.providerSpecificData;
  const extraKeys = psd?.extraApiKeys ?? [];
  const health = psd?.apiKeyHealth;
  const currentKeyId = psd?.selectedKeyId ?? "primary";
  trackConnectionExtraKeys(connId, extraKeys);
  if (status === 401) {
    const updatedHealth = recordKeyFailure(connId, currentKeyId);
    log?.warn?.("AUTH", `401 on connection ${connId.slice(0, 8)} - key marked as failed (failure #${updatedHealth.failures})`);

    // Persist health status to DB on every failure (not just invalid transitions)
    // This ensures in-memory state survives process restarts
    const prevStatus = health?.[currentKeyId]?.status;
    const prevFailures = health?.[currentKeyId]?.failures ?? 0;
    if (updatedHealth.status !== prevStatus || updatedHealth.failures !== prevFailures) {
      updateProviderConnection(connId, {
        providerSpecificData: {
          ...psd,
          apiKeyHealth: {
            ...health,
            [currentKeyId]: updatedHealth
          }
        }
      }).catch(err => {
        log?.error?.("DB", `Failed to persist apiKeyHealth: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } else if (status === 402 || (status === 403 && isCreditsExhausted(opts.errorBody || ""))) {
    // 402 "Insufficient account balance" — or 403 carrying a credits-exhausted
    // body ("balance is insufficient", "insufficient balance", …) — is terminal
    // for this key: the balance won't recover mid-session, so mark the current
    // key invalid immediately (don't wait for FAILURE_THRESHOLD) so the rotator
    // stops returning it. SiliconFlow and other OpenAI-compatible providers
    // return 403 (not 402) for depleted accounts, so we route on the body text.
    const updatedHealth = recordKeyTerminal(connId, currentKeyId);
    log?.error?.("AUTH", `${status} on connection ${connId.slice(0, 8)} - key ${currentKeyId} marked invalid (insufficient balance)`);
    const prevStatus = health?.[currentKeyId]?.status;
    persistKeyHealth(connId, psd, health, currentKeyId, prevStatus, updatedHealth, log);
  } else if (status >= 200 && status < 300) {
    const updatedHealth = recordKeySuccess(connId, currentKeyId);
    const prevStatus = health?.[currentKeyId]?.status;
    if (prevStatus === "warning" || prevStatus === "invalid") {
      updateProviderConnection(connId, {
        providerSpecificData: {
          ...psd,
          apiKeyHealth: {
            ...health,
            [currentKeyId]: updatedHealth
          }
        }
      }).catch(err => {
        log?.error?.("DB", `Failed to persist apiKeyHealth: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
}