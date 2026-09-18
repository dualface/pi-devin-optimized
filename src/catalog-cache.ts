import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DevinCatalog } from "./models.js";

const CACHE_VERSION = 1;

export const CATALOG_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface CachedDevinCatalog {
  catalog: DevinCatalog;
  fetchedAt: number;
}

interface CatalogCacheFile extends CachedDevinCatalog {
  version: typeof CACHE_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCatalog(value: unknown): value is DevinCatalog {
  if (!isRecord(value) || !Array.isArray(value.families)) return false;
  return value.families.every((family) =>
    isRecord(family)
    && typeof family.family_label === "string"
    && typeof family.family_uid === "string"
    && typeof family.slug === "string"
    && Array.isArray(family.variants)
    && family.variants.every((variant) =>
      isRecord(variant)
      && typeof variant.model_uid === "string"
      && typeof variant.label === "string"
    )
  );
}

export function catalogCachePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const cacheRoot = env.XDG_CACHE_HOME || join(home, ".cache");
  return join(cacheRoot, "pi-devin-local", "models.json");
}

export function readCatalogCache(path: string = catalogCachePath()): CachedDevinCatalog | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(parsed)
    || parsed.version !== CACHE_VERSION
    || typeof parsed.fetchedAt !== "number"
    || !Number.isFinite(parsed.fetchedAt)
    || !isCatalog(parsed.catalog)
  ) {
    throw new Error(`Invalid Devin model catalog cache: ${path}`);
  }
  return { catalog: parsed.catalog, fetchedAt: parsed.fetchedAt };
}

export function writeCatalogCache(
  catalog: DevinCatalog,
  path: string = catalogCachePath(),
  fetchedAt: number = Date.now(),
): void {
  if (!isCatalog(catalog)) throw new Error("Refusing to cache an invalid Devin model catalog");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${fetchedAt}.tmp`;
  const body: CatalogCacheFile = { version: CACHE_VERSION, fetchedAt, catalog };
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function isCatalogCacheFresh(
  cached: CachedDevinCatalog,
  now: number = Date.now(),
  maxAgeMs: number = CATALOG_CACHE_MAX_AGE_MS,
): boolean {
  const age = now - cached.fetchedAt;
  return age >= 0 && age <= maxAgeMs;
}
