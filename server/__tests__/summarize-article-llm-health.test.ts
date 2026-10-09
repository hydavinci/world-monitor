// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { __testing__ as llmHealth, getLlmHealthStatus, getLlmModelHealthStatus, isModelUsable, recordModelFailure } from "../_shared/llm-health";
import { summarizeArticle } from "../worldmonitor/news/v1/summarize-article";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeContext() {
  const headers = { "X-WorldMonitor-Key": "enterprise-test-key" };
  return {
    request: new Request("https://www.worldmonitor.app/api/news/v1/summarize-article", { headers }),
    pathParams: {},
    headers,
  };
}

function request(provider: "openrouter" | "ollama", headline: string) {
  return {
    provider,
    headlines: [headline],
    mode: "translate",
    geoContext: "",
    variant: "full",
    lang: "en",
    systemAppend: "",
    bodies: [],
  };
}

beforeEach(() => {
  restoreEnv();
  llmHealth.reset();
  process.env.OPENROUTER_API_KEY = "or-test-key";
  process.env.OLLAMA_API_URL = "http://localhost:11434";
  process.env.WORLDMONITOR_VALID_KEYS = "enterprise-test-key";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  llmHealth.reset();
  restoreEnv();
});

describe("summarizeArticle public translation model health fallback", () => {
  test("a quarantined provider does not poison the provider-independent translation cache", async () => {
    const redis = new Map<string, string>();
    const providerPosts: string[] = [];
    let redisSetCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || "GET";

      if (url.startsWith("https://redis.test/get/")) {
        const key = decodeURIComponent(url.slice("https://redis.test/get/".length));
        return new Response(JSON.stringify({ result: redis.get(key) ?? null }), { status: 200 });
      }

      if (url === "https://redis.test/" && method === "POST") {
        const command: string[] = JSON.parse(String(init?.body || "[]"));
        expect(command[0]).toBe("SET");
        redis.set(command[1], command[2]);
        redisSetCount += 1;
        return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      }

      if (method === "GET") return new Response("", { status: 200 });

      if (url.includes("/chat/completions")) {
        providerPosts.push(url);
        const body: { model?: string } = JSON.parse(String(init?.body || "{}"));
        if (url.includes("openrouter.ai")) {
          return new Response(JSON.stringify({
            error: { message: `${body.model} is not a valid model ID` },
          }), { status: 400 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Ollama provides a healthy fallback summary for this headline." } }],
          usage: { total_tokens: 9 },
        }), { status: 200 });
      }

      throw new Error(`Unexpected outbound request: ${method} ${url}`);
    };

    for (const headline of ["First rejected model request", "Second rejected model request"]) {
      const rejected = await summarizeArticle(makeContext(), request("openrouter", headline));
      expect(rejected.status).toBe("SUMMARIZE_STATUS_ERROR");

      const immediateFallback = await summarizeArticle(makeContext(), request("ollama", headline));
      expect(immediateFallback).toMatchObject({
        summary: "Ollama provides a healthy fallback summary for this headline.",
        provider: "ollama",
        status: "SUMMARIZE_STATUS_SUCCESS",
      });
    }

    const sharedHeadline = "Fallback after model quarantine";
    const setsBeforeQuarantineSkip = redisSetCount;
    const quarantined = await summarizeArticle(makeContext(), request("openrouter", sharedHeadline));
    expect(quarantined.status).toBe("SUMMARIZE_STATUS_ERROR");
    expect(isModelUsable(
      "https://openrouter.ai/api/v1/chat/completions",
      "deepseek/deepseek-v4-flash",
    )).toBe(false);
    expect(redisSetCount).toBe(
      setsBeforeQuarantineSkip,
      "skipping a quarantined provider must not write a negative cache sentinel",
    );

    const fallback = await summarizeArticle(makeContext(), request("ollama", sharedHeadline));
    expect(fallback).toMatchObject({
      summary: "Ollama provides a healthy fallback summary for this headline.",
      provider: "ollama",
      fallback: false,
      status: "SUMMARIZE_STATUS_SUCCESS",
    });
    const cached = await summarizeArticle(makeContext(), request("openrouter", sharedHeadline));
    expect(cached).toMatchObject({
      summary: "Ollama provides a healthy fallback summary for this headline.",
      provider: "cache",
      tokens: 0,
      fallback: false,
      status: "SUMMARIZE_STATUS_CACHED",
    });
    expect(redisSetCount).toBe(3);
    expect(providerPosts.filter(url => url.includes("openrouter.ai"))).toHaveLength(2);
    expect(providerPosts.filter(url => url.startsWith("http://localhost:11434/"))).toHaveLength(3);
  });

  test("an accepted but empty translation resets the rejection streak without caching a failure", async () => {
    const redis = new Map<string, string>();
    let providerPostCount = 0;
    let redisSetCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || "GET";

      if (url.startsWith("https://redis.test/get/")) {
        const key = decodeURIComponent(url.slice("https://redis.test/get/".length));
        return new Response(JSON.stringify({ result: redis.get(key) ?? null }), { status: 200 });
      }
      if (url === "https://redis.test/" && method === "POST") {
        const command: string[] = JSON.parse(String(init?.body || "[]"));
        redis.set(command[1], command[2]);
        redisSetCount += 1;
        return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      }
      if (method === "GET") return new Response("", { status: 200 });
      if (!url.includes("openrouter.ai")) {
        throw new Error(`Unexpected outbound request: ${method} ${url}`);
      }

      providerPostCount += 1;
      const body: { model?: string } = JSON.parse(String(init?.body || "{}"));
      if (providerPostCount === 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "" } }],
          usage: { total_tokens: 2 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { message: `${body.model} is not a valid model ID` },
      }), { status: 400 });
    };

    for (const headline of ["first rejection", "accepted invalid output", "second rejection"]) {
      const result = await summarizeArticle(makeContext(), request("openrouter", headline));
      expect(result.status).toBe("SUMMARIZE_STATUS_ERROR");
    }

    expect(providerPostCount).toBe(3);
    expect(redisSetCount).toBe(0);
    expect(isModelUsable(
      "https://openrouter.ai/api/v1/chat/completions",
      "deepseek/deepseek-v4-flash",
    )).toBe(true);
  });

  test.each(["brief", "analysis", "", "unknown"])(
    "retired mode %j denies before Redis, provider probes, completions, or model health changes",
    async (mode) => {
      const apiUrl = "https://openrouter.ai/api/v1/chat/completions";
      const model = "deepseek/deepseek-v4-flash";
      recordModelFailure(apiUrl, model, 400, `${model} is not a valid model ID`);
      recordModelFailure(apiUrl, model, 400, `${model} is not a valid model ID`);
      const healthBefore = getLlmModelHealthStatus();
      const fetch = vi.fn(async () => {
        throw new Error("retired mode must not perform outbound I/O");
      });
      globalThis.fetch = fetch;

      for (const req of [
        request("openrouter", "Retired summary must not be cached"),
        request("ollama", "Retired summary must not be cached"),
      ]) {
        await expect(summarizeArticle(makeContext(), {
          ...req,
          mode,
        })).rejects.toMatchObject({ statusCode: 403, code: "feature_removed" });
      }

      expect(fetch).not.toHaveBeenCalled();
      expect(getLlmHealthStatus()).toEqual({});
      expect(getLlmModelHealthStatus()).toEqual(healthBefore);
    },
  );
});
