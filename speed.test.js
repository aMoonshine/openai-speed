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
      modelId: "openai/gpt-5.6-terra",
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
  assert.match(output, /5\.6-terra\s+41\s+54/);
  assert.match(output, /upd/);
  assert.doesNotMatch(output, /gpt-5\.6-terra|tok\/s|\/|p50|rolling|TTFT|latency/i);
});

test("parses throughput from the OpenRouter model page when endpoint metrics are empty", () => {
  const html = String.raw`<script>\"provider_slug\":\"openai\",\"stats\":{\"p50_throughput\":41,\"p75_throughput\":65}}<script>\"provider_slug\":\"openai/fast\",\"stats\":{\"p50_throughput\":54}}</script>`;
  assert.deepEqual(parsePageThroughput(html, [
    { label: "OpenAI", tag: "openai" },
    { label: "Fast", tag: "openai/fast" },
  ], "p50").map((provider) => provider.throughput), [41, 54]);
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
    const result = await fetchModelSpeed("openai/gpt-5.6-luna-pro", [
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
    const result = await fetchModelSpeed("openai/gpt-5.6-terra", [
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
  assert.deepEqual(modelIdsFromSession({ model: { providerID: "openrouter", modelID: "openai/gpt-5.6-terra" } }), ["openai/gpt-5.6-terra"]);
  assert.deepEqual(modelIdsFromSession({ model: { providerID: "openrouter", id: "openai/gpt-5.6-luna" } }), ["openai/gpt-5.6-luna"]);
  assert.deepEqual(modelIdsFromSession({ model: { providerID: "openai", modelID: "gpt-5.6-terra" } }), []);
});
