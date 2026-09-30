import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "openrouter-speed.json");
const DEFAULT_MODELS = [
  "openai/gpt-6.1-sol-pro",
  "openai/gpt-6-astra-pro",
  "openai/gpt-6-sol-pro",
  "openai/gpt-6-luna-pro",
  "openai/gpt-6.1-sol",
  "openai/gpt-6-astra",
  "openai/gpt-6-sol",
  "openai/gpt-6-luna",
];
const DEFAULT_PROVIDERS = [
  { label: "OpenAI", tag: "openai" },
  { label: "Fast", tag: "openai/fast" },
  { label: "Flex", tag: "openai/flex" },
];
const PERCENTILES = ["p50", "p75", "p90", "p99"];
const DEFAULT_POLL_MS = 600000;
const DEFAULT_PAGE_DELAY_MS = 1000;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const uniqueStrings = (values) => [...new Set(values.map(nonEmptyString).filter(Boolean))];

const normalizeModelId = (value) => {
  const model = nonEmptyString(value);
  if (!model) return undefined;
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
};

const parseProviders = (value) => {
  if (!Array.isArray(value)) return DEFAULT_PROVIDERS;
  const providers = value
    .filter(isRecord)
    .map((provider) => ({
      label: nonEmptyString(provider.label),
      tag: nonEmptyString(provider.tag),
      row: nonEmptyString(provider.row),
    }))
    .filter((provider) => provider.label && provider.tag);
  return providers.length > 0 ? providers : DEFAULT_PROVIDERS;
};

const parseConfig = (value) => {
  if (!isRecord(value)) return { models: DEFAULT_MODELS, providers: DEFAULT_PROVIDERS, percentile: "p50", pollMs: DEFAULT_POLL_MS, pageDelayMs: DEFAULT_PAGE_DELAY_MS };
  const models = Array.isArray(value.models)
    ? uniqueStrings(value.models.map(normalizeModelId))
    : DEFAULT_MODELS;
  const percentile = PERCENTILES.includes(value.percentile) ? value.percentile : "p50";
  const pollMs =
    typeof value.pollMs === "number" && Number.isInteger(value.pollMs) && value.pollMs > 0
      ? value.pollMs
      : DEFAULT_POLL_MS;
  const pageDelayMs =
    typeof value.pageDelayMs === "number" && Number.isInteger(value.pageDelayMs) && value.pageDelayMs >= 0
      ? value.pageDelayMs
      : DEFAULT_PAGE_DELAY_MS;
  return {
    models: models.length > 0 ? models : DEFAULT_MODELS,
    providers: parseProviders(value.providers),
    percentile,
    pollMs,
    pageDelayMs,
  };
};

const configPath = () => process.env.OPENCODE_OPENROUTER_SPEED_CONFIG?.trim() || DEFAULT_CONFIG_PATH;

export const loadSpeedConfig = async () => {
  try {
    const raw = await readFile(configPath(), "utf8");
    return parseConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return parseConfig(undefined);
    }
    if (error instanceof Error && error.code === "ENOENT") {
      return parseConfig(undefined);
    }
    return parseConfig(undefined);
  }
};

const authPath = () => {
  if (process.env.OPENCODE_AUTH_PATH?.trim()) return process.env.OPENCODE_AUTH_PATH.trim();
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "opencode", "auth.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "opencode", "auth.json");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "auth.json");
};

const openRouterKey = async () => {
  const environmentKey = process.env.OPENROUTER_API_KEY?.trim();
  if (environmentKey) return environmentKey;
  try {
    const raw = JSON.parse(await readFile(authPath(), "utf8"));
    const key = isRecord(raw) && isRecord(raw.openrouter) ? raw.openrouter.key : undefined;
    return nonEmptyString(key);
  } catch {
    return undefined;
  }
};

const metric = (value, percentile) => {
  if (!isRecord(value)) return undefined;
  const candidate = value[percentile];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
};

const endpointMetrics = (endpoint, percentile) => {
  if (!isRecord(endpoint)) return undefined;
  const workload = isRecord(endpoint.perf_last_30m_by_workload)
    ? endpoint.perf_last_30m_by_workload.text_generation
    : undefined;
  const throughput = isRecord(workload) ? metric(workload.throughput, percentile) : undefined;
  return throughput ?? metric(endpoint.throughput_last_30m, percentile);
};

const pageStatsMetric = (stats, percentile) => {
  if (!isRecord(stats)) return undefined;
  const candidate = stats[`${percentile}_throughput`];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
};

const modelPath = (modelId) => {
  const slash = modelId.indexOf("/");
  if (slash < 1 || slash === modelId.length - 1) return undefined;
  const author = encodeURIComponent(modelId.slice(0, slash));
  const slug = encodeURIComponent(modelId.slice(slash + 1));
  return `https://openrouter.ai/api/v1/models/${author}/${slug}/endpoints`;
};

const modelPagePath = (modelId) => {
  const slash = modelId.indexOf("/");
  if (slash < 1 || slash === modelId.length - 1) return undefined;
  const author = encodeURIComponent(modelId.slice(0, slash));
  const slug = encodeURIComponent(modelId.slice(slash + 1));
  return `https://openrouter.ai/${author}/${slug}`;
};

const fetchJson = async (url, key) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = {
      "Cache-Control": "no-cache",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

const fetchText = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Cache-Control": "no-cache",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) OpenRouterSpeed/0.1",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter page HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
};

// The model page renders provider rows as "OpenAI", "OpenAI Fast", "OpenAI Flex",
// "Azure", with the Azure region only in the row's aria-label. Collapse to a bare
// key so "openai/fast" matches "OpenAI    Fast" and "azure/eu" matches the EU row.
const rowKey = (value) => (value ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();

const providerRowKey = (provider) => rowKey(provider.row ?? provider.tag);

const rowRegion = (row) => row.match(/aria-label="Region:\s*([A-Za-z]{2,3})\b[^"]*"/i)?.[1];

const rowMetricsFromPage = (html) => {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const metrics = new Map();
  for (const row of rows) {
    // OpenRouter uses the same aria-label for standard, Flex, and Fast rows, so the
    // heading is the only reliable source for the provider name.
    const heading = row.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i)?.[1];
    const name = heading ? heading.replace(/<[^>]*>/g, " ") : row.match(/aria-label="Open\s+([^"]+?)\s+details"/i)?.[1];
    const throughput = row.match(/>([0-9]+(?:\.[0-9]+)?)<span[^>]*>\s*tps<\/span>/i)?.[1];
    if (!name || throughput === undefined) continue;
    const key = rowKey(`${name} ${rowRegion(row) ?? ""}`);
    if (key && !metrics.has(key)) metrics.set(key, Number(throughput));
  }
  return metrics;
};

export const parsePageThroughput = (html, providers, percentile) => {
  const normalized = html.replaceAll('\\"', '"');
  const metrics = new Map();
  // An endpoint may have no stats. Never cross into the next provider's stats.
  const pattern = /"provider_slug"\s*:\s*"([^"]+)"(?:(?!"provider_slug"\s*:)[\s\S]){0,12000}?"stats"\s*:\s*\{([^}]*)\}/g;
  let match;
  while ((match = pattern.exec(normalized))) {
    const stats = Object.fromEntries(
      [...match[2].matchAll(/"(p(?:50|75|90|99)_throughput)"\s*:\s*(null|-?[0-9]+(?:\.[0-9]+)?)/g)].map((entry) => [
        entry[1],
        entry[2] === "null" ? null : Number(entry[2]),
      ]),
    );
    const throughput = pageStatsMetric(stats, percentile);
    if (throughput !== undefined && !metrics.has(match[1])) metrics.set(match[1], throughput);
  }
  const rowMetrics = rowMetricsFromPage(normalized);
  return providers.map((provider) => ({
    label: provider.label,
    tag: provider.tag,
    throughput: rowMetrics.get(providerRowKey(provider)) ?? metrics.get(provider.tag),
  }));
};

const fetchPageThroughput = async (modelId, providers, percentile) => {
  const url = modelPagePath(modelId);
  if (!url) return [];
  return parsePageThroughput(await fetchText(url + "?openrouter_speed=" + Date.now()), providers, percentile);
};

const providerView = (endpoint, provider, percentile) => {
  if (!isRecord(endpoint) || endpoint.tag !== provider.tag) return undefined;
  const throughput = endpointMetrics(endpoint, percentile);
  return {
    label: provider.label,
    tag: provider.tag,
    throughput,
  };
};

const hasThroughput = (provider) => typeof provider?.throughput === "number" && Number.isFinite(provider.throughput);

export const fetchModelSpeed = async (modelId, providers, percentile) => {
  const url = modelPath(modelId);
  if (!url) return { modelId, providers: [], error: "invalid model id" };

  let pageProviders;
  let pageError;
  try {
    pageProviders = await fetchPageThroughput(modelId, providers, percentile);
    if (pageProviders.every(hasThroughput)) {
      return { modelId, providers: pageProviders };
    }
  } catch (error) {
    pageError = error instanceof Error ? error.message : "page request failed";
  }

  let apiProviders;
  let apiError;
  try {
    const body = await fetchJson(url, await openRouterKey());
    const endpoints = isRecord(body) && isRecord(body.data) && Array.isArray(body.data.endpoints) ? body.data.endpoints : [];
    apiProviders = providers.map((provider) => endpoints.map((endpoint) => providerView(endpoint, provider, percentile)).find(Boolean) || {
      label: provider.label,
      tag: provider.tag,
      throughput: undefined,
    });
  } catch (error) {
    apiError = error instanceof Error ? error.message : "request failed";
  }

  const mergedProviders = providers.map((provider, index) => ({
    label: provider.label,
    tag: provider.tag,
    throughput: pageProviders?.[index]?.throughput ?? apiProviders?.[index]?.throughput,
  }));
  if (mergedProviders.some(hasThroughput)) {
    return { modelId, providers: mergedProviders };
  }

  if (apiProviders) return { modelId, providers: apiProviders };
  return { modelId, providers: [], error: apiError ?? pageError };
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const collectSpeed = async (modelIds, providers, percentile, pageDelayMs = DEFAULT_PAGE_DELAY_MS) => {
  const results = [];
  for (const [index, modelId] of modelIds.entries()) {
    if (index > 0 && pageDelayMs > 0) await wait(pageDelayMs);
    try {
      results.push(await fetchModelSpeed(modelId, providers, percentile));
    } catch (error) {
      results.push({
        modelId,
        providers: providers.map((provider) => ({ label: provider.label, tag: provider.tag, throughput: undefined })),
        error: error instanceof Error ? error.message : "request failed",
      });
    }
  }
  return { results, updatedAt: Date.now() };
};

export const formatThroughput = (value) => (typeof value === "number" ? value.toFixed(0) : "-");

export const modelIdsFromSession = (session) => {
  const model = isRecord(session) && isRecord(session.model) ? session.model : undefined;
  if (!model || model.providerID !== "openrouter") return [];
  const modelId = normalizeModelId(model.modelID ?? model.id);
  if (/^openai\/gpt-[\d.]+-terra(?:-pro)?$/i.test(modelId ?? "")) return [];
  return modelId ? [modelId] : [];
};
