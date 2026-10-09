// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { summarizeArticle } from "../worldmonitor/news/v1/summarize-article";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeContext(headers: Record<string, string> = {}) {
  return {
    request: new Request("https://www.worldmonitor.app/api/news/v1/summarize-article", { headers }),
    pathParams: {},
    headers,
  };
}

function request(mode = "brief", provider = "openrouter") {
  return {
    provider,
    headlines: ["Headline one", "Headline two"],
    mode,
    geoContext: "",
    variant: "full",
    lang: "en",
    systemAppend: "",
    bodies: [],
  };
}

beforeEach(() => {
  restoreEnv();
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  globalThis.fetch = vi.fn(async () => {
    throw new Error("retired summaries must not call providers or Redis");
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe("summarizeArticle public-only mode boundary", () => {
  test("anonymous article summaries are rejected before provider fetch", async () => {
    await expect(summarizeArticle(makeContext(), request("brief"))).rejects.toMatchObject({
      statusCode: 403,
      code: "feature_removed",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("anonymous analysis mode is rejected before provider fetch", async () => {
    await expect(summarizeArticle(
      makeContext({ "X-WorldMonitor-Key": "wms_basic_session" }),
      request("analysis"),
    )).rejects.toMatchObject({ statusCode: 403, code: "feature_removed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("translation mode remains public", async () => {
    delete process.env.OPENROUTER_API_KEY;

    const result = await summarizeArticle(makeContext(), request("translate"));

    expect(result).toMatchObject({
      fallback: true,
      status: "SUMMARIZE_STATUS_SKIPPED",
      statusDetail: "OPENROUTER_API_KEY not configured",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("operator credentials cannot re-enable retired summaries even without provider configuration", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.WORLDMONITOR_VALID_KEYS = "enterprise-test-key";

    await expect(summarizeArticle(
      makeContext({ "X-WorldMonitor-Key": "enterprise-test-key" }),
      request("brief"),
    )).rejects.toMatchObject({ statusCode: 403, code: "feature_removed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("a stale client naming groq is skipped without a provider fetch (#8885)", async () => {
    process.env.GROQ_API_KEY = "stale-groq-key";

    const result = await summarizeArticle(makeContext(), request("translate", "groq"));

    expect(result).toMatchObject({
      summary: "",
      provider: "groq",
      fallback: true,
      status: "SUMMARIZE_STATUS_SKIPPED",
      statusDetail: "Unknown provider: groq",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
