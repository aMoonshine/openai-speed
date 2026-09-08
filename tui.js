import { createSignal } from "solid-js";
import { collectSpeed, formatThroughput, loadSpeedConfig, modelIdsFromSession } from "./speed.js";

const appendUnique = (values) => [...new Set(values)];
const shortModelName = (modelId) => modelId.replace(/^openai\/gpt-/, "");
const providerDisplayName = (label) => label === "OpenAI Fast" ? "Fast" : label;
const isProModel = (modelId) => /-pro$/i.test(modelId);
const MODEL_COLUMN_WIDTH = 14;
const PROVIDER_COLUMN_WIDTH = 7;
const PROVIDER_COLORS = ["#73aaa7", "#6f9878"];
const PRO_MODEL_COLOR = "#e2a34e";
const PRO_VALUE_COLORS = ["#8bcac2", "#91bd91"];
const TITLE_COLOR = "#b06f83";
const UPDATE_COLOR = "#a99bc4";

const formatUpdatedTime = (timestamp) => {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
};

const providerHeader = (config) => {
  const labels = config.providers.map((provider) => providerDisplayName(provider.label).padEnd(PROVIDER_COLUMN_WIDTH));
  return `${" ".repeat(MODEL_COLUMN_WIDTH)}${labels.join("")}`.trimEnd();
};

const modelRowText = (result, config) => {
  const modelName = shortModelName(result.modelId);
  if (result.error) return `${modelName}: error: ${result.error}`;
  const values = config.providers.map((_, index) => {
    const value = formatThroughput(result.providers[index]?.throughput);
    return value.padEnd(PROVIDER_COLUMN_WIDTH);
  });
  return `${modelName.padEnd(MODEL_COLUMN_WIDTH)}${values.join("")}`.trimEnd();
};

export const renderSnapshot = (snapshot, config) => {
  const body = snapshot.loading || snapshot.results.length === 0
    ? snapshot.loading ? "loading…" : "no models configured"
    : [`upd ${formatUpdatedTime(snapshot.updatedAt)}`, ...snapshot.results.map((result) => modelRowText(result, config))].join("\n");
  return [
    "OpenRouter speed",
    providerHeader(config),
    body,
  ].join("\n");
};

const textNode = (solid, value, color) => {
  const node = solid.createElement("text");
  solid.setProp(node, "fg", color);
  solid.insert(node, value);
  return node;
};

const renderRows = (solid, snapshot, config) => {
  if (snapshot.loading) return [textNode(solid, "loading…", "white")];
  if (snapshot.results.length === 0) return [textNode(solid, "no models configured", "white")];

  const rows = snapshot.results.map((result) => {
    if (result.error) return textNode(solid, `${shortModelName(result.modelId)}: error: ${result.error}`, "white");
    const row = solid.createElement("box");
    solid.setProp(row, "flexDirection", "row");
    const pro = isProModel(result.modelId);
    solid.insert(row, textNode(solid, shortModelName(result.modelId).padEnd(MODEL_COLUMN_WIDTH), pro ? PRO_MODEL_COLOR : "white"));
    config.providers.forEach((_, index) => {
      const value = formatThroughput(result.providers[index]?.throughput).padEnd(PROVIDER_COLUMN_WIDTH);
      const color = pro ? PRO_VALUE_COLORS[index] ?? "white" : PROVIDER_COLORS[index] ?? "white";
      solid.insert(row, textNode(solid, value, color));
    });
    return row;
  });
  rows.unshift(textNode(solid, `upd ${formatUpdatedTime(snapshot.updatedAt)}`, UPDATE_COLOR));
  return rows;
};

const speedComponent = (solid, view, config) => {
  return () => {
    const box = solid.createElement("box");
    solid.setProp(box, "flexDirection", "column");
    solid.setProp(box, "paddingLeft", 1);
    solid.setProp(box, "paddingRight", 1);
    const title = solid.createElement("text");
    solid.setProp(title, "fg", TITLE_COLOR);
    solid.insert(title, "OpenRouter speed");
    solid.insert(box, title);

    const providers = solid.createElement("box");
    solid.setProp(providers, "flexDirection", "row");
    solid.insert(providers, textNode(solid, " ".repeat(MODEL_COLUMN_WIDTH), "white"));
    for (const [index, provider] of config.providers.entries()) {
      solid.insert(providers, textNode(solid, providerDisplayName(provider.label).padEnd(PROVIDER_COLUMN_WIDTH), PROVIDER_COLORS[index] ?? "white"));
    }
    solid.insert(box, providers);

    const body = solid.createElement("box");
    solid.setProp(body, "flexDirection", "column");
    solid.insert(body, () => renderRows(solid, view(), config));
    solid.insert(box, body);
    return box;
  };
};

export const OpenRouterSpeedTuiPlugin = async (api) => {
  const config = await loadSpeedConfig();
  const [view, setView] = createSignal({ loading: true, results: [], updatedAt: 0 });
  let running = false;
  let pollTimer;
  let pendingSessionId;
  const disposers = [];

  const currentModelIds = (sessionId) => {
    const session = api.state?.session?.get(sessionId);
    return appendUnique([...config.models, ...modelIdsFromSession(session)]);
  };

  const refresh = async (sessionId) => {
    if (running) {
      pendingSessionId = sessionId;
      return;
    }
    running = true;
    try {
      const modelIds = currentModelIds(sessionId);
      setView({ loading: false, results: (await collectSpeed(modelIds, config.providers, config.percentile)).results, updatedAt: Date.now() });
      api.renderer?.requestRender();
    } finally {
      running = false;
      const nextSessionId = pendingSessionId;
      pendingSessionId = undefined;
      if (nextSessionId && nextSessionId !== sessionId) void refresh(nextSessionId);
    }
  };

  let activeSessionId;
  const solid = await import("@opentui/solid");
  api.slots?.register({
    order: 100,
    slots: {
      sidebar_content: (_context, props) => {
        if (activeSessionId !== props.session_id) {
          activeSessionId = props.session_id;
          void refresh(activeSessionId);
        }
        const Component = speedComponent(solid, view, config);
        return solid.createComponent(Component, {});
      },
    },
  });
  api.renderer?.requestRender();

  pollTimer = setInterval(() => {
    if (activeSessionId) void refresh(activeSessionId);
  }, config.pollMs);
  if (api.event) {
    for (const eventType of ["message.updated", "message.part.updated", "session.updated"]) {
      disposers.push(api.event.on(eventType, () => {
        if (activeSessionId) void refresh(activeSessionId);
      }));
    }
  }

  const disposeCommand = api.keymap?.registerLayer({
    commands: [{
      name: "openai-speed.refresh",
      title: "OpenAI Speed",
      description: "Refresh OpenRouter throughput",
      category: "OpenRouter",
      namespace: "palette",
      slashName: "openai-speed",
      run: () => {
        if (activeSessionId) void refresh(activeSessionId);
        api.ui?.toast({ title: "OpenAI Speed", message: "Throughput refresh requested", variant: "info" });
      },
    }],
  });

  api.lifecycle?.onDispose(() => {
    if (pollTimer) clearInterval(pollTimer);
    for (const dispose of disposers) dispose();
    if (typeof disposeCommand === "function") disposeCommand();
  });
};

export default { id: "openai-speed", tui: OpenRouterSpeedTuiPlugin };
