import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { authStatus, ensureCredentials, loginWithCli, readCredentials } from "../src/credentials.js";
import { readDevinDesktopApiKey } from "../src/desktop-auth.js";
import { whichDevin, devinVersion } from "../src/cli.js";
import {
  type CachedDevinCatalog,
  isUsableCatalog,
  isCatalogCacheFresh,
  readCatalogCache,
  writeCatalogCache,
} from "../src/catalog-cache.js";
import { CATALOG_RETRY_ATTEMPTS, CATALOG_RETRY_DELAY_MS, type RetryOptions, withRetry } from "../src/catalog-retry.js";
import { type DevinCatalog, FALLBACK_MODELS, loadCliCatalog, modelsFromCatalog } from "../src/models.js";
import { CLIENT_IDE, CLIENT_VERSION } from "../src/metadata.js";
import { streamDevin } from "../src/stream.js";

const PROVIDER_ID = "devin";
const PLACEHOLDER_BASE_URL = "https://server.codeium.com";

let _pi: ExtensionAPI | null = null;
let catalogRequest: Promise<DevinCatalog> | null = null;

function isOffline(): boolean {
  const value = process.env.PI_OFFLINE?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchCatalogOnce(): Promise<DevinCatalog> {
  const catalog = await loadCliCatalog();
  if (!isUsableCatalog(catalog)) {
    throw new Error("Devin CLI returned no usable model families");
  }
  try {
    writeCatalogCache(catalog);
  } catch (error) {
    console.warn(`Devin: failed to cache model catalog: ${describe(error)}`);
  }
  return catalog;
}

/**
 * One in-flight catalog request at a time. A failed fetch is retried
 * `CATALOG_RETRY_ATTEMPTS` times, `CATALOG_RETRY_DELAY_MS` apart, so a single
 * flaky `devin models list` no longer costs the session its real model ids.
 */
function refreshCatalog(pi: ExtensionAPI, retry: RetryOptions = {}): Promise<ProviderModelConfig[]> {
  if (!catalogRequest) {
    const attempts = retry.attempts ?? CATALOG_RETRY_ATTEMPTS;
    const delayMs = retry.delayMs ?? CATALOG_RETRY_DELAY_MS;
    const pending = withRetry(fetchCatalogOnce, {
      ...retry,
      attempts,
      delayMs,
      onAttemptFailed: (error, attempt, attemptsLeft) => {
        const retryHint = attemptsLeft > 0
          ? ` Retrying in ${Math.round(delayMs / 1000)}s (${attemptsLeft} left).`
          : "";
        console.warn(`Devin: model catalog attempt ${attempt}/${attempts} failed: ${describe(error)}.${retryHint}`);
        retry.onAttemptFailed?.(error, attempt, attemptsLeft);
      },
    });
    catalogRequest = pending;
    void pending.finally(() => {
      if (catalogRequest === pending) catalogRequest = null;
    }).catch(() => {});
  }
  return catalogRequest.then((catalog) => {
    const models = modelsFromCatalog(catalog);
    registerDevinProvider(pi, models);
    return models;
  });
}

function registerDevinProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Devin Local",
    api: "devin-local",
    baseUrl: PLACEHOLDER_BASE_URL,
    models,
    oauth: {
      name: "Devin CLI",
      async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const creds = await loginWithCli();
        if (_pi) {
          try {
            await refreshCatalog(_pi);
          } catch {
            // keep current models
          }
        }
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const creds = readCredentials();
        if (!creds) return credentials;
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return readCredentials()?.apiKey || credentials.access;
      },
      modifyModels(models: Model<Api>[], _credentials: OAuthCredentials): Model<Api>[] {
        return models;
      },
    },
    streamSimple: streamDevin,
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  _pi = pi;
  let cached: CachedDevinCatalog | null | undefined;
  try {
    cached = readCatalogCache();
  } catch (error) {
    console.warn(`Devin: failed to read model catalog cache: ${describe(error)}`);
  }
  registerDevinProvider(pi, cached ? modelsFromCatalog(cached.catalog) : FALLBACK_MODELS);

  if (!isOffline()) {
    try {
      if (await ensureCredentials()) {
        if (!cached) {
          // No usable cache: the fallback list is the only thing standing in for
          // the real catalog, so wait out the retries before pi resolves --model.
          try {
            await refreshCatalog(pi);
          } catch (error) {
            console.warn(
              `Devin: model catalog unavailable after ${CATALOG_RETRY_ATTEMPTS} attempts: ${describe(error)}. `
              + "Falling back to a small built-in model list; run /devin-refresh once the Devin CLI works again.",
            );
          }
        } else if (!isCatalogCacheFresh(cached)) {
          // The cached catalog already carries the real model ids, so refresh it
          // in the background instead of holding up startup. keepAlive stays off
          // so a pending retry never delays quitting pi.
          void refreshCatalog(pi, { keepAlive: false }).catch((error) => {
            console.warn(`Devin: background model catalog refresh failed: ${describe(error)}. Using the cached catalog.`);
          });
        }
      } else {
        console.warn(
          "Devin: no credentials found (no CLI store, no Devin Desktop sign-in). "
          + "Run /login devin or `devin auth login` to load the real model catalog.",
        );
      }
    } catch (error) {
      console.warn(`Devin: model catalog startup failed: ${describe(error)}`);
    }
  }

  pi.registerCommand("devin-status", {
    description: "Show Devin CLI auth + binary status",
    handler: async (_args, ctx) => {
      const bin = await whichDevin();
      const version = await devinVersion();
      const status = await authStatus();
      const creds = readCredentials();
      const desktop = creds ? null : await readDevinDesktopApiKey();
      ctx.ui.notify(
        [
          bin ? `CLI: ${bin}` : "CLI: not found",
          version ? `CLI version: ${version}` : "CLI version: unknown",
          `Client identity: ${CLIENT_IDE} ${CLIENT_VERSION}`,
          creds
            ? `Credentials: ${creds.path}`
            : desktop
              ? `Credentials: none stored yet; Devin Desktop sign-in found at ${desktop.source}`
              : "Credentials: none found (no CLI store, no Devin Desktop sign-in)",
          status.loggedIn ? "Auth: signed in via Devin CLI" : "Auth: not signed in. Run /login devin or `devin auth login`",
        ].join("\n"),
        status.loggedIn && bin ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Refresh Devin Local model catalog from `devin models list`",
    handler: async (_args, ctx) => {
      try {
        // A user is watching this one: report the failure instead of sitting
        // through the startup retry schedule.
        const models = await refreshCatalog(pi, { attempts: 1 });
        ctx.ui.notify(`Devin: loaded ${models.length} families from the local CLI.`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Devin refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    _pi = null;
  });
}
