import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModelSpeed, formatThroughput, modelIdsFromSession, parsePageThroughput } from "./speed.js";
import { renderSnapshot } from "./tui.js";

test("formats OpenRouter throughput", () => {
  assert.equal(formatThroughput(57), "57");
});

test("renders one throughput value per provider without latency", () => {
  const output = renderSnapshot({
    loading: false,
    updatedAt: 0,
    results: [{
      modelId: "openai/gpt-6-sol",
      providers: [
        { label: "OpenAI", throughput: 41 },
        { label: "OpenAI Fast", throughput: 54 },
      ],
    }],
  }, {
    percentile: "p50",
    providers: [
      { label: "OpenAI", tag: "openai" },
      { label: "OpenAI Fast", tag: "openai/fast" },
    ],
  });
  assert.match(output, /OpenAI\s+Fast/);
  assert.match(output, /6-sol\s+41\s+54/);
  assert.match(output, /upd/);
  assert.doesNotMatch(output, /gpt-6-sol|tok\/s|\/|p50|rolling|TTFT|latency/i);
});

test("parses throughput from the OpenRouter model page when endpoint metrics are empty", () => {
  const html = String.raw`<script>\"provider_slug\":\"openai\",\"stats\":{\"p50_throughput\":41,\"p75_throughput\":65}}<script>\"provider_slug\":\"openai/fast\",\"stats\":{\"p50_throughput\":54}}</script>`;
  assert.deepEqual(parsePageThroughput(html, [
    { label: "OpenAI", tag: "openai" },
    { label: "Fast", tag: "openai/fast" },
  ], "p50").map((provider) => provider.throughput), [41, 54]);
});

test("never borrows OpenAI stats for Fast when an endpoint has no stats", () => {
  const html = String.raw`<script>\"provider_slug\":\"openai\",\"stats\":null},{\"provider_slug\":\"openai/fast\",\"stats\":{\"p50_throughput\":82}</script>`;
  assert.deepEqual(parsePageThroughput(html, [
    { label: "OpenAI", tag: "openai" },
    { label: "Fast", tag: "openai/fast" },
  ], "p50").map((provider) => provider.throughput), [undefined, 82]);
});

test("distinguishes Fast, Flex, and standard rows even when their details buttons share a label", () => {
  const html = `<tr><th><button aria-label="Open OpenAI details">OpenAI</button></th><td>26<span> tps</span></td></tr>` +
    `<tr><th><button aria-label="Open OpenAI details">OpenAI Flex</button></th><td>40<span> tps</span></td></tr>` +
    `<tr><th><button aria-label="Open OpenAI details">OpenAI Fast</button></th><td>52<span> tps</span></td></tr>`;
  assert.deepEqual(parsePageThroughput(html, [
    { label: "OpenAI", tag: "openai" },
    { label: "Fast", tag: "openai/fast" },
    { label: "Flex", tag: "openai/flex" },
  ], "p50").map((provider) => provider.throughput), [26, 52, 40]);
});

test("matches Azure region rows by their aria-label region", () => {
  const html = `<tr><th>Azure</th><td>39<span> tps</span></td></tr>` +
    `<tr><th>Azure</th><td aria-label="Region: EU in-region">24<span> tps</span></td></tr>` +
    `<tr><th>Azure</th><td aria-label="Region: US in-region">23<span> tps</span></td></tr>`;
  assert.deepEqual(parsePageThroughput(html, [
    { label: "Azure", tag: "azure" },
    { label: "Azure EU", tag: "azure/eu" },
    { label: "Azure US", tag: "azure/us" },
  ], "p50").map((provider) => provider.throughput), [39, 24, 23]);
});

test("does not reuse the last Fast metric when a later refresh has no Fast measurement", async () => {
  const originalFetch = globalThis.fetch;
  let fastAvailable = true;
  globalThis.fetch = async (url) => String(url).includes("/api/v1/")
    ? new Response(JSON.stringify({ data: { endpoints: [] } }))
    : new Response(`<script>"provider_slug":"openai","stats":{"p50_throughput":41}},` +
      `{"provider_slug":"openai/fast","stats":${fastAvailable ? '{"p50_throughput":82}' : 'null'}}</script>`);
  try {
    const providers = [{ label: "OpenAI", tag: "openai" }, { label: "Fast", tag: "openai/fast" }];
    const first = await fetchModelSpeed("openai/gpt-6-sol", providers, "p50");
    assert.deepEqual(first.providers.map((provider) => provider.throughput), [41, 82]);
    fastAvailable = false;
    const second = await fetchModelSpeed("openai/gpt-6-sol", providers, "p50");
    assert.deepEqual(second.providers.map((provider) => provider.throughput), [41, undefined]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses exact provider rows for a Pro model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/v1/")) {
      return new Response(JSON.stringify({ data: { endpoints: [] } }));
    }
    return new Response("<tr><td><button aria-label=\"Open OpenAI details\"></button></td><td>110<span> tps</span></td></tr><tr><td><button aria-label=\"Open OpenAI Fast details\"></button></td><td>209<span> tps</span></td></tr>");
  };
  try {
    const result = await fetchModelSpeed("openai/gpt-6-luna-pro", [
      { label: "OpenAI", tag: "openai" },
      { label: "Fast", tag: "openai/fast" },
    ], "p50");
    assert.deepEqual(result.providers.map((provider) => provider.throughput), [110, 209]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reads exact provider tags from the supported endpoints response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      endpoints: [
        { tag: "openai", throughput_last_30m: { p50: 40 }, latency_last_30m: { p50: 4437 } },
        { tag: "openai/fast", throughput_last_30m: { p50: 57 }, latency_last_30m: { p50: 2949 } },
      ],
    },
  }));
  try {
    const result = await fetchModelSpeed("openai/gpt-6-sol", [
      { label: "OpenAI", tag: "openai" },
      { label: "OpenAI Fast", tag: "openai/fast" },
    ], "p50");
    assert.deepEqual(result.providers.map((provider) => [provider.label, provider.throughput]), [
      ["OpenAI", 40],
      ["OpenAI Fast", 57],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adds only the active OpenRouter model to the configured models", () => {
  assert.deepEqual(modelIdsFromSession({ model: { providerID: "openrouter", modelID: "openai/gpt-6-sol" } }), ["openai/gpt-6-sol"]);
  assert.deepEqual(modelIdsFromSession({ model: { providerID: "openrouter", id: "openai/gpt-6-luna" } }), ["openai/gpt-6-luna"]);
  assert.deepEqual(modelIdsFromSession({ model: { providerID: "openai", modelID: "gpt-6-sol" } }), []);
  assert.deepEqual(modelIdsFromSession({ model: { providerID: "openrouter", modelID: "openai/gpt-5.6-terra" } }), []);
});
