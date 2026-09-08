import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "openrouter-speed.json");
const DEFAULT_MODELS = [
  "openai/gpt-6-astra-pro",
  "openai/gpt-5.6-sol-pro",
  "openai/gpt-5.6-terra-pro",
  "openai/gpt-5.6-luna-pro",
  "openai/gpt-6-astra",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
];
const DEFAULT_PROVIDERS = [
  { label: "OpenAI", tag: "openai" },
  { label: "OpenAI Fast", tag: "openai/fast" },
];
const PERCENTILES = ["p50", "p75", "p90", "p99"];

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
    }))
    .filter((provider) => provider.label && provider.tag);
  return providers.length > 0 ? providers : DEFAULT_PROVIDERS;
};

const parseConfig = (value) => {
  if (!isRecord(value)) return { models: DEFAULT_MODELS, providers: DEFAULT_PROVIDERS };
  const models = Array.isArray(value.models)
    ? uniqueStrings(value.models.map(normalizeModelId))
    : DEFAULT_MODELS;
  const percentile = PERCENTILES.includes(value.percentile) ? value.percentile : "p50";
  const pollMs =
    typeof value.pollMs === "number" && Number.isInteger(value.pollMs) && value.pollMs > 0
      ? value.pollMs
      : 600000;
  return {
    models: models.length > 0 ? models : DEFAULT_MODELS,
    providers: parseProviders(value.providers),
    percentile,
    pollMs,
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

const modelPath = (modelId) => {
  const slash = modelId.indexOf("/");
  if (slash < 1 || slash === modelId.length - 1) return undefined;
  const author = encodeURIComponent(modelId.slice(0, slash));
  const slug = encodeURIComponent(modelId.slice(slash + 1));
  return `https://openrouter.ai/api/v1/models/${author}/${slug}/endpoints`;
};

const fetchJson = async (url, key) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
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

export const fetchModelSpeed = async (modelId, providers, percentile) => {
  const url = modelPath(modelId);
  if (!url) return { modelId, providers: [], error: "invalid model id" };
  try {
    const body = await fetchJson(url, await openRouterKey());
    const endpoints = isRecord(body) && isRecord(body.data) && Array.isArray(body.data.endpoints) ? body.data.endpoints : [];
    return {
      modelId,
      providers: providers.map((provider) => endpoints.map((endpoint) => providerView(endpoint, provider, percentile)).find(Boolean) || {
        label: provider.label,
        tag: provider.tag,
        throughput: undefined,
      }),
    };
  } catch (error) {
    return { modelId, providers: [], error: error instanceof Error ? error.message : "request failed" };
  }
};

export const collectSpeed = async (modelIds, providers, percentile) => {
  const results = await Promise.all(modelIds.map((modelId) => fetchModelSpeed(modelId, providers, percentile)));
  return { results, updatedAt: Date.now() };
};

export const formatThroughput = (value) => (typeof value === "number" ? value.toFixed(0) : "-");

export const modelIdsFromSession = (session) => {
  const model = isRecord(session) && isRecord(session.model) ? session.model : undefined;
  if (!model || model.providerID !== "openrouter") return [];
  const modelId = normalizeModelId(model.modelID ?? model.id);
  return modelId ? [modelId] : [];
};
