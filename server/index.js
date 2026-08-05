#!/usr/bin/env node
// Designsicle — MCP server + WebSocket relay.
//
// Two servers in one process:
//   - a WebSocketServer on 3055 that the Figma plugin dials OUT to (a plugin
//     cannot be connected to, so the server must be the one listening);
//   - an McpServer over stdio that the coding agent drives.
//
// This process knows nothing about designs and nothing about code. It relays,
// and it assembles prompts. That line is deliberate.

import { WebSocketServer } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// 3055 is the port the plugin dials. Overridable only as an escape hatch for
// port conflicts and for testing against a live instance.
const PORT = Number(process.env.DESIGNSICLE_PORT) || 3055;
const REQUEST_TIMEOUT_MS = 10000;
const BIND_RETRY_MS = 2000;

// stdout carries the JSON-RPC framing for the stdio transport. Anything written
// there corrupts the stream and the agent sees an opaque parse failure, so all
// logging goes to stderr. Never console.log in this file.
function log(...args) {
  console.error("[designsicle]", ...args);
}

// WebSocket side — the plugin

/** @type {import("ws").WebSocket | null} */
let pluginSocket = null;

/** @type {Error | null} */
let listenError = null;

// Correlation by id. A naive socket.once("message") cross-wires the moment two
// tool calls overlap, so every request carries an id and replies are matched
// against this map — never against arrival order.
/** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout, socket: object}>} */
const pending = new Map();
let nextRequestId = 1;

function isPluginConnected() {
  return pluginSocket !== null && pluginSocket.readyState === pluginSocket.OPEN;
}

// Rejects only the requests that were sent on the given socket. Rejecting the
// whole map would kill requests belonging to a replacement connection.
function rejectPendingFor(socket, reason) {
  for (const [id, entry] of pending) {
    if (entry.socket !== socket) {
      continue;
    }
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new Error(reason));
  }
}

// Single source of truth for the disconnected diagnosis, so the two tools can
// never disagree about why. A port conflict and a closed plugin look identical
// from the agent's side but need opposite fixes.
function notConnectedMessage() {
  if (listenError !== null) {
    return (
      `Designsicle could not listen on port ${PORT}: ${listenError.message}. ` +
      "Another Designsicle server is already running and the plugin is connected to that one, " +
      "not this process. Ask the user to stop any manually-started Designsicle server — " +
      "reopening the plugin will NOT fix this."
    );
  }
  return (
    "The Designsicle plugin is not connected. Ask the user to open the Designsicle plugin in " +
    "the Figma desktop app (Plugins -> Development -> Designsicle). If it is already open, ask " +
    "them to close and re-run it, which reloads the plugin's UI. The plugin dials out to " +
    `ws://localhost:${PORT} and retries every 2 seconds. The browser version of Figma cannot ` +
    "reach localhost — the desktop app is required."
  );
}

// `kind` is "get_spec" or "get_image" — the correlation machinery is identical
// for both, so it lives in one place.
function requestFromPlugin(kind) {
  return new Promise((resolve, reject) => {
    if (!isPluginConnected()) {
      // Reject immediately with something the agent can act on. Never hang.
      reject(new Error(notConnectedMessage()));
      return;
    }

    const id = nextRequestId++;
    const socket = pluginSocket;

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `The Designsicle plugin did not respond within ${REQUEST_TIMEOUT_MS / 1000}s. ` +
            "It may have been closed mid-request. Ask the user to confirm the plugin is open " +
            "and showing 'connected'."
        )
      );
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer, socket });

    try {
      socket.send(JSON.stringify({ type: kind, id }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("Failed to reach the Designsicle plugin: " + error.message));
    }
  });
}

/** @type {import("ws").WebSocketServer | null} */
let wss = null;
let bindRetryTimer = null;

// A failed bind must not be permanent. The port is usually held by a previous
// Designsicle process that is about to exit, and requiring the user to restart
// their whole MCP client to recover from that is a terrible trade.
function startWebSocketServer() {
  const server = new WebSocketServer({ port: PORT });

  server.on("listening", () => {
    listenError = null;
    log(`websocket listening on ws://localhost:${PORT}`);
  });

  server.on("error", (error) => {
    listenError = error;
    if (error.code === "EADDRINUSE") {
      log(`port ${PORT} is in use by another Designsicle server; retrying every ${BIND_RETRY_MS / 1000}s`);
      scheduleBindRetry();
      return;
    }
    log("websocket server error:", error.message);
  });

  server.on("connection", handleConnection);
  wss = server;
}

function scheduleBindRetry() {
  if (bindRetryTimer !== null) {
    return;
  }
  bindRetryTimer = setTimeout(() => {
    bindRetryTimer = null;
    if (wss !== null) {
      try {
        wss.close();
      } catch (error) {
        log("error closing the failed listener:", error.message);
      }
    }
    startWebSocketServer();
  }, BIND_RETRY_MS);
  // Do not hold the process open purely to retry a bind.
  bindRetryTimer.unref();
}

function handleConnection(socket) {
  // One plugin connection at a time; last connection wins. A stale socket from
  // a closed plugin window would otherwise swallow requests forever.
  if (pluginSocket !== null && pluginSocket.readyState === pluginSocket.OPEN) {
    log("replacing an existing plugin connection");
    try {
      pluginSocket.close(4000, "Replaced by a newer plugin connection");
    } catch (error) {
      log("failed to close the previous socket:", error.message);
    }
  }

  pluginSocket = socket;
  log("plugin connected");

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      log("ignoring unparseable message from plugin:", error.message);
      return;
    }
    handlePluginMessage(message);
  });

  socket.on("close", () => {
    if (pluginSocket === socket) {
      pluginSocket = null;
    }
    rejectPendingFor(socket, "The Designsicle plugin disconnected before responding.");
    log("plugin disconnected");
  });

  socket.on("error", (error) => {
    log("plugin socket error:", error.message);
  });
}

function handlePluginMessage(message) {
  if (message === null || typeof message !== "object") {
    return;
  }
  if (message.type === "hello") {
    log("plugin handshake received");
    return;
  }

  if (message.type === "spec_result" || message.type === "image_result") {
    const entry = pending.get(message.id);
    if (entry === undefined) {
      // Timed out, or a reply from a socket we already gave up on.
      log(`dropping ${message.type} for unknown or expired id`, message.id);
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(message.id);
    entry.resolve(message);
    return;
  }

  log("unhandled message type from plugin:", message.type);
}

// Prompt assembly — the core of the product
//
// The server never returns the bare spec. It returns spec plus instructions,
// because the developer's stated intent is what turns data into behaviour.

function assembleRedesignPrompt(result, targetFile) {
  const target =
    typeof targetFile === "string" && targetFile.trim() !== ""
      ? targetFile.trim()
      : "not specified — ask the user which file to update before changing anything.";

  return `MODE: REDESIGN
TARGET FILE: ${target}
FIGMA COMPONENT: ${result.componentName}

UPDATED DESIGN SPEC:
${result.spec}

INSTRUCTIONS:
1. Read the target file first. Preserve its existing public API — constructor
   parameters, callbacks, state — unless the design clearly requires a change.
2. Update styling and layout to match the spec. Prefer existing theme constants
   and shared widgets in the codebase over hard-coded values.
3. If the design contains a section the current code has no data source for
   (e.g. a ratings row), BUILD IT with hard-coded placeholder values so it
   renders, then explicitly list every placeholder you introduced at the end of
   your response.
4. Derive structure and styling from the spec only. Do NOT invent behaviour,
   navigation, or data-fetching that is not already present in the file.`;
}

function assembleCreatePrompt(result) {
  return `MODE: CREATE NEW COMPONENT
FIGMA COMPONENT: ${result.componentName}

DESIGN SPEC:
${result.spec}

INSTRUCTIONS:
1. Create a new reusable component matching the spec.
2. Follow the conventions already present in this codebase — naming, file
   location, theme/token usage, and existing shared widgets.
3. Expose the data shown in the design as constructor parameters rather than
   hard-coding it.
4. If any part cannot be derived from the spec, use a placeholder and list every
   placeholder at the end of your response.`;
}

// MCP side — the agent

const server = new McpServer({ name: "designsicle", version: "0.1.0" });

server.registerTool(
  "check_figma_connection",
  {
    title: "Check Figma connection",
    description:
      "Reports whether the Designsicle Figma plugin is currently connected to this server. " +
      "Call this when a Figma-related request fails or before a first extraction, so you can " +
      "tell the user exactly what to fix instead of reporting an opaque error.",
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async () => {
    if (isPluginConnected()) {
      return {
        content: [
          {
            type: "text",
            text: "Designsicle plugin is connected. Selection specs can be fetched."
          }
        ]
      };
    }
    return { content: [{ type: "text", text: notConnectedMessage() }] };
  }
);

function selectionFailure(result) {
  return {
    content: [
      {
        type: "text",
        text:
          (result.error || "The Designsicle plugin could not read the selection.") +
          " Ask the user to select a component, frame, or text layer in Figma and try again."
      }
    ],
    isError: true
  };
}

server.registerTool(
  "get_selection_spec",
  {
    title: "Get Figma selection spec",
    description:
      "Fetches the design spec for the user's CURRENT Figma selection and returns ready-to-follow " +
      "implementation instructions. Call this whenever the user refers to their Figma selection, " +
      "their current design, 'this component', or asks you to implement, build, or redesign " +
      "something from Figma.\n\n" +
      "YOU choose the mode from what the user asked for. If they want an existing file restyled " +
      "to match the design, pass mode='redesign' and set target_file to the path you resolved — " +
      "the plugin cannot read the filesystem, so resolving it is your job. If they want something " +
      "new built, pass mode='create'. The returned instructions differ by mode; follow them as " +
      "written.\n\n" +
      "The spec is text and carries exact numbers. If the component's layout is visually complex " +
      "and you want to see it, call get_component_image.",
    inputSchema: {
      mode: z
        .enum(["redesign", "create"])
        .optional()
        .describe(
          "'redesign' to restyle an existing file, 'create' to build a new component. " +
            "Defaults to 'redesign'."
        ),
      target_file: z
        .string()
        .optional()
        .describe(
          "Redesign mode only: the repo-relative path of the file to update, e.g. " +
            "'lib/home/widgets/cart_button.dart'. Resolve this yourself from the user's request."
        )
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async (args) => {
    const mode = args && args.mode === "create" ? "create" : "redesign";

    let result;
    try {
      result = await requestFromPlugin("get_spec");
    } catch (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    if (result.ok !== true) {
      return selectionFailure(result);
    }

    const prompt =
      mode === "create"
        ? assembleCreatePrompt(result)
        : assembleRedesignPrompt(result, args && args.target_file);

    log(`returned ${mode} prompt for "${result.componentName}"`);
    return { content: [{ type: "text", text: prompt }] };
  }
);

server.registerTool(
  "get_component_image",
  {
    title: "Get Figma selection image",
    description:
      "Returns a JPEG render of the user's CURRENT Figma selection. Use it alongside " +
      "get_selection_spec when the component's structure is visually complex — overlapping " +
      "elements, absolute positioning, or anything where seeing the arrangement resolves " +
      "ambiguity the numbers alone leave open. The spec remains the source of truth for exact " +
      "values; the image is for understanding intent and layout.",
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async () => {
    let result;
    try {
      result = await requestFromPlugin("get_image");
    } catch (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    if (result.ok !== true || typeof result.image !== "string" || result.image === "") {
      return selectionFailure(result);
    }

    log(`returned image for "${result.componentName}"`);
    return {
      content: [
        {
          type: "text",
          text: `JPEG render of the Figma selection "${result.componentName}".`
        },
        {
          type: "image",
          data: result.image,
          mimeType: result.mimeType || "image/jpeg"
        }
      ]
    };
  }
);

// Lifecycle

function shutdown() {
  try {
    if (wss !== null) {
      wss.close();
    }
  } catch (error) {
    log("error closing websocket server:", error.message);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startWebSocketServer();

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server ready on stdio");
