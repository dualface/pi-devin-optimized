import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG_RETRY_ATTEMPTS,
  CATALOG_RETRY_DELAY_MS,
  withRetry,
} from "../src/catalog-retry.ts";
import { FALLBACK_MODELS } from "../src/models.ts";

function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

test("returns the first successful result without waiting", async () => {
  const { waits, sleep } = recorder();
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return "catalog";
  }, { sleep });
  assert.equal(result, "catalog");
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("retries up to three times, thirty seconds apart", async () => {
  const { waits, sleep } = recorder();
  const failures: number[] = [];
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new Error(`attempt ${calls} failed`);
    }, { sleep, onAttemptFailed: (_error, attempt) => failures.push(attempt) }),
    /attempt 3 failed/,
  );
  assert.equal(calls, CATALOG_RETRY_ATTEMPTS);
  assert.deepEqual(failures, [1, 2, 3]);
  // No wait after the final attempt.
  assert.deepEqual(waits, [CATALOG_RETRY_DELAY_MS, CATALOG_RETRY_DELAY_MS]);
});

test("stops as soon as an attempt succeeds", async () => {
  const { waits, sleep } = recorder();
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 2) throw new Error("devin models list exited 1");
    return "catalog";
  }, { sleep });
  assert.equal(result, "catalog");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [CATALOG_RETRY_DELAY_MS]);
});

test("honours custom attempt counts and delays", async () => {
  const { waits, sleep } = recorder();
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw new Error("offline");
  }, { attempts: 2, delayMs: 5, sleep }));
  assert.equal(calls, 2);
  assert.deepEqual(waits, [5]);
});

test("always runs at least one attempt", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw new Error("nope");
  }, { attempts: 0, sleep: async () => {} }));
  assert.equal(calls, 1);
});

test("the fallback list still covers swe-2 when the catalog is unreachable", () => {
  const swe2 = FALLBACK_MODELS.find((model) => model.id === "swe-2");
  assert.ok(swe2, "swe-2 must survive in the fallback list");
  assert.equal(swe2.reasoning, true);
  assert.deepEqual(swe2.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: "swe-2-medium",
    high: "swe-2-high",
    xhigh: null,
    max: "swe-2-max",
  });
});
