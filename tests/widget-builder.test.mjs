/**
 * Widget relay and retained local widgets — isolated runtime / static tests
 *
 * Covers:
 *   1. Relay security  — SSRF guard, auth gate, isPublicRoute, body limit, CORS
 *   2. Local widgets   — size limits, span-map cleanup, basic rendering
 *   3. Title regex     — hyphens in titles (bug fixed: [^\n\-] → [^\n])
 *   4. HTML sanitizer  — allowlist shape, forbidden tags, unsafe style strip
 *   5. Panel guardrails — cw- exclusion in UnifiedSettings, event-handlers
 *   6. SSE event types — html_complete, done, error, tool_call all present
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { transform } from 'esbuild';
import { unsafeRawHtml } from '../src/utils/sanitize.ts';
import widgetResponseParser from '../scripts/_widget-response-parser.cjs';
import { WIDGET_DATA_CATALOG, buildWidgetDataUrl } from '../scripts/_widget-data-policy.cjs';

const { parseWidgetAgentResponse } = widgetResponseParser;

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function src(relPath) {
  return readFileSync(resolve(root, relPath), 'utf-8');
}

describe('widget relay spend identity trust', () => {
  const relay = src('scripts/ais-relay.cjs');
  const functions = ['safeTokenEquals', 'getRelaySecretFromRequest', 'isAuthorizedRequest', 'handleWidgetAgentRequest']
    .map(name => {
      const match = relay.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
      assert.ok(match, `Missing ${name}`);
      return match[0];
    }).join('\n');

  for (const secret of ['server-only-secret', '']) {
    it(`trusts only server-authenticated spend IDs (secret configured: ${!!secret})`, async () => {
      const buckets = [];
      const context = {
        crypto, Buffer, RELAY_SHARED_SECRET: secret, RELAY_AUTH_HEADER: 'x-relay-key',
        ALLOW_UNAUTHENTICATED_RELAY: true,
        requireWidgetAgentAccess: () => ({ anthropicConfigured: true, admittedAs: 'pro' }),
        PRO_WIDGET_KEY: 'legacy-pro-key',
        readRequestBody: async () => '{"prompt":"Show markets","tier":"pro"}',
        checkProWidgetRateLimit: bucket => { buckets.push(bucket); return true; },
        safeEnd: (_res, status) => { assert.equal(status, 429); },
      };
      const run = vm.runInNewContext(`${functions}\nhandleWidgetAgentRequest`, context);
      for (const relayKey of [undefined, 'legacy-pro-key', 'wrong-secret', 'server-only-secret']) {
        for (const spendId of ['user:rotated-one', 'user:rotated-two']) {
          await run({ headers: {
            'x-pro-key': 'legacy-pro-key', 'x-wm-widget-spend-id': spendId,
            ...(relayKey ? { 'x-relay-key': relayKey } : {}),
          }, socket: { remoteAddress: '192.0.2.1' } }, {});
          assert.equal(buckets.at(-1), secret && relayKey === secret ? `id:${spendId}` : '192.0.2.1');
        }
      }
    });
  }
});

// The relay's Sonnet request settings, for harnesses that evaluate relay functions in isolation.
const widgetSonnetConstants = () => {
  const relay = src('scripts/ais-relay.cjs');
  const params = relay.match(/const WIDGET_SONNET_PARAMS = \{[\s\S]*?\n\};/);
  const headers = relay.match(/const WIDGET_SONNET_HEADERS = \{[^\n]*\};/);
  assert.ok(params && headers, 'Missing WIDGET_SONNET_PARAMS or WIDGET_SONNET_HEADERS');
  return `${params[0]}\n${headers[0]}`;
};

// Execute the production handler without the relay's unconditional server startup.
// Only the SDK import is substituted; requests, tool results and SSE use real code.
async function runWidgetAgent(responses, { tier = 'basic', failFetch = false, failSearch = false, sdkTransport = false, expireDuringFetch = false, sessionToken = 'wms_fixture', fetchStatus = 200, fetchBody = '{"value":42}', searchResults = [{ title: 'Fixture' }], pageText = 'page fixture', verdicts = [], hangOn = null, clock = null, request = {} } = {}) {
  const relay = src('scripts/ais-relay.cjs');
  const extract = name => {
    const match = relay.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `Missing relay function ${name}`);
    return match[0];
  };
  const requests = [], effects = [], logs = [], frames = [], fetchInits = [], invalidated = [], verifyCalls = [], modelSignals = [], modelOptions = [];
  let ended = 0;
  let expire, disconnect;
  // A hung call settles only through its abort signal; the guard fails a missing abort.
  const hang = signal => new Promise((_, reject) => {
    const guard = setTimeout(() => reject(new Error('model call was never aborted')), 300);
    signal?.addEventListener('abort', () => { clearTimeout(guard); reject(signal.reason); });
    if (hangOn === 'deadline') expire(); else disconnect();
  });
  const nextResponse = request => {
    requests.push(structuredClone(request));
    const response = responses[requests.length - 1];
    assert.ok(response, 'Unexpected extra model request');
    if (response instanceof Error) throw response;
    return structuredClone(response);
  };
  const context = {
    URL, AbortSignal, AbortController, clearTimeout, parseWidgetAgentResponse,
    ...(clock ? { Date: class extends Date { static now() { return clock(); } } } : {}),
    setTimeout: (callback, ms) => { expire = callback; return setTimeout(callback, ms); },
    console: { error: (...args) => logs.push(args), log: (...args) => logs.push(args) },
    requireWidgetAgentAccess: () => ({ anthropicConfigured: true, admittedAs: tier }),
    readRequestBody: async () => JSON.stringify({ prompt: 'Show earthquake data', tier, ...request }),
    checkProWidgetRateLimit: () => false, checkWidgetRateLimit: () => false,
    isWidgetInjectionAttempt: () => false,
    PRO_WIDGET_KEY: 'test', WIDGET_ANTHROPIC_KEY: 'test',
    WIDGET_PRO_MAX_HTML: 100000, WIDGET_MAX_HTML: 50000,
    WIDGET_PRO_SYSTEM_PROMPT: 'test', WIDGET_SYSTEM_PROMPT: 'test',
    buildWidgetDataUrl,
    performWidgetWebSearch: async query => {
      effects.push(`search:${query}`);
      if (failSearch) throw new Error('Search fixture failure');
      return { results: searchResults };
    },
    performWidgetPageRead: async url => {
      effects.push(`read:${url}`);
      return pageText === null ? null : { source: 'exa', text: pageText };
    },
    verifyWidgetAgainstSources: async (_client, input, options) => {
      verifyCalls.push({ ...input, signal: options?.signal });
      options?.onUsage?.({ input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 }, 'claude-sonnet-5-5');
      return verdicts.length ? verdicts.shift() : { rightDataset: true, datasetWhy: '', unsupported: [] };
    },
    fetch: async (url, init) => {
      effects.push(url);
      fetchInits.push(init);
      if (expireDuringFetch) expire();
      if (failFetch) throw new Error('Fetch fixture failure');
      return { status: fetchStatus, text: async () => (typeof fetchBody === 'function' ? fetchBody(url) : fetchBody) };
    },
    getWidgetDataSessionToken: async () => sessionToken,
    invalidateWidgetDataSession: token => invalidated.push(token),
    importAnthropic: async () => ({ default: sdkTransport ? class extends Anthropic {
      constructor(options) {
        super({ ...options, maxRetries: 0, fetch: async (_url, init) => {
          const request = JSON.parse(init.body);
          // The SDK serializes requests but does not enforce provider validation.
          // A tool exchange in history must retain its tool definitions.
          const hasToolHistory = request.messages.some(m => Array.isArray(m.content)
            && m.content.some(b => b.type === 'tool_use' || b.type === 'tool_result'));
          if (hasToolHistory && !request.tools?.length) {
            requests.push(request);
            return new Response(JSON.stringify({ type: 'error', error: {
              type: 'invalid_request_error', message: 'Tools must be defined when including tool_use or tool_result blocks.',
            } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({
            id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture',
            usage: { input_tokens: 1, output_tokens: 1 }, stop_sequence: null,
            ...nextResponse(request),
          }), { headers: { 'Content-Type': 'application/json' } });
        } });
      }
    } : class {
      messages = { create: async (request, options) => {
        modelSignals.push(options?.signal);
        modelOptions.push(options);
        if (hangOn && requests.length === responses.length) { requests.push(request); return hang(options?.signal); }
        return nextResponse(request);
      } };
    } }),
  };
  // Include production constants when present, so tests also run against the old loop.
  const limit = ['WIDGET_MAX_TOOL_CALLS', 'WIDGET_DRAFT_DELIVERY_RESERVE_MS'].map(name => relay.match(new RegExp(`const ${name} = [0-9_]+;`))?.[0] ?? '').join('\n');
  const toolDefinitions = ['WIDGET_FETCH_TOOL', 'WIDGET_SEARCH_TOOL', 'WIDGET_READ_TOOL'].map(name => {
    const match = relay.match(new RegExp(`const ${name} = \\{[^]*?\\n\\};`));
    assert.ok(match, `Missing ${name}`);
    return match[0];
  }).join('\n');
  const handler = extract('handleWidgetAgentRequest').replace("import('@anthropic-ai/sdk')", 'importAnthropic()');
  const run = vm.runInNewContext(`${limit}\n${widgetSonnetConstants()}\n${toolDefinitions}\n${extract('sendWidgetSSE')}\n${extract('filterWidgetToolInjection')}\n${extract('sanitizeToolContent')}\n${extract('compactWidgetToolJson')}\n${extract('formatWidgetVerifierFindings')}\n${extract('classifyWidgetAgentError')}\n${handler}\nhandleWidgetAgentRequest`, context);
  const res = {
    writableEnded: false, writeHead() {},
    write(frame) { frames.push(frame); },
    end() { ended++; this.writableEnded = true; },
  };
  // Node emits a disconnect on the response only; the request closed when its body was read.
  res.on = (event, cb) => { if (event === 'close') disconnect = () => { if (!res.writableEnded) cb(); }; };
  await run({ headers: {}, on() {}, socket: {} }, res);
  const events = frames.map(frame => JSON.parse(frame.match(/data: (.*)/)[1]));
  return { requests, effects, fetchInits, invalidated, verifyCalls, modelSignals, modelOptions, logs, events, ended };
}

const usageLine = result => JSON.parse(result.logs.find(args => args[0] === '[widget-agent] usage')[1]);
const widgetText = '<!-- title: Quakes --><!-- widget-html --><div>42</div><!-- /widget-html -->';
const widgetResponse = (stop_reason, content = [{ type: 'text', text: widgetText }]) => ({ stop_reason, content });
const widgetTool = (id, name = 'fetch_worldmonitor_data', input = { endpoint: '/api/news/v1/list-feed-digest' }) => ({ type: 'tool_use', id, name, input });
const toolResultsFor = request => request.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []);
function assertWidgetSuccess(result) {
  assert.deepEqual(result.events.filter(e => ['html_complete', 'done', 'error'].includes(e.type)).map(e => e.type), ['html_complete', 'done']);
  assert.equal(result.ended, 1);
}
function assertWidgetError(result, pattern) {
  const terminal = result.events.filter(e => ['html_complete', 'done', 'error'].includes(e.type));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, 'error');
  assert.match(terminal[0].message, pattern);
  assert.equal(result.ended, 1);
}

describe('widget-agent relay — model, caching and usage', () => {
  it('runs Pro on Sonnet 5.5 with adaptive thinking at low effort, loop caching and refusal fallback', async () => {
    const result = await runWidgetAgent([widgetResponse('tool_use', [widgetTool('1')]), widgetResponse('end_turn')], { tier: 'pro' });
    for (const [i, request] of result.requests.entries()) {
      assert.equal(request.model, 'claude-sonnet-5-5');
      assert.deepEqual(request.thinking, { type: 'adaptive' });
      assert.deepEqual(request.output_config, { effort: 'low' });
      assert.deepEqual(request.cache_control, { type: 'ephemeral' });
      assert.equal(request.fallbacks, 'default');
      assert.equal(result.modelOptions[i].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    }
  });

  it('keeps basic on Haiku, with loop caching but no Sonnet-only fields', async () => {
    const result = await runWidgetAgent([widgetResponse('end_turn')]);
    const [request] = result.requests;
    assert.equal(request.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(request.cache_control, { type: 'ephemeral' });
    assert.equal(request.thinking, undefined);
    assert.equal(request.fallbacks, undefined);
    assert.equal(result.modelOptions[0].headers, undefined);
  });

  it('only ever appends to the conversation, including when tools are switched off', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [1, 2, 3, 4].map(n => widgetTool(String(n)))),
      widgetResponse('max_tokens', [{ type: 'text', text: 'cut' }]),
      widgetResponse('end_turn'),
    ], { tier: 'pro' });
    assert.ok(result.requests.length >= 3);
    for (let i = 1; i < result.requests.length; i++) {
      const before = result.requests[i - 1].messages;
      assert.deepEqual(result.requests[i].messages.slice(0, before.length), before, `request ${i} rewrote earlier history`);
    }
    assert.match(JSON.stringify(result.requests.at(-1).messages), /Tools are now disabled/);
  });

  it('counts a refused attempt billed before a fallback, from usage.iterations, without double counting', async () => {
    const tokens = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });
    const result = await runWidgetAgent([{
      ...widgetResponse('end_turn'), model: 'claude-sonnet-5',
      usage: { ...tokens(20, 800, 5000, 3000), iterations: [{ ...tokens(500, 0, 0, 40), type: 'message' }, { ...tokens(20, 800, 5000, 3000), type: 'fallback_message' }] },
    }], { tier: 'pro' });
    assertWidgetSuccess(result);
    const line = usageLine(result);
    assert.deepEqual([line.input, line.cacheWrite, line.cacheRead, line.output], [520, 800, 5000, 3040]);
  });

  it('logs one usage line per request with the builder and source-check tokens summed', async () => {
    const usage = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });
    const result = await runWidgetAgent([
      { ...widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]), model: 'claude-sonnet-5-5', usage: usage(10, 5000, 0, 100) },
      { ...widgetResponse('end_turn'), model: 'claude-sonnet-5', usage: usage(20, 800, 5000, 3000) },
    ], { tier: 'pro', searchResults: [{ title: 'T', url: 'https://example.com/t' }] });
    assertWidgetSuccess(result);
    const lines = result.logs.filter(args => args[0] === '[widget-agent] usage');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0][1]), {
      model: 'claude-sonnet-5-5', servedBy: ['claude-sonnet-5-5', 'claude-sonnet-5'], calls: 3, input: 1030, cacheWrite: 5800, cacheRead: 5000, output: 3150, toolCalls: 1, outcome: 'complete',
    });
  });
});

describe('widget-agent relay — runtime tool budget and finalization', () => {
  it('executes only three of four calls in one response and returns every tool result', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [1, 2, 3, 4].map(n => widgetTool(String(n)))), widgetResponse('end_turn'),
    ]);
    assert.equal(result.effects.length, 3);
    const results = toolResultsFor(result.requests[1]);
    assert.deepEqual(results.map(r => r.tool_use_id), ['1', '2', '3', '4']);
    assert.equal(results[3].is_error, true);
    assert.match(results[3].content, /budget.*exhausted/i);
    assert.equal(result.requests[1].tool_choice.type, 'none');
    assertWidgetSuccess(result);
  });

  it('shares the budget across responses and both tools (4 once the web is used)', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1'), widgetTool('2', 'search_web', { query: 'quakes' })]),
      widgetResponse('tool_use', [widgetTool('3', 'search_web', { query: 'today' }), widgetTool('4'), widgetTool('5')]),
      widgetResponse('end_turn'),
    ]);
    assert.equal(result.effects.length, 4);
    assert.equal(result.effects.filter(e => e.startsWith('search:')).length, 2);
    assert.equal(toolResultsFor(result.requests[2]).at(-1).is_error, true);
    assertWidgetSuccess(result);
  });

  it('counts rejected, failed and unknown attempts without allowing extra probing', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'fetch_worldmonitor_data', { endpoint: '/blocked' }), widgetTool('2'), widgetTool('3', 'search_web', { query: 'fail' }), widgetTool('4', 'unknown'), widgetTool('5')]),
      widgetResponse('end_turn'),
    ], { failFetch: true, failSearch: true });
    assert.equal(result.effects.length, 2);
    const results = toolResultsFor(result.requests[1]);
    assert.equal(results.length, 5);
    assert.ok(results.every(r => r.is_error === true));
    assertWidgetSuccess(result);
  });

  it('returns an error result for unknown tools and counts their attempts', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'unknown'), widgetTool('2'), widgetTool('3'), widgetTool('4')]), widgetResponse('end_turn'),
    ]);
    assert.equal(result.effects.length, 2);
    assert.match(toolResultsFor(result.requests[1])[0].content, /unknown tool/i);
    assertWidgetSuccess(result);
  });

  for (const tier of ['basic', 'pro']) {
    const maxTurns = tier === 'pro' ? 10 : 6;
    it(`${tier}: penultimate truncation preserves partial output and never restores tools`, async () => {
      const partial = [{ type: 'text', text: '<!-- widget-html --><div>partial' }];
      const result = await runWidgetAgent([
        ...Array.from({ length: maxTurns - 2 }, () => widgetResponse('pause_turn')),
        widgetResponse('max_tokens', partial), widgetResponse('end_turn'),
      ], { tier });
      assert.deepEqual(result.requests.slice(-2).map(r => r.tool_choice.type), ['none', 'none']);
      assert.ok(result.requests.at(-1).messages.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content[0]?.text === partial[0].text));
      assertWidgetSuccess(result);
    });
    it(`${tier}: pause_turn stays bounded and exhaustion cannot recover old history as success`, async () => {
      const result = await runWidgetAgent(Array.from({ length: maxTurns }, () => widgetResponse('pause_turn')), { tier });
      assert.equal(result.requests.length, maxTurns);
      assert.ok(result.requests.slice(1).every(r => r.tool_choice.type === 'none'));
      assertWidgetError(result, /exhausted/i);
    });
  }

  it('does not execute tool requests after entering finalization', async () => {
    const result = await runWidgetAgent([
      widgetResponse('pause_turn'), widgetResponse('tool_use', [widgetTool('1')]), widgetResponse('end_turn'),
    ]);
    assert.equal(result.effects.length, 0);
    assert.ok(result.requests.slice(1).every(r => r.tool_choice.type === 'none'));
    assert.equal(toolResultsFor(result.requests[2])[0].is_error, true);
    assertWidgetSuccess(result);
  });

  it('rejects a second truncation with one terminal error', async () => {
    const result = await runWidgetAgent([widgetResponse('max_tokens'), widgetResponse('max_tokens')]);
    assert.equal(result.requests.length, 2);
    assertWidgetError(result, /truncat|token limit/i);
  });

  it('returns errors for truncated tool blocks without executing them', async () => {
    const result = await runWidgetAgent([
      widgetResponse('max_tokens', [widgetTool('partial', 'fetch_worldmonitor_data', {})]), widgetResponse('end_turn'),
    ]);
    assert.equal(result.effects.length, 0);
    assert.equal(toolResultsFor(result.requests[1])[0].is_error, true);
    assertWidgetSuccess(result);
  });

  it('malformed input still consumes an attempt and receives a result', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', null), widgetTool('2'), widgetTool('3'), widgetTool('4')]), widgetResponse('end_turn'),
    ]);
    assert.equal(result.effects.length, 2);
    const results = toolResultsFor(result.requests[1]);
    assert.equal(results.length, 4);
    assert.equal(results[0].is_error, true);
    assert.equal(results[3].is_error, true);
    assertWidgetSuccess(result);
  });

  it('invalid search query cannot interrupt results for later tool blocks', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: { toString: 'invalid' } }), widgetTool('2')]), widgetResponse('end_turn'),
    ]);
    assert.equal(result.effects.length, 1);
    assert.equal(toolResultsFor(result.requests[1]).length, 2);
    assert.equal(toolResultsFor(result.requests[1])[0].is_error, true);
    assertWidgetSuccess(result);
  });

  it('rejects a tool_use stop without any tool blocks', async () => {
    const result = await runWidgetAgent([widgetResponse('tool_use', [])]);
    assert.equal(result.requests.length, 1);
    assertWidgetError(result, /incomplete.*tool/i);
  });

  it('records requested and executed counts without logging SDK response bodies or secrets', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [1, 2, 3, 4].map(n => widgetTool(String(n)))),
      new Error('private prompt and sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ]);
    const log = JSON.parse(result.logs.find(args => args[0] === '[widget-agent] Error:')[1]);
    assert.equal(log.toolCallCount, 4);
    assert.equal(log.toolExecutionCount, 3);
    assert.doesNotMatch(JSON.stringify(result.logs), /private prompt|sk-ant-api03/);
    assertWidgetError(result, /private prompt/);
  });

  it('stops side effects at the deadline and emits exactly one terminal error', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1'), widgetTool('2')]),
    ], { expireDuringFetch: true });
    assert.equal(result.effects.length, 1);
    assert.equal(result.requests.length, 1);
    assertWidgetError(result, /timeout/i);
  });

  it('aborts the in-flight model call at the deadline so it stops billing', async () => {
    const result = await runWidgetAgent([], { hangOn: 'deadline' });
    assert.equal(result.modelSignals[0]?.aborted, true);
    assertWidgetError(result, /timeout/i);
    assert.equal(usageLine(result).outcome, 'timeout');
  });

  it('aborts the in-flight model call when the client disconnects', async () => {
    const result = await runWidgetAgent([], { hangOn: 'disconnect' });
    assert.equal(result.modelSignals[0]?.aborted, true);
    assert.equal(result.events.some(e => e.type === 'html_complete'), false);
    assert.equal(usageLine(result).outcome, 'cancelled');
  });

  it('gives the source verifier a signal bounded by the deadline as well as cancellation', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]), widgetResponse('end_turn'),
    ]);
    assertWidgetSuccess(result);
    const { signal } = result.verifyCalls[0];
    assert.ok(signal);
    assert.notEqual(signal, result.modelSignals[0], 'bounded by the deadline, not only by cancellation');
    assert.equal(signal.aborted, false);
  });

  it('serializes the capped tool exchange and finalization through the installed SDK', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [1, 2, 3, 4].map(n => widgetTool(String(n)))), widgetResponse('end_turn'),
    ], { sdkTransport: true });
    assertWidgetSuccess(result);
    assert.equal(result.effects.length, 3);
    assert.equal(result.requests[1].tool_choice?.type, 'none');
    assert.deepEqual(result.requests[1].tools, result.requests[0].tools);
    assert.ok(result.requests[1].tools.every(tool => tool.input_schema?.type === 'object'));
    assert.equal(toolResultsFor(result.requests[1]).length, 4);
    assert.equal(toolResultsFor(result.requests[1])[3].is_error, true);
  });

  for (const reason of ['refusal', 'stop_sequence', null, 'unexpected']) {
    it(`terminates explicitly on ${reason}`, async () => {
      const result = await runWidgetAgent([widgetResponse(reason)]);
      assert.equal(result.requests.length, 1);
      assertWidgetError(result, /refus|stop|incomplete/i);
    });
  }
  for (const calls of [[], [widgetTool('1')]]) {
    it(`preserves successful ${calls.length}-call generation`, async () => {
      const result = await runWidgetAgent([...(calls.length ? [widgetResponse('tool_use', calls)] : []), widgetResponse('end_turn')]);
      assertWidgetSuccess(result);
      assert.equal(result.effects.length, calls.length);
      assert.equal(result.events.find(e => e.type === 'html_complete').html, '<div>42</div>');
    });
  }
});

describe('widget data-tool contracts', () => {
  const relay = src('scripts/ais-relay.cjs');
  function constant(name) {
    const match = relay.match(new RegExp('^const ' + name + ' = (`[\\s\\S]*?`|\\{[\\s\\S]*?^\\});$', 'm'));
    assert.ok(match, `${name} must exist`);
    return vm.runInNewContext(`(${match[1]})`, { WIDGET_DATA_CATALOG });
  }
  const fetchTool = constant('WIDGET_FETCH_TOOL');
  const searchTool = constant('WIDGET_SEARCH_TOOL');
  const prompts = [constant('WIDGET_SYSTEM_PROMPT'), constant('WIDGET_PRO_SYSTEM_PROMPT')];

  it('describes catalog paths, query strings, seeded history, and response text', () => {
    const description = fetchTool.description;
    for (const term of ['/api/bootstrap', '/api/<service>/v1/<method>', 'GET', 'params', 'string',
      'data', 'missing', 'RPC', 'historical', 'FRED', 'sanitized', '20,000']) {
      assert.ok(description.includes(term), `fetch contract must explain ${term}`);
    }
    assert.match(description, /catalog/i);
    assert.match(fetchTool.input_schema.properties.endpoint.description, /path.*not.*URL/i);
    assert.equal(fetchTool.input_schema.properties.params.additionalProperties.type, 'string');
    assert.match(description, /Endpoint not allowed\./);
    assert.match(description, /HTML.*error/i);
    assert.match(description, /Fetch failed:/);
    assert.match(description, /credentials.*not.*send/);
    assert.match(description, /authorization error.*text/);
    assert.doesNotMatch(description, /only pre-approved|allowlist/i);
    assert.doesNotMatch([...prompts, description, searchTool.description].join('\n'),
      /list_bootstrap_keys|(?:no|cannot return|lacks) historical series/i);
  });

  it('describes the model-visible search array without promising uniform freshness', () => {
    assert.match(searchTool.description, /8/);
    assert.match(searchTool.description, /array/);
    for (const field of ['title', 'url', 'snippet', 'publishedDate']) {
      assert.ok(searchTool.description.includes(field), `search contract must name ${field}`);
    }
    assert.match(searchTool.description, /snippets/);
    assert.match(searchTool.description, /freshness.*var/i);
    assert.match(searchTool.description, /publishedDate.*empty/i);
  });

  // Fixed routing expectations for static contract review, not simulated model choices.
  const routingCases = [
    ['Show dashboard stock market quotes', 'marketQuotes'],
    ['Chart the historical FRED unemployment series UNRATE', 'get-fred-series'],
    ['Show dashboard weather alerts', 'weatherAlerts'],
    ['Show tomorrow\'s hourly local weather forecast for Dubai Marina', null, /local weather forecast/i],
    ['Show the WorldMonitor news feed digest', 'list-feed-digest'],
    ['Build a breaking-news widget for a local power outage in Dubai Marina that is not yet in WorldMonitor news feeds', null, /breaking event.*not.*feeds/i],
    ['Show the current UAE retail price of Sony WH-1000XM6 headphones, which is not in the WorldMonitor catalog', null, /price.*not.*catalog/i],
  ];
  for (const [request, capability, gapExample] of routingCases) {
    it(`routing contract: ${request}`, () => {
      for (const prompt of prompts) {
        assert.match(prompt, /fetch_worldmonitor_data — use when a bootstrap key or RPC below matches/);
        assert.match(prompt, /Use search_web for data the catalog does not cover/);
        if (capability) assert.ok(prompt.includes(capability), `catalog must cover ${capability}`);
      }
      assert.match(searchTool.description, /only when no.*bootstrap key or RPC.*supplies/i);
      if (capability) {
        assert.match(fetchTool.description, /Prefer.*bootstrap.*RPC/s);
      } else {
        assert.match(searchTool.description, gapExample);
      }
    });
  }

  it('lists exactly the FRED series the RPC accepts', () => {
    const allowed = [...JSON.parse(src('shared/openapi-filter-param-contracts.json')).economicFredSeriesIds].sort();
    assert.ok(allowed.length > 10);
    for (const prompt of prompts) {
      const line = prompt.match(/get-fred-series \(series_id \(required, ONLY one of: ([^;]+);/);
      assert.ok(line, 'get-fred-series must list its accepted series');
      assert.deepEqual(line[1].split(',').map(x => x.trim()).sort(), allowed);
    }
  });

  it('forbids inventing time windows and says quote sparklines are undated', () => {
    for (const prompt of prompts) {
      assert.match(prompt, /## Time windows — never invent dates/);
      assert.match(prompt, /sparkline of recent prices with no dates.*interval varies by source/i);
      assert.match(prompt, /not a dated history; for dated daily closes use \/api\/market\/v1\/get-price-history/);
      assert.doesNotMatch(prompt, /Today \(intraday\)/, 'a sparkline may be seven daily closes, not intraday');
      assert.match(prompt, /not in the data.*say so in the widget/i);
      assert.match(prompt, /Never fill missing history from search_web/);
      assert.match(prompt, /could not be fetched.*never substitute remembered, estimated or example values/i);
      assert.match(prompt, /data widget is never refused, even when its data turns out to be unavailable/);
      assert.ok(prompt.indexOf('never refused') < prompt.indexOf('When refusing, output ONLY this'), 'the carve-out must sit beside the refusal template');
      assert.match(prompt, /params\.symbols/);
      assert.match(prompt, /get-gold-intelligence/);
    }
    assert.match(fetchTool.description, /_widget/);
  });

  it('describes read_page and the web provenance rules in both tiers', () => {
    for (const prompt of prompts) {
      assert.match(prompt, /### read_page — read a page that search_web returned/);
      assert.match(prompt, /source domain and as-of date/);
      assert.match(prompt, /Never label web values "Source: WorldMonitor"/);
      assert.match(prompt, /identify the period it covers/);
      assert.match(prompt, /Never infer, extrapolate, estimate or fill from memory/);
      assert.match(prompt, /4 tool calls once you have used search_web/);
    }
  });

  it('keeps the basic and Pro data-embedding contracts distinct', () => {
    assert.match(prompts[0], /Embed this data directly into the widget HTML/);
    assert.match(prompts[0], /display-only HTML\. No <script>/);
    assert.match(prompts[1], /Embed as const DATA = \[\.\.\.\] in your inline script/);
    assert.match(prompts[1], /Inline <script> tags are allowed/);
  });

  async function toolResult(block, fetch) {
    // Execute the real dispatch and result insertion without starting the relay server.
    const start = relay.indexOf('        const toolResults = [];', relay.indexOf('async function handleWidgetAgentRequest'));
    const resultInsertion = "        messages.push({ role: 'user', content: toolResults });";
    const resultStart = relay.indexOf(resultInsertion, start);
    assert.ok(start > 0 && resultStart > start);
    const end = resultStart + resultInsertion.length;
    const helpers = relay.slice(relay.indexOf('function filterWidgetToolInjection('), relay.indexOf('const WIDGET_FETCH_TOOL'));
    const context = vm.createContext({
      URL, AbortSignal, fetch, buildWidgetDataUrl, response: { stop_reason: 'tool_use', content: [block] }, messages: [], res: {},
      cancelled: false, finalizing: false, toolCallCount: 0, toolExecutionCount: 0,
      WIDGET_MAX_TOOL_CALLS: 3, toolLimit: 3, searchedUrls: new Set(), sources: [], usedWeb: false,
      getWidgetDataSessionToken: async () => 'wms_contract', invalidateWidgetDataSession() {},
      sendWidgetSSE() {}, WIDGET_EXA_KEY: 'fixture', WIDGET_BRAVE_KEY: 'fixture', console,
    });
    const searchStart = relay.indexOf('async function performWidgetWebSearch(');
    const searchEnd = relay.indexOf('const WIDGET_RATE_LIMIT', searchStart);
    vm.runInContext(helpers + relay.slice(searchStart, searchEnd), context);
    await vm.runInContext(`(async () => { ${relay.slice(start, end)} })()`, context);
    return context.messages.at(-1).content[0].content;
  }
  const fetchBlock = (endpoint, params = {}) => ({ type: 'tool_use', id: 'fixture', name: fetchTool.name, input: { endpoint, params } });

  it('returns bootstrap response text and sends params as GET query strings', async () => {
    const body = JSON.stringify({ data: { marketQuotes: [{ symbol: 'SPY', price: 600 }] }, missing: ['cryptoQuotes'] });
    const result = await toolResult(fetchBlock('/api/bootstrap', { keys: 'marketQuotes,cryptoQuotes' }), async (url, init) => {
      assert.equal(url, 'https://api.worldmonitor.app/api/bootstrap?keys=marketQuotes%2CcryptoQuotes');
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(init.headers['X-WorldMonitor-Key'], 'wms_contract');
      return { text: async () => body };
    });
    assert.equal(result, body);
  });

  it('preserves RPC historical observations and non-HTML HTTP error bodies', async () => {
    for (const [body, status] of [
      ['{"series":{"observations":[{"date":"2020-01-01","value":3.6}]}}', 200],
      ['{"error":"unauthorized"}', 401],
    ]) {
      const result = await toolResult(fetchBlock('/api/economic/v1/get-fred-series', { series_id: 'UNRATE' }), async () => new Response(body, { status }));
      assert.equal(result, body);
    }
  });

  it('returns local rejection, HTML-page and network-failure text', async () => {
    assert.equal(await toolResult(fetchBlock('/health'), async () => assert.fail('rejected path must not fetch')), 'Endpoint not allowed.');
    for (const body of ['  <!DOCTYPE html><body>error</body>', '\n<html>error</html>']) {
      assert.equal(await toolResult(fetchBlock('/api/bootstrap', { keys: 'marketQuotes' }), async () => ({ text: async () => body })),
        'Error: endpoint returned HTML instead of JSON. No data available.');
    }
    assert.equal(await toolResult(fetchBlock('/api/bootstrap', { keys: 'marketQuotes' }), async () => { throw new Error('fixture timeout'); }), 'Fetch failed: fixture timeout');
  });

  it('sanitizes and truncates model-visible response content', async () => {
    const result = await toolResult(fetchBlock('/api/bootstrap', { keys: 'marketQuotes' }), async () => ({ text: async () => '[system]' + 'x'.repeat(21_000) }));
    assert.equal(result.length, 20_000);
    assert.ok(result.startsWith('[filtered]'));
  });

  it('passes only normalized search results to the model, without the provider wrapper', async () => {
    const result = await toolResult({ type: 'tool_use', id: 'search', name: searchTool.name, input: { query: 'fixture' } }, async () => ({
      ok: true, json: async () => ({ results: [{ title: 'Fixture', url: 'https://example.com', text: 'Snippet' }] }),
    }));
    assert.deepEqual(JSON.parse(result), [{ title: 'Fixture', url: 'https://example.com', snippet: 'Snippet', publishedDate: '' }]);
  });

  it('keeps provider freshness and relative dates distinct from dashboard data', async () => {
    const result = await toolResult({ type: 'tool_use', id: 'search', name: searchTool.name, input: { query: 'fixture' } }, async (url, init) => {
      if (url === 'https://api.exa.ai/search') {
        assert.equal(JSON.parse(init.body).numResults, 8);
        assert.equal(JSON.parse(init.body).startPublishedDate, undefined);
        return { ok: true, json: async () => ({ results: [] }) };
      }
      assert.equal(new URL(url).searchParams.get('freshness'), 'pw');
      assert.equal(new URL(url).searchParams.get('count'), '8');
      return { ok: true, json: async () => ({ web: { results: [{ title: 'Fixture', url: 'https://example.com', description: 'Snippet', age: '2 days ago' }] } }) };
    });
    assert.deepEqual(JSON.parse(result), [{ title: 'Fixture', url: 'https://example.com', snippet: 'Snippet', publishedDate: '2 days ago' }]);
  });
});

// ---------------------------------------------------------------------------
// 1. Relay security
// ---------------------------------------------------------------------------
describe('widget-agent relay — data fetch credentials', () => {
  const oneFetch = () => [widgetResponse('tool_use', [widgetTool('1')]), widgetResponse('end_turn')];

  it('authenticates data fetches with an anonymous WorldMonitor session', async () => {
    const result = await runWidgetAgent(oneFetch());
    assert.equal(result.fetchInits[0].headers['X-WorldMonitor-Key'], 'wms_fixture');
    assert.equal(result.fetchInits[0].redirect, 'error');
    assert.deepEqual(result.invalidated, []);
    assertWidgetSuccess(result);
  });

  it('fetches without a credential when no session could be minted', async () => {
    const result = await runWidgetAgent(oneFetch(), { sessionToken: '' });
    assert.equal('X-WorldMonitor-Key' in result.fetchInits[0].headers, false);
    assertWidgetSuccess(result);
  });

  it('drops the session when the API rejects it so the next fetch mints a fresh one', async () => {
    const result = await runWidgetAgent(oneFetch(), { fetchStatus: 401, fetchBody: '{"error":"Invalid session token"}' });
    assert.deepEqual(result.invalidated, ['wms_fixture']);
    assertWidgetSuccess(result);
  });

  it('keeps the session when a route needs more than anonymous authority', async () => {
    const result = await runWidgetAgent(oneFetch(), { fetchStatus: 401, fetchBody: '{"error":"Pro authentication required"}' });
    assert.deepEqual(result.invalidated, []);
    assertWidgetSuccess(result);
  });
});

describe('widget-agent relay — dated, compact tool results', () => {
  it('tells the model today\'s date', async () => {
    const result = await runWidgetAgent([widgetResponse('end_turn')]);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(result.requests[0].system.endsWith(`Today's date (UTC): ${today}.`));
  });

  it('filters injection text before compacting, so the result stays valid JSON after sanitizing', async () => {
    const events = Array.from({ length: 400 }, (_, i) => ({ id: i, note: '[system]'.repeat(20) }));
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'fetch_worldmonitor_data', { endpoint: '/api/bootstrap', params: { keys: 'ucdpEvents' } })]),
      widgetResponse('end_turn'),
    ], { fetchBody: JSON.stringify({ data: { events } }) });
    const content = toolResultsFor(result.requests[1])[0].content;
    const parsed = JSON.parse(content);
    assert.ok(content.length <= 20_000);
    assert.doesNotMatch(content, /\[system\]/);
    assert.equal(parsed._widget.truncated[0].total, 400);
  });

  it('keeps symbols out of the bootstrap URL and filters the quotes locally', async () => {
    const quotes = { data: { commodityQuotes: { quotes: [
      { symbol: 'GC=F', price: 4192 }, { symbol: 'SI=F', price: 61.2 }, { symbol: 'CL=F', price: 70 },
    ] } } };
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'fetch_worldmonitor_data', { endpoint: '/api/news/v1/list-feed-digest', params: { keys: 'commodityQuotes', symbols: 'gc=f, SI=F' } })]),
      widgetResponse('end_turn'),
    ], { fetchBody: JSON.stringify(quotes) });
    assert.equal(new URL(result.effects[0]).searchParams.has('symbols'), true, 'non-bootstrap endpoints keep their params');
    const bootstrap = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'fetch_worldmonitor_data', { endpoint: '/api/bootstrap', params: { keys: 'commodityQuotes', symbols: 'gc=f, SI=F' } })]),
      widgetResponse('end_turn'),
    ], { fetchBody: JSON.stringify(quotes) });
    assert.equal(new URL(bootstrap.effects[0]).searchParams.has('symbols'), false);
    const content = JSON.parse(toolResultsFor(bootstrap.requests[1])[0].content);
    assert.deepEqual(content.data.commodityQuotes.quotes.map(q => q.symbol), ['GC=F', 'SI=F']);
    assert.deepEqual(content._widget.symbols, { requested: ['GC=F', 'SI=F'], missing: [], filtered: ['data.commodityQuotes.quotes'] });
    assert.equal(result.requests.length, 2);
  });

  it('refuses a route outside the catalog without fetching it', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'fetch_worldmonitor_data', { endpoint: '/api/intelligence/v1/get-country-intel-brief', params: { country_code: 'IR' } })]),
      widgetResponse('end_turn'),
    ]);
    assert.deepEqual(result.effects, []);
    assert.match(toolResultsFor(result.requests[1])[0].content, /not allowed/i);
  });
});

describe('widget tool result compaction', () => {
  const relay = src('scripts/ais-relay.cjs');
  const match = relay.match(/function compactWidgetToolJson\([\s\S]*?\n\}/);
  const compact = (text, symbols) => {
    assert.ok(match, 'Missing compactWidgetToolJson');
    return vm.runInNewContext(`${match[0]}\ncompactWidgetToolJson`)(text, symbols);
  };

  it('returns non-JSON text unchanged', () => {
    assert.equal(compact('<!DOCTYPE html>x'), '<!DOCTYPE html>x');
    assert.equal(compact('{"error":"Pro authentication required"}'), '{"error":"Pro authentication required"}');
  });

  it('samples long numeric series to 48 points, keeping first and last, and says so', () => {
    const series = Array.from({ length: 580 }, (_, i) => i);
    const out = JSON.parse(compact(JSON.stringify({ data: { q: { quotes: [{ symbol: 'GC=F', sparkline: series }] } } })));
    const sampled = out.data.q.quotes[0].sparkline;
    assert.equal(sampled.length, 48);
    assert.equal(sampled[0], 0);
    assert.equal(sampled.at(-1), 579);
    assert.match(out._widget.sampledSeries, /48 points.*same indices.*stay aligned/);
    assert.doesNotMatch(out._widget.sampledSeries, /no dates/);
  });

  it('samples a 252-point timestamps/closes pair at the same indices so dates stay aligned', () => {
    const day = 86_400_000;
    const timestamps = Array.from({ length: 252 }, (_, i) => 1_700_000_000_000 + i * day);
    const closes = timestamps.map((_, i) => 2000 + i);
    const out = JSON.parse(compact(JSON.stringify({ range: '1y', series: [{ symbol: 'GC=F', timestamps, closes }], unavailable: [] })));
    const [series] = out.series;
    assert.equal(series.timestamps.length, 48);
    assert.equal(series.closes.length, 48);
    assert.equal(series.timestamps[0], timestamps[0]);
    assert.equal(series.timestamps.at(-1), timestamps.at(-1));
    assert.equal(series.closes[0], closes[0]);
    assert.equal(series.closes.at(-1), closes.at(-1));
    series.timestamps.forEach((t, i) => assert.equal(series.closes[i], closes[timestamps.indexOf(t)]));
  });

  it('keeps short series and small payloads byte-identical', () => {
    const text = JSON.stringify({ data: { q: { quotes: [{ symbol: 'A', sparkline: [1, 2, 3] }] } } });
    assert.equal(compact(text), text);
  });

  it('drops whole records from the largest list to fit the budget and reports what it kept', () => {
    const events = Array.from({ length: 400 }, (_, i) => ({ id: i, place: `place-${i}`, detail: 'x'.repeat(150) }));
    const text = JSON.stringify({ data: { earthquakes: { earthquakes: events, fetchedAt: 1 } } });
    const out = compact(text);
    assert.ok(out.length <= 20_000, `compacted to ${out.length}`);
    const parsed = JSON.parse(out);
    const kept = parsed.data.earthquakes.earthquakes;
    assert.equal(kept[0].id, 0);
    assert.deepEqual(parsed._widget.truncated, [{ path: 'data.earthquakes.earthquakes', kept: kept.length, total: 400 }]);
    assert.equal(parsed.data.earthquakes.fetchedAt, 1);
  });

  it('returns a valid JSON note when nothing reducible brings the payload under budget', () => {
    for (const payload of [
      { data: { report: { text: 'x'.repeat(30_000) } } },
      { data: { list: [{ blob: 'y'.repeat(30_000) }, { blob: 'z' }] } },
    ]) {
      const out = compact(JSON.stringify(payload));
      assert.ok(out.length <= 20_000);
      assert.match(JSON.parse(out)._widget.error, /exceeds .* after compaction; data omitted/);
    }
  });

  it('filters only the lists that contain a requested symbol and names them', () => {
    const text = JSON.stringify({ data: {
      commodityQuotes: { quotes: [{ symbol: 'GC=F' }, { symbol: 'CL=F' }] },
      marketQuotes: { quotes: [{ symbol: 'NVDA' }, { symbol: 'AAPL' }] },
    } });
    const out = JSON.parse(compact(text, ['GC=F']));
    assert.deepEqual(out.data.commodityQuotes.quotes.map(q => q.symbol), ['GC=F']);
    assert.deepEqual(out.data.marketQuotes.quotes.map(q => q.symbol), ['NVDA', 'AAPL']);
    assert.deepEqual(out._widget.symbols.filtered, ['data.commodityQuotes.quotes']);
  });

  it('filters quote lists only, leaving other symbol-bearing lists such as sectors whole', () => {
    const text = JSON.stringify({ data: {
      sectors: { sectors: [{ symbol: 'XLK' }, { symbol: 'XLE' }], valuationCoverage: { valuationDiagnostics: [{ symbol: 'XLK' }, { symbol: 'XLE' }] } },
      marketQuotes: { quotes: [{ symbol: 'XLK' }, { symbol: 'NVDA' }] },
    } });
    const out = JSON.parse(compact(text, ['XLK']));
    assert.equal(out.data.sectors.sectors.length, 2);
    assert.equal(out.data.sectors.valuationCoverage.valuationDiagnostics.length, 2);
    assert.deepEqual(out.data.marketQuotes.quotes.map(q => q.symbol), ['XLK']);
    assert.deepEqual(out._widget.symbols.filtered, ['data.marketQuotes.quotes']);
  });

  it('reports requested symbols the data does not have', () => {
    const out = JSON.parse(compact(JSON.stringify({ data: { q: { quotes: [{ symbol: 'GC=F' }] } } }), ['GC=F', 'XAU']));
    assert.deepEqual(out.data.q.quotes.map(q => q.symbol), ['GC=F']);
    assert.deepEqual(out._widget.symbols, { requested: ['GC=F', 'XAU'], missing: ['XAU'], filtered: ['data.q.quotes'] });
  });
});

describe('widget-agent relay — web pages and source verification', () => {
  const searchResults = [{ title: 'Table', url: 'https://example.com/table', snippet: 's', publishedDate: '' }];
  const html = body => `<!-- title: T --><!-- widget-html --><div>${body}</div><!-- /widget-html -->`;
  const draft = body => widgetResponse('end_turn', [{ type: 'text', text: html(body) }]);
  const finalHtml = result => result.events.find(e => e.type === 'html_complete')?.html;
  const endpoints = result => result.events.filter(e => e.type === 'tool_call').map(e => e.endpoint);

  it('reads only urls that search_web returned in this request', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'read_page', { url: 'https://evil.example/x' })]),
      widgetResponse('end_turn'),
    ], { searchResults });
    assert.equal(result.effects.some(e => String(e).startsWith('read:')), false);
    const [toolResult] = toolResultsFor(result.requests[1]);
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content, /Only urls returned by search_web/);
  });

  it('reads a searched page and reports its host as progress', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'table' })]),
      widgetResponse('tool_use', [widgetTool('2', 'read_page', { url: 'https://example.com/table' })]),
      draft('ok'),
    ], { searchResults, pageText: '| Team | Pts |' });
    assert.ok(result.effects.includes('read:https://example.com/table'));
    assert.ok(endpoints(result).includes('read:example.com'));
    assert.match(toolResultsFor(result.requests[2]).at(-1).content, /\| Team \| Pts \|/);
  });

  it('allows a fourth tool call once the widget has searched the web', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' }), widgetTool('2'), widgetTool('3'), widgetTool('4')]),
      draft('ok'),
    ], { searchResults });
    assert.equal(result.effects.filter(e => !String(e).startsWith('search:')).length, 3);
    assert.equal(toolResultsFor(result.requests[1]).some(r => r.is_error), false);
  });

  it('does not verify a widget built only from WorldMonitor data', async () => {
    const result = await runWidgetAgent([widgetResponse('tool_use', [widgetTool('1')]), draft('ok')]);
    assert.equal(result.verifyCalls.length, 0);
    assert.equal(endpoints(result).includes('verify:sources'), false);
    assertWidgetSuccess(result);
  });

  it('verifies a web-sourced widget against what the model read, then serves it', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      draft('first'),
    ], { searchResults });
    assert.equal(result.verifyCalls.length, 1);
    const [call] = result.verifyCalls;
    assert.equal(call.request, 'Show earthquake data');
    assert.match(call.html, /first/);
    assert.ok(call.sources.some(source => source.kind === 'search'));
    assert.match(call.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(endpoints(result).includes('verify:sources'));
    assert.equal(finalHtml(result), '<div>first</div>');
    assertWidgetSuccess(result);
  });

  it('feeds a failed check back once, grants one more tool call, and serves the fix', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'table 2025-26' })]),
      draft('last season'),
      widgetResponse('tool_use', [widgetTool('2', 'search_web', { query: 'table 2026-27' })]),
      draft('this season'),
    ], { searchResults, tier: 'pro', verdicts: [{ rightDataset: false, datasetWhy: 'shows the finished 2025-26 table', unsupported: [{ value: 'W W W', why: 'form not in source' }] }] });
    assert.equal(result.verifyCalls.length, 2, 'the repaired draft is checked again');
    assert.match(result.verifyCalls[1].html, /this season/);
    const feedback = result.requests[2].messages.at(-1).content;
    assert.match(feedback, /finished 2025-26 table/);
    assert.match(feedback, /W W W/);
    assert.equal(result.requests[2].tool_choice.type, 'auto');
    assert.deepEqual(result.effects.filter(e => String(e).startsWith('search:')), ['search:table 2025-26', 'search:table 2026-27']);
    assert.equal(finalHtml(result), '<div>this season</div>');
    assertWidgetSuccess(result);
  });

  it('serves the first draft when the check itself fails', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      draft('first'),
    ], { searchResults, verdicts: [null] });
    assert.equal(finalHtml(result), '<div>first</div>');
    assertWidgetSuccess(result);
  });

  it('never serves a rejected draft when the repair comes back incomplete', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      draft('first'),
      widgetResponse('end_turn', [{ type: 'text', text: 'no markers here' }]),
    ], { searchResults, verdicts: [{ rightDataset: true, datasetWhy: '', unsupported: [{ value: '42', why: 'not in source' }] }] });
    assert.equal(finalHtml(result), undefined);
    assertWidgetError(result, /incomplete/i);
  });

  it('does not recover unchecked HTML from a tool turn after a rejection', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      draft('first'),
      widgetResponse('tool_use', [{ type: 'text', text: html('unchecked') }, widgetTool('2', 'search_web', { query: 'q2' })]),
      widgetResponse('end_turn', [{ type: 'text', text: 'no markers here' }]),
    ], { searchResults, tier: 'pro', verdicts: [{ rightDataset: false, datasetWhy: 'last season', unsupported: [] }] });
    assert.equal(finalHtml(result), undefined);
    assertWidgetError(result, /incomplete/i);
  });

  it('does not recover web-sourced HTML that never reached the check', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      widgetResponse('tool_use', [{ type: 'text', text: html('unchecked web draft') }, widgetTool('2', 'read_page', { url: 'https://example.com/table' })]),
      widgetResponse('end_turn', [{ type: 'text', text: 'no markers here' }]),
    ], { searchResults, tier: 'pro' });
    assert.equal(result.verifyCalls.length, 0);
    assert.equal(finalHtml(result), undefined);
    assertWidgetError(result, /incomplete/i);
  });

  it('fails closed when the repair cannot be checked', async () => {
    const reject = { rightDataset: false, datasetWhy: 'last season', unsupported: [] };
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      draft('first'),
      draft('repair'),
    ], { searchResults, tier: 'pro', verdicts: [reject, null] });
    assert.equal(finalHtml(result), undefined);
    assertWidgetError(result, /sources could not be verified/i);
  });

  it('fails closed when no time is left to check the repair', async () => {
    let now = 1_000_000;
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      draft('first'),
      { get stop_reason() { now += 178_000; return 'end_turn'; }, content: [{ type: 'text', text: html('repair') }] },
    ], { searchResults, tier: 'pro', clock: () => now, verdicts: [{ rightDataset: false, datasetWhy: 'last season', unsupported: [] }] });
    assert.equal(result.verifyCalls.length, 1);
    assert.equal(finalHtml(result), undefined);
    assertWidgetError(result, /sources could not be verified/i);
  });

  it('still runs the repair turn after a truncation near the basic turn limit', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      widgetResponse('tool_use', [widgetTool('2', 'read_page', { url: 'https://example.com/table' })]),
      widgetResponse('tool_use', [widgetTool('3')]),
      widgetResponse('tool_use', [widgetTool('4')]),
      widgetResponse('max_tokens', [{ type: 'text', text: '<!-- widget-html --><div>cut' }]),
      draft('rejected'),
      draft('repaired'),
    ], { searchResults, verdicts: [{ rightDataset: true, datasetWhy: '', unsupported: [{ value: '42', why: 'not in source' }] }] });
    assert.equal(result.requests.length, 7);
    assert.equal(result.requests[6].tool_choice.type, 'none');
    assert.equal(finalHtml(result), '<div>repaired</div>');
    assertWidgetSuccess(result);
  });

  it('gives the check the widget being modified, so carried-over values are not rejected', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      draft('updated'),
    ], { searchResults, tier: 'pro', request: { mode: 'modify', currentHtml: '<div>Arsenal 15 pts</div>', prompt: 'update today' } });
    assert.match(result.verifyCalls[0].priorHtml, /Arsenal 15 pts/);
  });

  it('fails instead of serving a repair the check still rejects', async () => {
    const reject = { rightDataset: false, datasetWhy: 'last season', unsupported: [] };
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      draft('first'),
      draft('second'),
    ], { searchResults, tier: 'pro', verdicts: [reject, reject] });
    assert.equal(result.verifyCalls.length, 2);
    assert.equal(finalHtml(result), undefined);
    assertWidgetError(result, /sources could not be verified/i);
  });

  it('keeps the granted tool call usable when a basic repair starts near the turn limit', async () => {
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'table 2025-26' })]),
      widgetResponse('tool_use', [widgetTool('2', 'read_page', { url: 'https://example.com/table' })]),
      widgetResponse('tool_use', [widgetTool('3')]),
      draft('last season'),
      widgetResponse('tool_use', [widgetTool('4', 'search_web', { query: 'table 2026-27' })]),
      draft('this season'),
    ], { searchResults, verdicts: [{ rightDataset: false, datasetWhy: 'last season', unsupported: [] }] });
    assert.equal(result.requests[4].tool_choice.type, 'auto');
    assert.ok(result.effects.includes('search:table 2026-27'));
    assert.equal(finalHtml(result), '<div>this season</div>');
    assertWidgetSuccess(result);
  });

  it('skips the check and serves the draft when too little of the deadline is left', async () => {
    let now = 1_000_000;
    const result = await runWidgetAgent([
      widgetResponse('tool_use', [widgetTool('1', 'search_web', { query: 'q' })]),
      { get stop_reason() { now += 178_000; return 'end_turn'; }, content: [{ type: 'text', text: html('late') }] },
    ], { searchResults, tier: 'pro', clock: () => now });
    assert.equal(result.verifyCalls.length, 0);
    assert.equal(finalHtml(result), '<div>late</div>');
    assertWidgetSuccess(result);
  });
});

describe('widget page reader', () => {
  const relay = src('scripts/ais-relay.cjs');
  const load = fetch => {
    const match = relay.match(/async function performWidgetPageRead\([\s\S]*?\n\}/);
    assert.ok(match, 'Missing performWidgetPageRead');
    return vm.runInNewContext(`${match[0]}\nperformWidgetPageRead`, {
      fetch, URL, AbortSignal, String, JSON, console: { warn() {} },
      WIDGET_EXA_KEY: 'exa', WIDGET_FIRECRAWL_KEY: 'fc',
    });
  };

  it('sends a User-Agent to both providers and stops when the widget request is cancelled', async () => {
    const inits = [];
    const abort = new AbortController();
    const read = load(async (_url, init) => { inits.push(init); abort.abort(); return { ok: false }; });
    assert.equal(await read('https://example.com/t', { signal: abort.signal }), null);
    assert.equal(inits.length, 1, 'no Firecrawl fallback after cancellation');
    assert.match(inits[0].headers['User-Agent'], /WorldMonitor/);
    assert.equal(inits[0].signal.aborted, true);
  });

  it('reads only http and https urls', async () => {
    const urls = [];
    const read = load(async url => { urls.push(url); return { ok: false }; });
    assert.equal(await read('file:///etc/passwd'), null);
    assert.equal(await read('ftp://example.com/x'), null);
    assert.equal(urls.length, 0);
  });
});

describe('widget source verifier', () => {
  const relay = src('scripts/ais-relay.cjs');
  const load = () => {
    const match = relay.match(/async function verifyWidgetAgainstSources\([\s\S]*?\n\}/);
    assert.ok(match, 'Missing verifyWidgetAgainstSources');
    return vm.runInNewContext(`${widgetSonnetConstants()}\n${match[0]}\nverifyWidgetAgainstSources`, { JSON, console: { warn() {} } });
  };
  const clientReturning = (text, seen = []) => ({ messages: { create: async req => { seen.push(req); return { content: [{ type: 'text', text }] }; } } });
  const input = { request: 'Premier League table', today: '2026-09-29', html: '<div>Arsenal 15</div>', sources: [{ kind: 'page', label: 'https://example.com/t', text: '| Arsenal | 15 |' }] };

  it('parses a fenced JSON verdict into the relay shape', async () => {
    const seen = [];
    const verdict = await load()(clientReturning('```json\n{"right_dataset": false, "dataset_why": "last season", "unsupported": [{"value": "W", "why": "x"}]}\n```', seen), input);
    assert.deepEqual(JSON.parse(JSON.stringify(verdict)), { rightDataset: false, datasetWhy: 'last season', unsupported: [{ value: 'W', why: 'x' }] });
    const sent = seen[0].messages[0].content;
    assert.match(sent, /Premier League table/);
    assert.match(sent, /2026-09-29/);
    assert.match(sent, /\| Arsenal \| 15 \|/);
    assert.match(sent, /Arsenal 15/);
  });

  it('makes the check name both periods before judging, so a finished season reads as stale', async () => {
    const seen = [];
    const verdict = await load()(clientReturning('{"data_period": "2025-26 final table", "needed_period": "2026-27 in progress", "right_dataset": false, "dataset_why": "finished season", "unsupported": []}', seen), input);
    assert.match(seen[0].system, /data_period[\s\S]*needed_period[\s\S]*right_dataset/);
    assert.match(seen[0].system, /finished[^.]*newer one is in progress/);
    assert.equal(verdict.datasetWhy, 'finished season (data: 2025-26 final table; needed: 2026-27 in progress)');
  });

  it('checks on Sonnet 5.5 with the builder settings and refusal fallback, and reports its usage', async () => {
    const seen = [];
    const reported = [];
    const client = { messages: { create: async (req, opts) => { seen.push({ req, opts }); return { content: [{ type: 'text', text: '{"right_dataset": true, "unsupported": []}' }], usage: { input_tokens: 7, output_tokens: 3 } }; } } };
    await load()(client, input, { onUsage: u => reported.push(u) });
    assert.equal(seen[0].req.model, 'claude-sonnet-5-5');
    assert.deepEqual(JSON.parse(JSON.stringify(seen[0].req.thinking)), { type: 'adaptive' });
    assert.equal(seen[0].req.fallbacks, 'default');
    assert.equal(seen[0].opts.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.deepEqual(reported, [{ input_tokens: 7, output_tokens: 3 }]);
  });

  it('keeps the newest sources when the material is over budget', async () => {
    const seen = [];
    const sources = [
      { kind: 'worldmonitor', label: 'old', text: `OLDEST ${'o'.repeat(19_000)}` },
      { kind: 'page', label: 'mid', text: 'm'.repeat(19_000) },
      { kind: 'page', label: 'mid2', text: 'n'.repeat(19_000) },
      { kind: 'page', label: 'mid3', text: 'p'.repeat(19_000) },
      { kind: 'search', label: 'repair', text: `NEWEST ${'r'.repeat(10_000)}` },
    ];
    await load()(clientReturning('{"right_dataset": true, "unsupported": []}', seen), { ...input, sources });
    assert.match(seen[0].messages[0].content, /NEWEST/);
  });

  it('shows the check the widget being modified as prior material', async () => {
    const seen = [];
    await load()(clientReturning('{"right_dataset": true, "unsupported": []}', seen), { ...input, priorHtml: '<div>CARRIED 7</div>' });
    assert.match(seen[0].messages[0].content, /PRIOR WIDGET[\s\S]*CARRIED 7/);
  });

  it('sends the whole widget, not a 40,000-character prefix', async () => {
    const seen = [];
    const html = `<div>${'x'.repeat(70_000)}</div><p>TAIL-VALUE 99</p>`;
    await load()(clientReturning('{"right_dataset": true, "unsupported": []}', seen), { ...input, html });
    assert.match(seen[0].messages[0].content, /TAIL-VALUE 99/);
  });

  it('returns null when the check errors or its reply is not a verdict', async () => {
    const verify = load();
    assert.equal(await verify({ messages: { create: async () => { throw new Error('overloaded'); } } }, input), null);
    assert.equal(await verify(clientReturning('{"right_dataset": tr'), input), null);
    assert.equal(await verify(clientReturning('{"unsupported": []}'), input), null);
  });
});

describe('widget-agent relay — anonymous data session', () => {
  const relay = src('scripts/ais-relay.cjs');
  const start = relay.indexOf('let widgetDataSession = null;');
  const end = relay.indexOf('\n}\n', relay.indexOf('function invalidateWidgetDataSession(')) + 3;

  function load(mint) {
    const calls = [];
    let now = 1_000_000;
    const context = vm.createContext({
      console: { warn() {} },
      Date: { now: () => now },
      AbortSignal,
      fetch: async (url, init) => { calls.push({ url, init }); return mint(calls.length); },
    });
    assert.ok(start > 0 && end > start, 'Missing widget data session helpers');
    vm.runInContext(relay.slice(start, end), context);
    return { context, calls, advance: ms => { now += ms; } };
  }
  const minted = (token, exp) => ({ ok: true, status: 200, json: async () => ({ ok: true, token, exp }) });

  it('mints once with a POST to /api/wm-session and reuses the token until near expiry', async () => {
    const { context, calls, advance } = load(n => minted(`wms_${n}`, 1_000_000 + 12 * 3600_000));
    assert.equal(await context.getWidgetDataSessionToken(), 'wms_1');
    assert.equal(await context.getWidgetDataSessionToken(), 'wms_1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.worldmonitor.app/api/wm-session');
    assert.equal(calls[0].init.method, 'POST');
    advance(12 * 3600_000 - 60_000);
    assert.equal(await context.getWidgetDataSessionToken(), 'wms_2');
  });

  it('shares one in-flight mint between concurrent callers', async () => {
    const { context, calls } = load(n => minted(`wms_${n}`, 1_000_000 + 3600_000));
    const tokens = await Promise.all([context.getWidgetDataSessionToken(), context.getWidgetDataSessionToken()]);
    assert.deepEqual(tokens, ['wms_1', 'wms_1']);
    assert.equal(calls.length, 1);
  });

  it('re-mints after the current token is invalidated, but ignores a stale invalidation', async () => {
    const { context, calls } = load(n => minted(`wms_${n}`, 1_000_000 + 3600_000));
    await context.getWidgetDataSessionToken();
    context.invalidateWidgetDataSession('wms_other');
    assert.equal(await context.getWidgetDataSessionToken(), 'wms_1');
    context.invalidateWidgetDataSession('wms_1');
    assert.equal(await context.getWidgetDataSessionToken(), 'wms_2');
    assert.equal(calls.length, 2);
  });

  it('returns an empty token when minting fails, then retries on the next call', async () => {
    const { context, calls } = load(n => n === 1
      ? { ok: false, status: 429, json: async () => ({}) }
      : minted('wms_ok', 1_000_000 + 3600_000));
    assert.equal(await context.getWidgetDataSessionToken(), '');
    assert.equal(await context.getWidgetDataSessionToken(), 'wms_ok');
    assert.equal(calls.length, 2);
  });

  it('rejects a mint response that is not a wms_ session token', async () => {
    const { context } = load(() => minted('sk-not-a-session', 1_000_000 + 3600_000));
    assert.equal(await context.getWidgetDataSessionToken(), '');
  });
});

describe('widget-agent relay — security', () => {
  const relay = src('scripts/ais-relay.cjs');

  it('isPublicRoute includes /widget-agent so relay secret gate is bypassed', () => {
    // Must be on the same line as other isPublicRoute checks
    const match = relay.match(/isPublicRoute\s*=\s*[^;]+/);
    assert.ok(match, 'isPublicRoute assignment not found');
    assert.ok(
      match[0].includes("'/widget-agent'") || match[0].includes('"/widget-agent"'),
      `isPublicRoute does not exempt /widget-agent:\n  ${match[0]}`,
    );
  });

  it('route is registered before the 404 catch-all', () => {
    const routeIdx = relay.indexOf("pathname === '/widget-agent' && req.method === 'POST'");
    const catchAllIdx = relay.lastIndexOf('res.writeHead(404)');
    assert.ok(routeIdx !== -1, 'widget-agent route registration not found');
    assert.ok(catchAllIdx !== -1, '404 catch-all not found');
    assert.ok(routeIdx < catchAllIdx, 'widget-agent route must appear before 404 catch-all');
  });

  it('auth check uses x-widget-key header (not relay shared secret)', () => {
    assert.ok(
      relay.includes("req.headers['x-widget-key']"),
      "Handler must check req.headers['x-widget-key']",
    );
    assert.ok(
      relay.includes('WIDGET_AGENT_KEY'),
      'Must compare against configured WIDGET_AGENT_KEY',
    );
  });

  it('widget-agent fails closed when WIDGET_AGENT_KEY is missing', () => {
    assert.ok(
      relay.includes('!status.widgetKeyConfigured'),
      'Shared widget-agent auth helper must reject requests when WIDGET_AGENT_KEY is unset',
    );
    const missingKeyIdx = relay.indexOf('!status.widgetKeyConfigured');
    const region = relay.slice(missingKeyIdx, missingKeyIdx + 200);
    assert.ok(region.includes('503'), 'Missing WIDGET_AGENT_KEY should return 503');
  });

  it('auth 403 response is sent before any processing on bad key', () => {
    const handlerStart = relay.indexOf('async function handleWidgetAgentRequest');
    assert.ok(handlerStart !== -1, 'handleWidgetAgentRequest not found');
    // Use 4000 chars to cover the full auth/setup section including SSE headers
    const handlerBody = relay.slice(handlerStart, handlerStart + 4000);
    const authCheckIdx = handlerBody.indexOf('requireWidgetAgentAccess(req, res)');
    const sseHeaderIdx = handlerBody.indexOf("text/event-stream");
    assert.ok(authCheckIdx !== -1, 'Auth helper call not found in handler start');
    assert.ok(sseHeaderIdx !== -1, "text/event-stream SSE header not found within handler");
    assert.ok(authCheckIdx < sseHeaderIdx, 'Auth check must come before SSE headers');
  });

  it('body size limit is enforced (160KB for PRO, covers basic too)', () => {
    assert.ok(
      relay.includes('163840'),
      'Body limit of 163840 bytes (160KB) must be present',
    );
    // Verify 413 is returned when limit exceeded (check global presence near the limit)
    assert.ok(relay.includes('413'), 'Body size guard must respond 413');
    // Both the check and 413 should be in the handler
    const handlerStart = relay.indexOf('async function handleWidgetAgentRequest');
    const handlerBody = relay.slice(handlerStart, handlerStart + 500);
    assert.ok(handlerBody.includes('163840'), 'Body limit must be enforced in handleWidgetAgentRequest');
  });

  it('injection guard — isWidgetInjectionAttempt function is present', () => {
    assert.ok(relay.includes('isWidgetInjectionAttempt'), 'injection guard function must exist');
    assert.ok(relay.includes('ignore') && relay.includes('previous'), 'must detect override patterns');
    assert.ok(relay.includes('jailbreak'), 'must detect jailbreak keyword');
    assert.ok(relay.includes('act\\s+as'), 'must detect role hijacking');
  });

  it('injection guard — hard rejected before API call', () => {
    const guardIdx = relay.indexOf('isWidgetInjectionAttempt(prompt)');
    assert.ok(guardIdx !== -1, 'injection check must be called on prompt');
    // Guard must appear before the Anthropic client is created
    const anthropicIdx = relay.indexOf('new Anthropic(');
    assert.ok(guardIdx < anthropicIdx, 'injection check must happen before any Anthropic API call');
  });

  it('injection guard — tool results are sanitized before context insertion', () => {
    assert.ok(relay.includes('sanitizeToolContent'), 'sanitizeToolContent must be applied to tool results');
    // Must be called on both search results and WM data results
    const count = (relay.match(/sanitizeToolContent/g) || []).length;
    assert.ok(count >= 3, `sanitizeToolContent must appear in definition + both result paths (found ${count})`);
  });

  it('tool loop is bounded by maxTurns (6 for basic, 10 for PRO)', () => {
    assert.ok(
      relay.includes('turn < maxTurns'),
      'Tool loop must use maxTurns variable (not hardcoded 6)',
    );
    // Basic tier maxTurns is set to 6
    assert.ok(
      relay.includes('maxTurns = isPro ? 10 : 6') || relay.includes('isPro ? 10 : 6'),
      'maxTurns must be 6 for basic and 10 for PRO',
    );
  });

  it('server timeout leaves room for a verified web widget: 180 s PRO, 150 s basic', () => {
    assert.ok(relay.includes('const timeoutMs = isPro ? 180_000 : 150_000;'));
  });

  it('CORS for /widget-agent: POST in Allow-Methods, X-Widget-Key and X-Pro-Key in Allow-Headers', () => {
    const widgetCorsIdx = relay.indexOf("pathname.startsWith('/widget-agent')");
    assert.ok(widgetCorsIdx !== -1);
    const corsBlock = relay.slice(widgetCorsIdx, widgetCorsIdx + 500);
    assert.ok(
      corsBlock.includes('GET, POST, OPTIONS'),
      'CORS must include POST in Allow-Methods for /widget-agent',
    );
    assert.ok(
      corsBlock.includes('X-Widget-Key'),
      'CORS must include X-Widget-Key in Allow-Headers for /widget-agent',
    );
    assert.ok(
      corsBlock.includes('X-Pro-Key'),
      'CORS must include X-Pro-Key in Allow-Headers for /widget-agent',
    );
  });

  it('CORS reuses getCorsOrigin (not a narrow hardcoded origin list)', () => {
    const widgetCorsIdx = relay.indexOf("pathname.startsWith('/widget-agent')");
    const corsBlock = relay.slice(widgetCorsIdx, widgetCorsIdx + 600);
    // Must NOT define a hardcoded origins array for this specific route
    assert.ok(
      !corsBlock.includes("['https://worldmonitor.app'"),
      'Do NOT hardcode origins for /widget-agent — reuse getCorsOrigin()',
    );
    // Must reference corsOrigin variable (set by getCorsOrigin earlier)
    // (The block itself may not set Access-Control-Allow-Origin since that's
    // already set above; it just overrides Methods and Headers)
    assert.ok(
      corsBlock.includes('Access-Control-Allow-Methods') ||
      corsBlock.includes('Access-Control-Allow-Headers'),
      'CORS block for /widget-agent must set Allow-Methods or Allow-Headers',
    );
  });

  it('registers GET /widget-agent/health before the 404 catch-all', () => {
    const healthRouteIdx = relay.indexOf("pathname === '/widget-agent/health' && req.method === 'GET'");
    const catchAllIdx = relay.lastIndexOf('res.writeHead(404)');
    assert.ok(healthRouteIdx !== -1, 'widget-agent health route registration not found');
    assert.ok(healthRouteIdx < catchAllIdx, 'widget-agent health route must appear before 404 catch-all');
  });

  it('uses raw @anthropic-ai/sdk (not agent SDK)', () => {
    // Dynamic import should be for @anthropic-ai/sdk specifically
    assert.ok(
      relay.includes("'@anthropic-ai/sdk'") || relay.includes('"@anthropic-ai/sdk"'),
      'Must use @anthropic-ai/sdk (raw SDK)',
    );
    assert.ok(
      !relay.includes('@anthropic-ai/claude-code'),
      'Must NOT use @anthropic-ai/claude-code Agent SDK',
    );
  });

  it('model used is claude-haiku (cost-efficient for widgets)', () => {
    assert.ok(
      relay.includes('claude-haiku'),
      'Widget agent should use claude-haiku model for cost efficiency',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Widget store
// ---------------------------------------------------------------------------
describe('widget-store — constants and logic', () => {
  const store = src('src/services/widget-store.ts');

  it('storage key is wm-custom-widgets', () => {
    assert.ok(
      store.includes("'wm-custom-widgets'"),
      "Storage key must be 'wm-custom-widgets'",
    );
  });

  it('local persistence has no account, entitlement or key-session dependency', () => {
    assert.doesNotMatch(store, /auth-state|entitlements|browser-key-session|wm-(?:widget|pro)-key/);
  });

  it('saveWidget retains at most ten widgets', () => {
    assert.match(store, /JSON\.stringify\(\[\.\.\.loadWidgets\(\)[^\n]*\.slice\(-10\)\)/);
  });

  it('saveWidget bounds HTML to 50,000 characters before sanitization', () => {
    assert.match(store, /sanitizeWidgetHtml\(spec\.html\.slice\(0, 50_000\)\)/);
  });

  it('saveWidget retains at most ten conversation entries', () => {
    assert.match(store, /conversationHistory: spec\.conversationHistory\.slice\(-10\)/);
  });

  it('local widget IDs use the cw- panel close path', () => {
    assert.match(src('src/app/event-handlers.ts'), /panelId\.startsWith\('cw-'\)/);
  });

  it('deleteWidget cleans worldmonitor-panel-spans (aggregate map)', () => {
    assert.ok(
      store.includes('clearPanelSpanEntry(id)'),
      'deleteWidget must clean row-span entries through the shared panel storage helper',
    );
  });

  it('deleteWidget cleans worldmonitor-panel-col-spans (aggregate map)', () => {
    assert.ok(
      store.includes('clearPanelColSpanEntry(id)'),
      'deleteWidget must clean column-span entries through the shared panel storage helper',
    );
  });

  it('saveWidget trims conversationHistory before write', () => {
    // Should call slice(-MAX_HISTORY) before persisting
    const saveIdx = store.indexOf('function saveWidget');
    assert.ok(saveIdx !== -1, 'saveWidget not found');
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      saveBody.includes('.slice(-') || saveBody.includes('slice(-MAX_HISTORY'),
      'saveWidget must trim conversationHistory with .slice(-MAX_HISTORY)',
    );
  });

  it('saveWidget truncates html to MAX_HTML_CHARS before write', () => {
    const saveIdx = store.indexOf('function saveWidget');
    assert.ok(saveIdx !== -1);
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      saveBody.includes('.slice(0, 50_000)'),
      'saveWidget must truncate html to MAX_HTML_CHARS',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Widget response parsing
// ---------------------------------------------------------------------------
describe('widget-agent relay — response parsing', () => {
  const relay = src('scripts/ais-relay.cjs');

  it('relay delegates completed and recovered responses to the shared parser', () => {
    const calls = relay.match(/parseWidgetAgentResponse\(/g) ?? [];
    assert.equal(calls.length, 2);
  });

  it('parses hyphenated titles through the production parser', () => {
    const cases = [
      { input: '<!-- title: Market-Tracker -->', expected: 'Market-Tracker' },
      { input: '<!-- title: US-China Trade Watch -->', expected: 'US-China Trade Watch' },
      { input: '<!-- title: Simple Widget -->', expected: 'Simple Widget' },
      { input: '<!-- title:  Leading Spaces -->', expected: 'Leading Spaces' },
    ];
    for (const { input, expected } of cases) {
      const result = parseWidgetAgentResponse(input, 50_000);
      assert.equal(result.title, expected, `Wrong title extracted from: ${input}`);
    }
  });

  it('falls back to "Custom Widget" when the title comment is absent', () => {
    const text = 'Some widget HTML without title comment';
    assert.equal(parseWidgetAgentResponse(text, 50_000).title, 'Custom Widget');
  });

  it('extracts multiline HTML between markers', () => {
    const text = `<!-- widget-html -->\n<div>hello</div>\n<!-- /widget-html -->`;
    const result = parseWidgetAgentResponse(text, 50_000);
    assert.equal(result.hasHtmlMarkers, true);
    assert.ok(result.html.includes('<div>hello</div>'));
    assert.ok(!result.html.includes('widget-html'));
  });

  it('does not expose unmarked text as completed HTML', () => {
    const text = '<div>fallback</div>';
    const result = parseWidgetAgentResponse(text, 50_000);
    assert.equal(result.hasHtmlMarkers, false);
    assert.equal(result.html, '');
    assert.equal(result.isComplete, false);
  });
});

describe('widget-agent relay — completion contract', () => {
  const relay = src('scripts/ais-relay.cjs');
  // Exercise the production handler without starting the relay's background workers.
  // Only the SDK import and external request dependencies are replaced.
  const handler = relay.slice(
    relay.indexOf('const WIDGET_MAX_TOOL_CALLS ='),
    relay.indexOf('// Map a thrown error from the agent loop'),
  ).replace("await import('@anthropic-ai/sdk')", '({ default: AnthropicStub })');
  const sendSSE = relay.slice(relay.indexOf('function sendWidgetSSE('), relay.indexOf('async function readRequestBody('));

  async function runResponse(tier, responses, conversationHistory = []) {
    let calls = 0;
    let ends = 0;
    const chunks = [];
    const context = {
      parseWidgetAgentResponse,
      requireWidgetAgentAccess: () => ({ anthropicConfigured: true, admittedAs: tier }),
      readRequestBody: async () => JSON.stringify({ prompt: 'Show market data', tier, conversationHistory }),
      PRO_WIDGET_KEY: 'test-pro-key',
      checkProWidgetRateLimit: () => false,
      checkWidgetRateLimit: () => false,
      isWidgetInjectionAttempt: () => false,
      WIDGET_PRO_MAX_HTML: 100_000,
      WIDGET_MAX_HTML: 50_000,
      WIDGET_PRO_SYSTEM_PROMPT: 'pro prompt',
      WIDGET_SYSTEM_PROMPT: 'basic prompt',
      WIDGET_ANTHROPIC_KEY: 'test-key',
      WIDGET_FETCH_TOOL: {},
      WIDGET_SEARCH_TOOL: {},
      WIDGET_READ_TOOL: {}, WIDGET_DRAFT_DELIVERY_RESERVE_MS: 5_000,
      performWidgetWebSearch: async () => null,
      setTimeout, AbortController,
      clearTimeout,
      console,
      AnthropicStub: class {
        messages = {
          create: async () => {
            calls++;
            assert.ok(calls <= responses.length, 'generation must not request another response');
            return responses[calls - 1];
          },
        };
      },
    };
    const res = {
      writableEnded: false, on() {},
      writeHead(status) { assert.equal(status, 200); },
      write(chunk) { chunks.push(chunk); },
      end() { this.writableEnded = true; ends++; },
    };
    vm.runInNewContext(`${widgetSonnetConstants()}\n${sendSSE}\n${handler}\nthis.run = handleWidgetAgentRequest;`, context);
    await context.run({ headers: {}, on() {} }, res);
    assert.equal(ends, 1, 'stream must end exactly once');
    assert.equal(calls, responses.length, 'generation must consume the expected responses');
    return chunks.flatMap(chunk => chunk.split('\n').filter(line => line.startsWith('data: ')))
      .map(line => JSON.parse(line.slice(6)));
  }

  const invalidCases = [
    ['plain prose', 'plain prose'],
    ['markdown', '```html\n<div>Unmarked</div>\n```'],
    ['empty response', ''],
    ['empty markers', '<!-- widget-html --><!-- /widget-html -->'],
    ['whitespace markers', '<!-- widget-html --> \n\t <!-- /widget-html -->'],
    ['unclosed markers', '<!-- widget-html --><div>Incomplete</div>'],
  ];
  for (const tier of ['basic', 'pro']) {
    for (const recovery of [false, true]) {
      const path = `${tier} ${recovery ? 'mid-loop recovery' : 'end_turn'}`;
      const responses = text => Array.from({ length: recovery ? (tier === 'pro' ? 10 : 6) : 1 }, () => ({
        stop_reason: recovery ? 'tool_use' : 'end_turn',
        content: [
          { type: 'text', text },
          ...(recovery ? [{ type: 'tool_use', id: 'unknown-tool', name: 'unknown', input: {} }] : []),
        ],
      }));
      for (const [name, text] of invalidCases) {
        it(`${path}: rejects ${name} with one terminal error`, async () => {
          const events = await runResponse(tier, responses(text));
          assert.deepEqual(events.map(event => event.type), ['error']);
          assert.match(events[0].message, /Widget generation (?:incomplete|invalid)/);
        });
      }
      for (const title of ['Market-Tracker', null]) {
        it(`${path}: accepts marked HTML ${title ? 'with a title' : 'with the fallback title'}`, async () => {
          const html = tier === 'pro' ? '<div>Chart</div><script>renderChart()</script>' : '<div>Market</div>';
          const text = `Outside text\n${title ? `<!-- title: ${title} -->` : ''}<!-- widget-html -->${html}<!-- /widget-html -->\nMore text`;
          assert.deepEqual(await runResponse(tier, responses(text)), [
            { type: 'html_complete', html },
            { type: 'done', title: title ?? 'Custom Widget' },
          ]);
        });
      }
    }
    for (const finalText of ['', '<!-- widget-html --><div>Unfinished</div>']) {
      for (const recoverable of [true, false]) {
        it(`${tier}: ${recoverable ? 'recovers earlier HTML' : 'errors once without valid earlier HTML'} after ${finalText ? 'malformed' : 'empty'} end_turn`, async () => {
          const html = '<div>Earlier result</div>';
          const events = await runResponse(tier, [
            {
              stop_reason: 'tool_use',
              content: [
                { type: 'text', text: recoverable ? `<!-- title: Earlier --><!-- widget-html -->${html}<!-- /widget-html -->` : '<!-- widget-html --> <!-- /widget-html -->' },
                { type: 'tool_use', id: 'search-1', name: 'search_web', input: { query: 'market data' } },
              ],
            },
            { stop_reason: 'end_turn', content: finalText ? [{ type: 'text', text: finalText }] : [] },
          ]);
          assert.deepEqual(events[0], { type: 'tool_call', endpoint: 'search:market data' });
          if (recoverable) {
            assert.deepEqual(events.slice(1), [{ type: 'html_complete', html }, { type: 'done', title: 'Earlier' }]);
          } else {
            assert.deepEqual(events.slice(1).map(event => event.type), ['error']);
            assert.match(events[1].message, /Widget generation incomplete/);
          }
        });
      }
    }
    it(`${tier}: never recovers HTML supplied in conversation history`, async () => {
      const history = [{ role: 'assistant', content: '<!-- widget-html --><div>Stale</div><!-- /widget-html -->' }];
      const events = await runResponse(tier, [{ stop_reason: 'end_turn', content: [] }], history);
      assert.deepEqual(events.map(event => event.type), ['error']);
    });
    for (const reason of ['max_tokens', 'pause_turn']) {
      it(`${tier}: does not recover ${reason} output after an invalid end turn`, async () => {
        const events = await runResponse(tier, [
          { stop_reason: reason, content: [{ type: 'text', text: '<!-- widget-html --><div>Partial</div><!-- /widget-html -->' }] },
          { stop_reason: 'end_turn', content: [] },
        ]);
        assert.deepEqual(events.map(event => event.type), ['error']);
      });
    }
    it(`${tier}: recovers the newest complete current-request candidate`, async () => {
      const history = [{ role: 'assistant', content: '<!-- widget-html --><div>Stale</div><!-- /widget-html -->' }];
      const responses = ['Older', 'Newest', ''].map((label, i) => ({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: `<!-- widget-html -->${label ? `<div>${label}</div>` : ''}<!-- /widget-html -->` },
          { type: 'tool_use', id: `tool-${i}`, name: 'unknown', input: {} },
        ],
      }));
      responses.push({ stop_reason: 'end_turn', content: [] });
      assert.deepEqual(await runResponse(tier, responses, history), [
        { type: 'html_complete', html: '<div>Newest</div>' },
        { type: 'done', title: 'Custom Widget' },
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. HTML sanitizer
// ---------------------------------------------------------------------------
describe('widget-sanitizer — allowlist verification', () => {
  const san = src('src/utils/widget-sanitizer.ts');
  const configSource = san.match(/const PURIFY_CONFIG = (\{[\s\S]*?\n\});/);
  assert.ok(configSource, 'sanitizer configuration must be extractable');
  const config = vm.runInNewContext(`(${configSource[1]})`);

  const REQUIRED_ALLOWED_TAGS = ['div', 'span', 'p', 'table', 'svg', 'path'];
  const REQUIRED_FORBIDDEN_TAGS = ['button', 'input', 'script', 'iframe', 'form'];
  const REQUIRED_ALLOWED_ATTRS = ['class', 'style', 'viewBox', 'fill', 'stroke'];

  for (const tag of REQUIRED_ALLOWED_TAGS) {
    it(`allowed tag '${tag}' is in ALLOWED_TAGS`, () => {
      assert.ok(
        config.ALLOWED_TAGS.includes(tag),
        `Tag '${tag}' must be in ALLOWED_TAGS`,
      );
    });
  }

  for (const tag of REQUIRED_FORBIDDEN_TAGS) {
    it(`forbidden tag '${tag}' is in FORBID_TAGS`, () => {
      assert.ok(
        config.FORBID_TAGS.includes(tag) && !config.ALLOWED_TAGS.includes(tag),
        `Tag '${tag}' must be in FORBID_TAGS`,
      );
    });
  }

  for (const attr of REQUIRED_ALLOWED_ATTRS) {
    it(`attribute '${attr}' is in ALLOWED_ATTR`, () => {
      assert.ok(
        config.ALLOWED_ATTR.includes(attr),
        `Attr '${attr}' must be in ALLOWED_ATTR`,
      );
    });
  }

  it('FORCE_BODY is true (prevents <html> wrapper)', () => {
    assert.equal(config.FORCE_BODY, true);
  });

  it('does not allow event handlers, resource URLs or data attributes', () => {
    assert.equal(config.ALLOW_DATA_ATTR, false);
    assert.ok(config.ALLOWED_ATTR.every(attr => !/^on|^(?:src|href|xlink:href|srcdoc)$/i.test(attr)));
  });

  it('post-pass strips url() from style attributes', () => {
    assert.ok(
      san.includes('url') && (san.includes('UNSAFE_STYLE') || san.includes('unsafe')),
      'Must have post-pass regex stripping url() from style values',
    );
  });

  it('post-pass strips javascript: from style attributes', () => {
    assert.ok(
      san.includes('javascript'),
      'Must have post-pass regex stripping javascript: from style values',
    );
  });

  it('post-pass strips expression() from style attributes', () => {
    assert.ok(
      san.includes('expression'),
      'Must have post-pass regex stripping expression() from style values',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Panel guardrails — cw- exclusions
// ---------------------------------------------------------------------------
describe('panel guardrails — cw- prefix handling', () => {
  const settings = src('src/components/UnifiedSettings.ts');
  const events = src('src/app/event-handlers.ts');
  const layout = src('src/app/panel-layout.ts');

  it('UnifiedSettings excludes custom panels not present in the public catalog', () => {
    assert.match(settings, /const config = ALL_PANELS\[key\];\s*if \(!config\) return false;/);
  });

  it('event-handlers confirms before deleting cw- panels', () => {
    assert.ok(
      events.includes("startsWith('cw-')"),
      "event-handlers must detect cw- prefix for custom widget panels",
    );
    assert.ok(
      events.includes("t('widgets.confirmDelete')"),
      'Custom widget delete confirmation must use localized widgets.confirmDelete copy',
    );
    assert.ok(
      events.includes('confirm') || events.includes('window.confirm'),
      'Must show a confirm dialog before deleting custom widgets',
    );
  });

  it('event-handlers calls deleteWidget for cw- panels', () => {
    assert.ok(
      events.includes('deleteWidget'),
      'Must call deleteWidget() when removing a custom widget panel',
    );
  });

  it('event-handlers does not expose the retired AI modify action', () => {
    assert.doesNotMatch(events, /wm:widget-modify|WidgetChatModal/);
  });

  it('local add rejects a failed save before changing layout state or mounting a panel', async () => {
    const method = layout.match(/  async addCustomWidget\([\s\S]*?\n  \}/)?.[0];
    assert.ok(method, 'retained local add method must exist');
    const { code } = await transform(method.replace('async addCustomWidget', 'async function addCustomWidget'), { loader: 'ts' });
    const run = vm.runInNewContext(`${code}\naddCustomWidget`, {
      saveWidget: async () => { throw new Error('storage denied'); },
      saveToStorage: () => assert.fail('layout state must not be written after save failure'),
    });
    const ctx = { panelSettings: {} };
    await assert.rejects(run.call({ ctx, importPanel: () => assert.fail('panel must not mount after save failure') }, {}), /storage denied/);
    assert.deepEqual(ctx.panelSettings, {});
  });

  it('panel-layout restores local widgets without a premium gate', () => {
    assert.match(layout, /for \(const spec of loadWidgets\(\)\)/);
    assert.doesNotMatch(layout, /hasPremiumAccess|isProUser/);
  });

  it('panel-layout has addCustomWidget method', () => {
    assert.ok(
      layout.includes('addCustomWidget'),
      'panel-layout must implement addCustomWidget() method',
    );
  });

  it('panel-layout does not expose the retired AI or Pro creator', () => {
    assert.doesNotMatch(layout, /ai-widget-block|WidgetChatModal|applyProBlockGating/);
  });

  it('panel-layout DEV warning excludes cw- panels', () => {
    assert.ok(
      layout.includes("startsWith('cw-')"),
      "DEV warning must exclude panels with id.startsWith('cw-')",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. SSE event types
// ---------------------------------------------------------------------------
describe('widget-agent relay — SSE event protocol', () => {
  const relay = src('scripts/ais-relay.cjs');

  const EXPECTED_SSE_EVENTS = ['html_complete', 'done', 'error', 'tool_call'];

  for (const event of EXPECTED_SSE_EVENTS) {
    it(`SSE event '${event}' is sent by handler`, () => {
      assert.ok(
        relay.includes(`'${event}'`) || relay.includes(`"${event}"`),
        `SSE event '${event}' not found in relay handler`,
      );
    });
  }

  it('sendWidgetSSE helper is defined', () => {
    assert.ok(
      relay.includes('sendWidgetSSE') || relay.includes('function sendWidgetSSE'),
      'sendWidgetSSE helper must be defined',
    );
  });

  it('html_complete event carries html payload', () => {
    const idx = relay.indexOf('html_complete');
    assert.ok(idx !== -1);
    const region = relay.slice(idx - 50, idx + 200);
    assert.ok(region.includes('html'), "html_complete event must include 'html' field");
  });

  it('done event carries title payload', () => {
    const idx = relay.indexOf("'done'");
    assert.ok(idx !== -1);
    const region = relay.slice(idx, idx + 100);
    assert.ok(region.includes('title'), "done event must include 'title' field");
  });

  it('tool_call event carries endpoint for UI badge display', () => {
    const idx = relay.indexOf("'tool_call'");
    assert.ok(idx !== -1);
    const region = relay.slice(idx, idx + 150);
    assert.ok(region.includes('endpoint'), "tool_call event must include 'endpoint' field");
  });
});

// ---------------------------------------------------------------------------
// 8. Vite proxy + URL helper
// ---------------------------------------------------------------------------
describe('proxy routing — widgetAgentUrl', () => {
  const proxy = src('src/utils/proxy.ts');
  const vite = src('vite.config.ts');

  it('widgetAgentUrl() exists in proxy.ts', () => {
    assert.ok(
      proxy.includes('widgetAgentUrl'),
      'widgetAgentUrl() must be defined in src/utils/proxy.ts',
    );
  });

  it('widgetAgentUrl returns /widget-agent in dev (for Vite proxy)', () => {
    assert.ok(
      proxy.includes("'/widget-agent'") || proxy.includes('"/widget-agent"'),
      'widgetAgentUrl must return /widget-agent in dev mode',
    );
  });

  it('widgetAgentUrl targets proxy.worldmonitor.app (not toRuntimeUrl)', () => {
    // The URL may be in a constant above the function; search the whole file
    assert.ok(
      proxy.includes('proxy.worldmonitor.app'),
      'Must target proxy.worldmonitor.app directly (sidecar destroys SSE via arrayBuffer)',
    );
    // Verify the function itself does not use toRuntimeUrl
    const fnIdx = proxy.indexOf('function widgetAgentUrl');
    assert.ok(fnIdx !== -1, 'widgetAgentUrl function not found');
    const fnBody = proxy.slice(fnIdx, fnIdx + 400);
    assert.ok(
      !fnBody.includes('toRuntimeUrl'),
      'widgetAgentUrl must NOT use toRuntimeUrl — sidecar buffers via arrayBuffer, destroying SSE',
    );
  });

  it('the public fork does not proxy the retired widget builder route', () => {
    assert.doesNotMatch(vite, /['"]\/widget-agent['"]\s*:/);
  });

  it('widgetAgentHealthUrl() exists and targets /widget-agent/health', () => {
    assert.ok(proxy.includes('widgetAgentHealthUrl'), 'widgetAgentHealthUrl() must be defined');
    assert.ok(proxy.includes('/widget-agent/health'), 'widgetAgentHealthUrl() must target /widget-agent/health');
  });
});

// ---------------------------------------------------------------------------
// 9. i18n completeness
// ---------------------------------------------------------------------------
describe('i18n — widgets section completeness', () => {
  const en = JSON.parse(src('src/locales/en.json'));

  const REQUIRED_KEYS = [
    'confirmDelete',
    'chatTitle',
    'modifyTitle',
    'inputPlaceholder',
    'addToDashboard',
    'applyChanges',
    'send',
    'modifyWithAi',
    'ready',
    'fetching',
    'requestTimedOut',
    'serverError',
    'unknownError',
    'generatedWidget',
    'checkingConnection',
    'preflightConnected',
    'preflightInvalidKey',
    'preflightUnavailable',
    'preflightAiUnavailable',
    'saveFailed',
    'readyToGenerate',
    'readyToApply',
    'modifyHint',
    'generating',
    'examplesTitle',
    'previewTitle',
    'phaseChecking',
    'phaseReadyToPrompt',
    'phaseFetching',
    'phaseComposing',
    'phaseComplete',
    'phaseError',
    'previewCheckingHeading',
    'previewReadyHeading',
    'previewFetchingHeading',
    'previewComposingHeading',
    'previewErrorHeading',
    'previewCheckingCopy',
    'previewReadyCopy',
    'previewFetchingCopy',
    'previewComposingCopy',
    'previewErrorCopy',
  ];

  for (const key of REQUIRED_KEYS) {
    it(`widgets.${key} is defined and non-empty`, () => {
      assert.ok(
        en.widgets && typeof en.widgets[key] === 'string' && en.widgets[key].length > 0,
        `en.json must have non-empty widgets.${key}`,
      );
    });
  }

  it('confirmDelete text sounds permanent (not just hide)', () => {
    assert.ok(
      en.widgets.confirmDelete.toLowerCase().includes('remove') ||
      en.widgets.confirmDelete.toLowerCase().includes('delete') ||
      en.widgets.confirmDelete.toLowerCase().includes('permanent'),
      'confirmDelete must convey permanence — not just hide',
    );
  });

  it('local widget deletion uses the localized confirmation label', () => {
    const events = src('src/app/event-handlers.ts');
    assert.ok(events.includes("t('widgets.confirmDelete')"), 'Delete confirmation must use widgets.confirmDelete');
  });

  it('prompt examples are defined and non-empty', () => {
    const exampleKeys = ['oilGold', 'cryptoMovers', 'flightDelays', 'conflictHotspots'];
    for (const key of exampleKeys) {
      assert.ok(
        typeof en.widgets.examples[key] === 'string' && en.widgets.examples[key].length > 0,
        `en.json must have non-empty widgets.examples.${key}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 10. CustomWidgetPanel
// ---------------------------------------------------------------------------
describe('CustomWidgetPanel — local rendering', () => {
  const panel = src('src/components/CustomWidgetPanel.ts');
  const sanitizer = src('src/utils/widget-sanitizer.ts');

  it('does not expose the retired AI modify action', () => {
    assert.doesNotMatch(panel, /wm:widget-modify|WidgetChatModal/);
  });

  it('applies --widget-accent CSS variable', () => {
    assert.ok(
      panel.includes('--widget-accent'),
      'CustomWidgetPanel must apply --widget-accent CSS variable',
    );
  });

  it('renderWidget uses shared wrapped widget HTML helper', () => {
    assert.ok(
      panel.includes('wrapWidgetHtml'),
      'renderWidget must use wrapWidgetHtml() for shell + sanitization',
    );
    assert.ok(
      sanitizer.includes('sanitizeWidgetHtml'),
      'wrapWidgetHtml() must sanitize HTML internally',
    );
    assert.ok(
      sanitizer.includes('wm-widget-generated'),
      'wrapWidgetHtml() must provide a contained generated-widget wrapper',
    );
  });

  it('extends Panel (display-only widget with panel infrastructure)', () => {
    assert.ok(
      panel.includes('extends Panel'),
      'CustomWidgetPanel must extend Panel',
    );
  });

  it('does not render executable Pro iframes', () => {
    assert.doesNotMatch(panel, /wrapProWidgetHtml|mountProWidget/);
  });

  it('does not display the retired Pro badge', () => {
    assert.doesNotMatch(panel, /widget-pro-badge/);
  });
});

// Execute retained widget code without browser imports, config or app startup.
async function localWidgetRenderer() {
  const sanitizerCalls = [];
  let styleHook;
  const sanitizerModule = { exports: {} };
  const sanitizerCode = await transform(src('src/utils/widget-sanitizer.ts'), { loader: 'ts', format: 'cjs' });
  vm.runInNewContext(sanitizerCode.code, {
    module: sanitizerModule, exports: sanitizerModule.exports,
    require: name => {
      assert.equal(name, 'dompurify');
      return {
        addHook(name, hook) {
          assert.equal(name, 'uponSanitizeAttribute');
          styleHook = hook;
        },
        sanitize(html, config) {
          sanitizerCalls.push({ html, config });
          return '<p>sanitized fixture</p>';
        },
      };
    },
  });
  class Panel {
    constructor() {
      this.title = { textContent: '' };
      this.header = { querySelector: selector => {
        assert.equal(selector, '.panel-title');
        return this.title;
      } };
      this.properties = new Map();
      this.element = { style: {
        setProperty: (name, value) => this.properties.set(name, value),
        removeProperty: name => this.properties.delete(name),
      } };
    }
    setSafeContent(html) { this.content = html.toString(); }
  }
  const panelModule = { exports: {} };
  const panelCode = await transform(src('src/components/CustomWidgetPanel.ts'), { loader: 'ts', format: 'cjs' });
  vm.runInNewContext(panelCode.code, {
    module: panelModule, exports: panelModule.exports,
    require: name => {
      if (name === './Panel') return { Panel };
      if (name === '@/utils/widget-sanitizer') return sanitizerModule.exports;
      assert.equal(name, '@/utils/sanitize');
      return { unsafeRawHtml };
    },
  });
  return { sanitizerCalls, styleHook, ...sanitizerModule.exports, ...panelModule.exports };
}

describe('basic widgets — sanitizer boundary and renderer behavior', () => {
  it('the production style hook rejects unsafe CSS without stripping ordinary styles', async () => {
    const { styleHook } = await localWidgetRenderer();
    for (const style of [
      'background:url(https://example.com/x)', 'width:expression(alert(1))',
      'color:javascript:alert(1)', '@import "https://example.com/x"', 'behavior:url(x)',
    ]) {
      const attribute = { attrName: 'style', attrValue: style, keepAttr: true };
      styleHook(null, attribute);
      assert.equal(attribute.keepAttr, false, style);
    }
    const safe = { attrName: 'style', attrValue: 'color:red', keepAttr: true };
    styleHook(null, safe);
    assert.equal(safe.keepAttr, true);
    const title = { attrName: 'title', attrValue: 'url(example)', keepAttr: true };
    styleHook(null, title);
    assert.equal(title.keepAttr, true);
  });

  it('wraps the sanitizer result, not raw HTML, and removes a generated duplicate header', async () => {
    const { wrapWidgetHtml, sanitizerCalls } = await localWidgetRenderer();
    const result = wrapWidgetHtml(
      '<div class="panel-header">Duplicate title</div><div onclick="alert(1)">42</div>',
    );
    assert.equal(sanitizerCalls.length, 1);
    assert.equal(sanitizerCalls[0].html, '<div onclick="alert(1)">42</div>');
    assert.match(result, /<div class="wm-widget-shell"><div class="wm-widget-body">\s*<div class="wm-widget-generated"><p>sanitized fixture<\/p><\/div>/);
    assert.doesNotMatch(result, /onclick|Duplicate title/);
  });

  it('renders and updates basic content, assigns titles as text, and resets accent state', async () => {
    const { CustomWidgetPanel, sanitizerCalls } = await localWidgetRenderer();
    const spec = {
      id: 'cw-local', title: 'Local widget', tier: 'basic', html: '<div>First</div>',
      prompt: '', accentColor: '#123456', conversationHistory: [], createdAt: 1, updatedAt: 1,
    };
    const panel = new CustomWidgetPanel(spec);
    assert.equal(sanitizerCalls[0].html, '<div>First</div>');
    assert.match(panel.content, /wm-widget-generated"><p>sanitized fixture<\/p>/);
    assert.equal(panel.properties.get('--widget-accent'), '#123456');
    const next = { ...spec, title: '<img src=x onerror=alert(1)>', html: '<p>Updated</p><script>alert(1)</script>', accentColor: null };
    panel.updateSpec(next);
    assert.equal(panel.title.textContent, next.title);
    assert.equal(sanitizerCalls.length, 2);
    assert.equal(sanitizerCalls[1].html, next.html);
    assert.doesNotMatch(panel.content, /script|alert/);
    assert.equal(panel.properties.has('--widget-accent'), false);
    assert.equal(panel.getSpec(), next);
  });
});

// ---------------------------------------------------------------------------
// 11. PRO widget — relay
// ---------------------------------------------------------------------------
describe('PRO widget — relay auth and configuration', () => {
  const relay = src('scripts/ais-relay.cjs');

  it('PRO_WIDGET_KEY is read from env', () => {
    assert.ok(
      relay.includes('PRO_WIDGET_KEY'),
      'PRO_WIDGET_KEY must be defined from env',
    );
  });

  it('PRO_WIDGET_RATE_LIMIT is 20', () => {
    const match = relay.match(/PRO_WIDGET_RATE_LIMIT\s*=\s*(\d+)/);
    assert.ok(match, 'PRO_WIDGET_RATE_LIMIT constant not found');
    assert.equal(Number(match[1]), 20, 'PRO_WIDGET_RATE_LIMIT must be 20');
  });

  it('proWidgetRateLimitMap is a separate rate limit bucket from basic', () => {
    assert.ok(
      relay.includes('proWidgetRateLimitMap'),
      'PRO must use a separate rate limit map (proWidgetRateLimitMap)',
    );
    // Must also have the basic bucket
    assert.ok(
      relay.includes('widgetRateLimitMap'),
      'Basic must have its own rate limit map (widgetRateLimitMap)',
    );
    // Verify they are different variables
    assert.notEqual(
      relay.indexOf('proWidgetRateLimitMap'),
      relay.indexOf('widgetRateLimitMap'),
      'PRO and basic must use separate rate limit maps',
    );
  });

  it('x-pro-key header is read for PRO auth', () => {
    assert.ok(
      relay.includes("req.headers['x-pro-key']") || relay.includes('x-pro-key'),
      "Handler must read req.headers['x-pro-key'] for PRO auth",
    );
  });

  it('PRO request rejected with 403 when x-pro-key is wrong', () => {
    assert.ok(
      relay.includes('getWidgetAgentProvidedProKey'),
      'getWidgetAgentProvidedProKey function must be defined',
    );
    // The PRO key comparison is near the 403 rejection — find it directly
    const keyCompareIdx = relay.indexOf('!safeTokenEquals(providedProKey, PRO_WIDGET_KEY)');
    assert.ok(keyCompareIdx !== -1, 'PRO key comparison must be present');
    const region = relay.slice(keyCompareIdx, keyCompareIdx + 200);
    assert.ok(region.includes('403'), 'Wrong PRO key must return 403');
  });

  it('invalid tier value rejected with 400', () => {
    assert.ok(
      relay.includes("tier !== 'basic' && tier !== 'pro'") ||
      relay.includes("!['basic', 'pro'].includes(tier)") ||
      (relay.includes("tier === 'pro'") && relay.includes('400')),
      'Invalid tier must be rejected with 400',
    );
  });

  it('health endpoint includes proKeyConfigured boolean', () => {
    const healthIdx = relay.indexOf('getWidgetAgentStatus');
    assert.ok(healthIdx !== -1, 'getWidgetAgentStatus not found');
    const region = relay.slice(healthIdx, healthIdx + 400);
    assert.ok(
      region.includes('proKeyConfigured'),
      'Health/status response must include proKeyConfigured field',
    );
  });

  it('PRO uses claude-sonnet model (not haiku)', () => {
    assert.ok(
      relay.includes('claude-sonnet'),
      'PRO tier must use claude-sonnet model',
    );
  });

  it('PRO max_tokens is 8192', () => {
    // maxTokens is set via isPro ternary, then passed to max_tokens
    assert.ok(
      relay.includes('isPro ? 8192') || relay.includes('isPro?8192') || relay.includes('8192'),
      'PRO max_tokens must be 8192',
    );
    const tokenMatch = relay.match(/maxTokens\s*=\s*isPro\s*\?\s*8192/) || relay.match(/isPro\s*\?\s*8192/);
    assert.ok(tokenMatch, 'maxTokens must be set to 8192 when isPro');
  });

  it('WIDGET_PRO_SYSTEM_PROMPT exists and forbids DOCTYPE/html wrappers', () => {
    assert.ok(
      relay.includes('WIDGET_PRO_SYSTEM_PROMPT'),
      'WIDGET_PRO_SYSTEM_PROMPT constant must be defined',
    );
    // Use lastIndexOf to find the constant definition (not earlier references/usages)
    const promptIdx = relay.lastIndexOf('WIDGET_PRO_SYSTEM_PROMPT');
    const promptRegion = relay.slice(promptIdx, promptIdx + 2000);
    // PRO system prompt must instruct "body only" (no full page generation)
    assert.ok(
      promptRegion.includes('body') || promptRegion.includes('<body>'),
      'PRO system prompt must instruct generating body content only',
    );
  });

  it('PRO system prompt allows cdn.jsdelivr.net for Chart.js', () => {
    // Use lastIndexOf to find the constant definition
    const promptIdx = relay.indexOf('const WIDGET_PRO_SYSTEM_PROMPT = `');
    const promptRegion = relay.slice(promptIdx, relay.indexOf('`;', promptIdx));
    assert.ok(
      promptRegion.includes('cdn.jsdelivr.net') || promptRegion.includes('chart.js') || promptRegion.includes('Chart.js'),
      'PRO system prompt must mention cdn.jsdelivr.net/Chart.js as allowed CDN',
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Retained sandbox artifact — origin and event security
// ---------------------------------------------------------------------------
describe('widget sandbox — origin and event security', () => {
  const sandbox = src('public/wm-widget-sandbox.html');

  it('widget sandbox allows approved Vercel previews and rejects lookalike origins', () => {
    assert.ok(
      sandbox.includes("url.hostname === 'worldmonitor.app'")
        && sandbox.includes("url.hostname.endsWith('.worldmonitor.app')"),
      'sandbox must parse hostname and allow the worldmonitor.app apex/subdomains only',
    );
    assert.ok(
      !sandbox.includes("endsWith('worldmonitor.app')") && !sandbox.includes('endsWith("worldmonitor.app")'),
      'sandbox must not use raw suffix checks that allow evilworldmonitor.app',
    );
    // The sandbox must source allowed Vercel team slugs from a single named
    // list — keeps the security invariant (team-slug gating) visible and
    // makes teammate-slug additions a one-line change rather than a regex
    // rewrite that could accidentally widen the match.
    const teamListMatch = sandbox.match(
      /var\s+ALLOWED_VERCEL_TEAM_SLUGS\s*=\s*\[([^\]]*)\];/,
    );
    assert.ok(teamListMatch, 'sandbox must declare ALLOWED_VERCEL_TEAM_SLUGS as a literal array');
    const slugs = teamListMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    assert.ok(slugs.includes('eliewm'), 'project-owner team slug must remain in the allowlist');
    for (const slug of slugs) {
      assert.match(slug, /^[a-z0-9-]+$/, `team slug "${slug}" must be url-safe`);
    }
    // Reconstruct the actual match function and exercise it against the
    // production slug list — this is what protects against regex drift
    // when teammate slugs are added later. The team slug is the LAST hostname
    // segment before .vercel.app (eliewm team scope); keep this shape in lock-
    // step with isAllowedVercelPreview in public/wm-widget-sandbox.html.
    const matchesAllowedTeam = (hostname) =>
      slugs.some((team) =>
        new RegExp('^worldmonitor-[a-z0-9-]+-' + team + '\\.vercel\\.app$').test(hostname),
      );
    assert.equal(matchesAllowedTeam('worldmonitor-git-feature-eliewm.vercel.app'), true);
    assert.equal(matchesAllowedTeam('worldmonitor-abc123-eliewm.vercel.app'), true);
    assert.equal(matchesAllowedTeam('worldmonitor-feature-attacker.vercel.app'), false);
    assert.equal(matchesAllowedTeam('worldmonitor-git-feature-eliewm.vercel.app.evil.com'), false);
    assert.equal(matchesAllowedTeam('worldmonitor-feature-xeliewm.vercel.app'), false);
    assert.equal(matchesAllowedTeam('evilworldmonitor.app'), false);
    // The retired personal scope (worldmonitor-*-elie-<hash>) must no longer match.
    assert.equal(matchesAllowedTeam('worldmonitor-feature-elie-abc123.vercel.app'), false);
    // A teammate slug added to the list must extend coverage WITHOUT
    // matching look-alike teams whose slug merely starts with the same
    // letters.
    const withTeammate = ['eliewm', 'kieran'];
    const matchesWithTeammate = (hostname) =>
      withTeammate.some((team) =>
        new RegExp('^worldmonitor-[a-z0-9-]+-' + team + '\\.vercel\\.app$').test(hostname),
      );
    assert.equal(matchesWithTeammate('worldmonitor-feature-kieran.vercel.app'), true);
    assert.equal(matchesWithTeammate('worldmonitor-feature-kieranfake.vercel.app'), false);
  });

  it('widget sandbox behavior accepts Vercel previews and blocks spoofed parents', () => {
    const script = sandbox.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>/)?.[1];
    assert.ok(script, 'sandbox inline script not found');

    function runSandbox(referrer, sandboxProtocol = 'https:') {
      const readyMessages = [];
      const writes = [];
      const listeners = new Map();
      const parent = {
        postMessage(payload, targetOrigin) {
          readyMessages.push({ payload, targetOrigin });
        },
      };
      function FakeEventTarget() {}
      FakeEventTarget.prototype.addEventListener = (type, listener) => {
        listeners.set(type, listener);
      };
      function FakeEvent() {}
      FakeEvent.prototype.stopImmediatePropagation = () => {};
      const sandboxWindow = new FakeEventTarget();
      sandboxWindow.location = { hash: '#id=wm-1&token=test-token', protocol: sandboxProtocol };
      sandboxWindow.parent = parent;
      const context = {
        URL,
        URLSearchParams,
        Event: FakeEvent,
        EventTarget: FakeEventTarget,
        document: {
          referrer,
          open() {},
          write(html) {
            writes.push(html);
          },
          close() {},
        },
        window: sandboxWindow,
      };
      vm.runInNewContext(script, context);
      const message = listeners.get('message');
      assert.equal(typeof message, 'function', 'message listener must be registered');
      return { parent, readyMessages, writes, message };
    }

    const allowed = runSandbox('https://worldmonitor-git-feature-eliewm.vercel.app/dashboard');
    assert.equal(allowed.readyMessages.length, 1);
    assert.equal(allowed.readyMessages[0].targetOrigin, 'https://worldmonitor-git-feature-eliewm.vercel.app');
    assert.deepEqual(JSON.parse(JSON.stringify(allowed.readyMessages[0].payload)), {
      type: 'wm-widget-ready',
      id: 'wm-1',
      token: 'test-token',
    });
    allowed.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>ok</p>' },
      origin: 'https://worldmonitor-git-feature-eliewm.vercel.app',
      source: allowed.parent,
    });
    assert.deepEqual(allowed.writes, ['<p>ok</p>']);
    allowed.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>second</p>' },
      origin: 'https://worldmonitor-git-feature-eliewm.vercel.app',
      source: allowed.parent,
    });
    assert.deepEqual(allowed.writes, ['<p>ok</p>'], 'only the first accepted message may write');

    const invalidMessages = [
      {
        data: { type: 'other', id: 'wm-1', token: 'test-token', html: '<p>bad type</p>' },
        origin: 'https://worldmonitor.app',
      },
      {
        data: { type: 'wm-html', id: 'wrong-id', token: 'test-token', html: '<p>bad id</p>' },
        origin: 'https://worldmonitor.app',
      },
      {
        data: { type: 'wm-html', id: 'wm-1', token: 'wrong-token', html: '<p>bad token</p>' },
        origin: 'https://worldmonitor.app',
      },
    ];
    for (const invalidMessage of invalidMessages) {
      const rejected = runSandbox('https://worldmonitor.app/dashboard');
      rejected.message({ ...invalidMessage, source: rejected.parent });
      assert.deepEqual(rejected.writes, []);
    }

    const wrongSource = runSandbox('https://worldmonitor.app/dashboard');
    wrongSource.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>bad source</p>' },
      origin: 'https://worldmonitor.app',
      source: {},
    });
    assert.deepEqual(wrongSource.writes, []);

    const spoofed = runSandbox('https://worldmonitor-git-feature-eliewm.vercel.app.evil.com/');
    assert.deepEqual(spoofed.readyMessages, []);
    spoofed.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>bad</p>' },
      origin: 'https://worldmonitor-git-feature-eliewm.vercel.app.evil.com',
      source: spoofed.parent,
    });
    assert.deepEqual(spoofed.writes, []);
  });

  it('widget sandbox trusts a localhost referrer only when the sandbox itself is also running on localhost', () => {
    // This file (public/wm-widget-sandbox.html) ships byte-for-byte to
    // production -- there is no build-time dev/prod flag available inside
    // it. Anyone can run their own local HTTP server and set
    // document.referrer to http://localhost freely, so trusting that
    // referrer alone would let such a page embed the PRODUCTION sandbox
    // and receive real widget HTML. The fix requires window.location
    // (the sandbox's own, unspoofable origin) to also be localhost.
    const script = sandbox.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>/)?.[1];
    assert.ok(script, 'sandbox inline script not found');

    function runSandboxAt(selfHostname, referrer) {
      const readyMessages = [];
      const writes = [];
      const listeners = new Map();
      const parent = {
        postMessage(payload, targetOrigin) {
          readyMessages.push({ payload, targetOrigin });
        },
      };
      function FakeEventTarget() {}
      FakeEventTarget.prototype.addEventListener = (type, listener) => {
        listeners.set(type, listener);
      };
      function FakeEvent() {}
      FakeEvent.prototype.stopImmediatePropagation = () => {};
      const sandboxWindow = new FakeEventTarget();
      sandboxWindow.location = { hash: '#id=wm-1&token=test-token', hostname: selfHostname };
      sandboxWindow.parent = parent;
      const context = {
        URL,
        URLSearchParams,
        Event: FakeEvent,
        EventTarget: FakeEventTarget,
        document: {
          referrer,
          open() {},
          write(html) {
            writes.push(html);
          },
          close() {},
        },
        window: sandboxWindow,
      };
      vm.runInNewContext(script, context);
      const message = listeners.get('message');
      assert.equal(typeof message, 'function', 'message listener must be registered');
      return { parent, readyMessages, writes, message };
    }

    // Production sandbox (window.location.hostname === worldmonitor.app)
    // embedded by a page whose referrer claims http://localhost: must be
    // rejected outright, both for the initial readiness ping and for a
    // forged wm-html delivery attempt.
    const prodAgainstLocalhostReferrer = runSandboxAt('worldmonitor.app', 'http://localhost:5173/dashboard');
    assert.deepEqual(
      prodAgainstLocalhostReferrer.readyMessages,
      [],
      'production sandbox must not send the readiness ping to a localhost-claiming referrer',
    );
    prodAgainstLocalhostReferrer.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>should not render</p>' },
      origin: 'http://localhost:5173',
      source: prodAgainstLocalhostReferrer.parent,
    });
    assert.deepEqual(
      prodAgainstLocalhostReferrer.writes,
      [],
      'production sandbox must not accept HTML claiming to come from localhost',
    );

    // Same check for 127.0.0.1.
    const prodAgainst127Referrer = runSandboxAt('worldmonitor.app', 'http://127.0.0.1:5173/dashboard');
    assert.deepEqual(prodAgainst127Referrer.readyMessages, []);

    // Legitimate local dev: both the sandbox page itself and the embedding
    // page run on localhost (e.g. `npm run dev`). This must keep working.
    const devSandbox = runSandboxAt('localhost', 'http://localhost:5173/dashboard');
    assert.equal(devSandbox.readyMessages.length, 1, 'dev sandbox on localhost must still trust a localhost parent');
    assert.equal(devSandbox.readyMessages[0].targetOrigin, 'http://localhost:5173');
    devSandbox.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>dev ok</p>' },
      origin: 'http://localhost:5173',
      source: devSandbox.parent,
    });
    assert.deepEqual(devSandbox.writes, ['<p>dev ok</p>']);

    // 127.0.0.1 sandbox self-origin (some dev setups bind there instead).
    const dev127Sandbox = runSandboxAt('127.0.0.1', 'http://127.0.0.1:5173/dashboard');
    assert.equal(dev127Sandbox.readyMessages.length, 1, '127.0.0.1 dev sandbox must trust a 127.0.0.1 parent');

    // HTTPS variants — same hostname gate, protocol-agnostic for localhost.
    const prodHttpsLocalhost = runSandboxAt('worldmonitor.app', 'https://localhost:5173/dashboard');
    assert.deepEqual(prodHttpsLocalhost.readyMessages, [], 'prod must block https localhost too');
    prodHttpsLocalhost.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>should not render</p>' },
      origin: 'https://localhost:5173',
      source: prodHttpsLocalhost.parent,
    });
    assert.deepEqual(prodHttpsLocalhost.writes, []);
    const prodHttps127 = runSandboxAt('worldmonitor.app', 'https://127.0.0.1:5173/dashboard');
    assert.deepEqual(prodHttps127.readyMessages, []);
    const devHttpsLocalhost = runSandboxAt('localhost', 'https://localhost:5173/dashboard');
    assert.equal(devHttpsLocalhost.readyMessages.length, 1, 'dev localhost must trust https localhost parent');
    assert.equal(devHttpsLocalhost.readyMessages[0].targetOrigin, 'https://localhost:5173');
    devHttpsLocalhost.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>dev https ok</p>' },
      origin: 'https://localhost:5173',
      source: devHttpsLocalhost.parent,
    });
    assert.deepEqual(devHttpsLocalhost.writes, ['<p>dev https ok</p>']);
    const devHttps127 = runSandboxAt('127.0.0.1', 'https://127.0.0.1:5173/dashboard');
    assert.equal(devHttps127.readyMessages.length, 1, '127.0.0.1 dev must trust https 127.0.0.1 parent');
  });

  it('widget sandbox blocks beforeunload without breaking normal events before widget execution', () => {
    const script = sandbox.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>/)?.[1];
    assert.ok(script, 'sandbox inline script not found');

    function FakeEvent(type) {
      this.type = type;
      this.immediatePropagationStopped = false;
    }

    FakeEvent.prototype.stopImmediatePropagation = function () {
      this.immediatePropagationStopped = true;
    };

    function FakeEventTarget() {
      this.listeners = new Map();
    }

    FakeEventTarget.prototype.addEventListener = function (type, listener, options) {
      const entries = this.listeners.get(type) ?? [];
      entries.push({ listener, options });
      this.listeners.set(type, entries);
    };

    FakeEventTarget.prototype.dispatchEvent = function (event) {
      const entries = [...(this.listeners.get(event.type) ?? [])];
      for (const entry of entries) {
        if (typeof entry.listener === 'function') {
          entry.listener.call(this, event);
        } else {
          entry.listener.handleEvent.call(entry.listener, event);
        }
        if (event.immediatePropagationStopped) break;
        if (entry.options?.once) {
          const current = this.listeners.get(event.type) ?? [];
          this.listeners.set(event.type, current.filter((candidate) => candidate !== entry));
        }
      }
      return true;
    };

    const parent = { postMessage() {} };
    const sandboxWindow = new FakeEventTarget();
    sandboxWindow.location = { hash: '#id=wm-1&token=test-token' };
    sandboxWindow.parent = parent;

    let guardedAtWrite = false;
    let vmContext;
    const document = {
      referrer: 'https://worldmonitor.app/dashboard',
      open() {
        // Real document.open() clears Window listeners. The guard must restore
        // its stopper after this reset and before widget HTML begins parsing.
        sandboxWindow.listeners.clear();
      },
      write(html) {
        sandboxWindow.onbeforeunload = () => 'too late';
        sandboxWindow.addEventListener('beforeunload', () => {
          sandboxWindow.beforeUnloadCalls++;
        });
        guardedAtWrite = sandboxWindow.onbeforeunload === null
          && (sandboxWindow.listeners.get('beforeunload')?.length ?? 0) === 1;

        for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/gi)) {
          vm.runInContext(match[1], vmContext);
        }
      },
      close() {},
    };

    vmContext = vm.createContext({
      URL,
      URLSearchParams,
      Event: FakeEvent,
      EventTarget: FakeEventTarget,
      document,
      window: sandboxWindow,
    });
    vm.runInContext(script, vmContext);

    const message = sandboxWindow.listeners.get('message')?.[0]?.listener;
    assert.equal(typeof message, 'function', 'message listener must be registered');

    const widgetHtml = `<script>
window.beforeUnloadCalls = 0;
window.clickCalls = 0;
window.onbeforeunload = function () {
  window.beforeUnloadCalls++;
  return 'blocked';
};
window.addEventListener('beforeunload', function () {
  window.beforeUnloadCalls++;
});
EventTarget.prototype.addEventListener.call(window, 'beforeunload', function () {
  window.beforeUnloadCalls++;
});
window.addEventListener('click', {
  handleEvent: function () {
    window.clickCalls++;
  }
}, { once: true, passive: true });
window.dispatchEvent(new Event('beforeunload'));
window.dispatchEvent(new Event('click'));
window.dispatchEvent(new Event('click'));
</script>`;

    assert.doesNotThrow(() => {
      message.call(sandboxWindow, {
        data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: widgetHtml },
        origin: 'https://worldmonitor.app',
        source: parent,
      });
    });

    assert.equal(guardedAtWrite, true, 'beforeunload guard must be active when document.write starts');
    assert.equal(sandboxWindow.onbeforeunload, null, 'onbeforeunload assignments must remain inert');
    sandboxWindow.onbeforeunload = () => 'still blocked';
    assert.equal(sandboxWindow.onbeforeunload, null, 'ordinary reassignment must not restore onbeforeunload');
    assert.equal(sandboxWindow.beforeUnloadCalls, 0, 'the native stopper must block later beforeunload handlers');
    assert.equal(sandboxWindow.clickCalls, 1, 'listener objects and normal event options must still work');
  });

});

// ---------------------------------------------------------------------------
// 14. Retained local widget styles
// ---------------------------------------------------------------------------
describe('basic widget — CSS containment', () => {
  const css = src('src/styles/main.css');

  it('local panel borders use the per-widget accent with the dashboard fallback', () => {
    assert.match(css, /\.custom-widget-panel\s*\{[^}]*border-top:[^;]*var\(--widget-accent, var\(--accent\)\)/);
  });

  it('basic generated content remains contained within its panel', () => {
    const generated = css.match(/\.wm-widget-generated\s*\{([^}]+)\}/)?.[1];
    assert.ok(generated);
    assert.match(generated, /isolation:\s*isolate/);
    assert.match(generated, /contain:\s*layout paint/);
    assert.match(generated, /overflow:\s*clip/);
  });
});

// ---------------------------------------------------------------------------
// widget-agent relay — error classifier (no more opaque "Agent error")
// ---------------------------------------------------------------------------
//
// The relay used to swallow ALL agent errors as a generic "Agent error" SSE
// message. With nothing in Railway logs to grep and nothing useful in the
// client, real failures (auth, rate limit, model availability, payload shape)
// were impossible to triage. Lock in the classifier so future regressions
// can't re-collapse the error surface.
describe('widget-agent relay — error classifier', () => {
  const relay = src('scripts/ais-relay.cjs');

  it('classifyWidgetAgentError function is defined', () => {
    assert.ok(
      /function\s+classifyWidgetAgentError\s*\(/.test(relay),
      'classifyWidgetAgentError(err, model) helper must exist',
    );
  });

  it('catch block routes through classifyWidgetAgentError instead of hardcoded "Agent error"', () => {
    // Find the catch block in the widget-agent handler.
    const catchIdx = relay.indexOf("classifyWidgetAgentError");
    assert.ok(catchIdx !== -1, 'classifyWidgetAgentError must be called somewhere in the relay');
    // The catch site must NOT still emit the literal "Agent error" string as
    // its primary message — the classifier covers the fallback case itself.
    // Allow the literal in the classifier's last-resort branch only.
    const handlerStart = relay.indexOf('async function handleWidgetAgentRequest');
    const handlerEnd = relay.indexOf('async function ', handlerStart + 1);
    const handlerRegion = relay.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 5000);
    assert.ok(
      !/sendWidgetSSE\([^)]*'error'[^)]*'Agent error'/.test(handlerRegion),
      'catch site must NOT hardcode "Agent error" — route through classifyWidgetAgentError so the client sees actionable diagnostics',
    );
  });

  it('classifier maps Anthropic 401 to an operator-facing API-key hint', () => {
    const fnIdx = relay.indexOf('function classifyWidgetAgentError');
    const region = relay.slice(fnIdx, fnIdx + 3000);
    assert.ok(
      /status\s*===\s*401|authentication_error/.test(region),
      'Classifier must branch on status 401 / authentication_error',
    );
    assert.ok(
      /ANTHROPIC_API_KEY|API key/i.test(region),
      'Classifier 401 branch must hint at the env-var/credential to check',
    );
  });

  it('classifier surfaces 400 invalid_request_error with the SDK message (capped)', () => {
    const fnIdx = relay.indexOf('function classifyWidgetAgentError');
    const region = relay.slice(fnIdx, fnIdx + 3000);
    assert.ok(
      /status\s*===\s*400|invalid_request_error/.test(region),
      'Classifier must branch on status 400 / invalid_request_error',
    );
    assert.ok(
      /Invalid request to AI backend/.test(region),
      'Classifier must include human-readable phrasing for invalid-request errors',
    );
  });

  it('classifier scrubs Claude API keys from any fallback message', () => {
    const fnIdx = relay.indexOf('function classifyWidgetAgentError');
    const region = relay.slice(fnIdx, fnIdx + 3000);
    assert.ok(
      /sk-(?:ant-)?\[A-Za-z0-9_-\]\{20,?\}/.test(region) || /sk-\(\?:ant-\)\?\[A-Za-z0-9_-\]/.test(region),
      'Classifier fallback must redact `sk-…` / `sk-ant-…` API keys before surfacing the message',
    );
    assert.ok(
      /\[REDACTED\]/.test(region),
      'Classifier must replace scrubbed token with a [REDACTED] sentinel',
    );
  });

  it('classifier scrubs API keys in the 400 branch (defence-in-depth on every rawMsg interpolation)', () => {
    // Round-trip the function for runtime check: the 400 message must redact a Claude key.
    const fnMatch = relay.match(/function classifyWidgetAgentError[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'classifyWidgetAgentError function not extractable');
    const fn = new Function(`${fnMatch[0]}; return classifyWidgetAgentError;`)();
    const out = fn(
      { status: 400, error: { type: 'invalid_request_error' }, message: 'bad header sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA was rejected' },
      'claude-sonnet-4-6',
    );
    assert.ok(
      /\[REDACTED\]/.test(out),
      `400 branch must scrub sk-(ant-)? tokens before surfacing rawMsg, got: ${out}`,
    );
    assert.ok(
      !/sk-ant-api03-AAAAAAAAAA/.test(out),
      '400 branch must not leak the raw API key in any form',
    );
  });

  it('classifier handles Anthropic APITimeoutError (status 408) — does not fall through to fallback', () => {
    const fnMatch = relay.match(/function classifyWidgetAgentError[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'classifyWidgetAgentError function not extractable');
    const fn = new Function(`${fnMatch[0]}; return classifyWidgetAgentError;`)();
    // Real Anthropic Node SDK timeout shape: name='APITimeoutError', status=408
    const apiTimeout = fn({ name: 'APITimeoutError', status: 408, message: 'Request timeout.' }, 'claude-sonnet-4-6');
    assert.equal(apiTimeout, 'AI backend timed out', 'APITimeoutError must classify as timed-out, not fallback');
    // AbortSignal.timeout() shape (DOMException): name='TimeoutError'
    const abortTimeout = fn({ name: 'TimeoutError', message: 'The operation timed out.' }, 'claude-sonnet-4-6');
    assert.equal(abortTimeout, 'AI backend timed out', 'AbortSignal TimeoutError must also classify as timed-out');
    // Bare 408 status (some HTTP layers expose only the code) — same branch.
    const bare408 = fn({ status: 408 }, 'claude-sonnet-4-6');
    assert.equal(bare408, 'AI backend timed out', 'Bare status 408 must classify as timed-out');
  });

  it('400 branch does NOT pre-empt timeout: APITimeoutError-with-status-400 stays a timeout (rare but defensive)', () => {
    // Belt-and-suspenders: the timeout check sits BEFORE the 400 branch, so
    // an APITimeoutError tagged with status 400 (defensive against future SDK
    // shape changes) still classifies as a timeout, not "Invalid request".
    const fnMatch = relay.match(/function classifyWidgetAgentError[\s\S]*?\n\}/);
    const fn = new Function(`${fnMatch[0]}; return classifyWidgetAgentError;`)();
    const out = fn({ name: 'APITimeoutError', status: 400, message: 'timeout' }, 'claude-sonnet-4-6');
    assert.equal(out, 'AI backend timed out', 'APITimeoutError must beat the 400 branch regardless of status');
  });

  it('handler logs structured error context with status + type + model', () => {
    const handlerStart = relay.indexOf('async function handleWidgetAgentRequest');
    const handlerEnd = relay.indexOf('async function ', handlerStart + 1);
    const region = relay.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 8000);
    // Look for the structured console.error inside the catch.
    assert.ok(
      /console\.error\([^)]*\[widget-agent\][^)]*Error/.test(region),
      'Catch must log a `[widget-agent] Error:` line for Railway operators to grep',
    );
    assert.ok(
      /\bstatus\b/.test(region) && /\btype\b/.test(region) && /\bmodel\b/.test(region),
      'Structured error log must include status + type + model so Railway logs are diagnosable without server-side reproduction',
    );
  });

  it('toolCallCount is declared OUTSIDE the try whose catch reads it (scoping regression guard)', () => {
    // Bug history: an earlier revision declared `let toolCallCount = 0` INSIDE the
    // outer agent-loop try block but read it from the catch. JavaScript `let`/`const`
    // is block-scoped, so the catch's structured log threw a ReferenceError every
    // time, which the inner log-try then caught and emitted the useless
    // "[widget-agent] Error (log-failed)" fallback — defeating the entire
    // diagnostic value of this PR. Lock the declaration position.
    const handlerStart = relay.indexOf('async function handleWidgetAgentRequest');
    assert.ok(handlerStart !== -1, 'handler not found');
    const handlerEnd = relay.indexOf('async function ', handlerStart + 1);
    const region = relay.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 12000);

    const declIdx = region.indexOf('let toolCallCount');
    assert.ok(declIdx !== -1, 'toolCallCount declaration not found');

    // The outer agent-loop try is the one whose first statement imports the
    // Anthropic SDK. Anchor on that specific shape so we ignore unrelated
    // try/catch blocks (request-body parse, search-tool fetch, log-fallback).
    const outerTryMatch = region.match(/try\s*\{\s*\n\s*const\s*\{\s*default:\s*Anthropic/);
    assert.ok(outerTryMatch, 'Outer agent-loop try block not found by anchor');
    const outerTryIdx = outerTryMatch.index;

    assert.ok(
      declIdx < outerTryIdx,
      `toolCallCount (declared at ${declIdx}) must be declared BEFORE the outer agent-loop try (try at ${outerTryIdx}). Putting it inside the try makes it inaccessible to the catch — the structured log throws ReferenceError and falls through to the useless "Error (log-failed)" fallback.`,
    );

    // Sanity-check: the catch payload still references toolCallCount, so this
    // test is actually guarding the load-bearing reference.
    assert.ok(
      /catch\s*\(\s*err[^)]*\)[\s\S]*?toolCallCount/.test(region),
      'Catch payload must still reference toolCallCount, otherwise this test is guarding nothing',
    );
  });
});
