# Designsicle

Screenshots carry no numbers. Hand one to a coding agent and it guesses at colors, padding, radii, and type — and gets them wrong.

Designsicle is a Figma plugin plus a local MCP server that gives any MCP-capable coding agent the *real* values from your current Figma selection, as a flat text spec:

```
CONTAINER: Column, bg #FAFAF5, radius 24, border 2px solid #E6E6E6
  IMAGE: 395×296 px
  TEXT: "Heirloom tomato", Inter, 20px, weight 600, #000000, line-height 130%, at 24, gap 24
  TEXT: "$5.99 / lb", Inter, 20px, weight 600, #426B1F, line-height 130%, at 24, gap 4
  TEXT: "Grown in San Juan Capistrano, CA", Inter, 16px, weight 400, #6D6D6D, line-height 150%, at 24, gap 16
```

One line per element, two-space indent for depth. Figma defaults are omitted — if a property isn't there, it doesn't change the generated code. Where a Figma **variable** is bound, the spec emits its name (`bg brand/primary`) instead of a raw hex, so output lands in your design system rather than as magic numbers.

## Setup

```bash
cd plugin  && npm install && npm run build
cd ../server && npm install
```

The build step is required — `code.js` is generated from `code.ts` and is not committed.

**Import the plugin:** Figma **desktop app** → open any file → main menu → Plugins → Development → Import plugin from manifest… → select `plugin/manifest.json`.

**Point your agent at the server.** Add this to the project you're coding in (for Claude Code, `.mcp.json` at the project root):

```json
{
  "mcpServers": {
    "designsicle": {
      "command": "node",
      "args": ["/absolute/path/to/designsicle/server/index.js"]
    }
  }
}
```

You never start the server yourself — your agent launches it. The plugin dials out to `ws://localhost:3055` and retries every 2 seconds, so it reconnects on its own if the server restarts.

## Daily use

1. Open the plugin in Figma and select a component. The panel shows a live render and spec.
2. Tell your agent what you want, e.g. *"implement my current Figma selection"* or *"restyle the cart button to match my Figma selection"*.

The agent decides the rest. It picks `mode` (`redesign` or `create`) from what you asked, and resolves `target_file` itself — the plugin deliberately cannot read your filesystem.

## Tools

| Tool | Purpose |
|---|---|
| `get_selection_spec` | The spec plus mode-specific instructions. Optional `mode` and `target_file`. |
| `get_component_image` | A JPEG render, for when layout is visually ambiguous. |
| `check_figma_connection` | Whether the plugin is connected, so failures are diagnosable. |

`get_selection_spec` returns instructions, not raw data. In redesign mode it tells the agent to preserve the file's existing public API; in create mode, to expose the design's data as constructor parameters. Both require that any placeholder it introduces be listed explicitly at the end of its response — structure and styling may be derived from the design, but **data and behaviour must be flagged as assumed**. A tool that silently fabricates is untrustworthy.

## Limits

Read these before trusting the output.

- **Figma desktop app is required.** The browser version cannot reach `localhost`.
- **Plugins need edit access.** On files shared with you as view-only, use Dev Mode — which needs a Dev seat on a paid plan. Designsicle declares both editor types.
- **Auto layout produces far better output than absolute positioning.** For absolutely-positioned frames, Designsicle infers `Column`/`Row` with per-child gaps where children queue along one axis, and derives padding from a symmetric inset. Anything else stays a `Stack` with raw coordinates — accurate, but the weakest output. It cannot recover intent auto layout would have stated outright, like "centered" versus "happens to sit at 32px".
- **Image and icon detection is heuristic**, based on layer names and size. Tune the constants at the top of `plugin/code.ts`.
- **Font metrics differ** between Figma and rendered UI, so line-height spacing will not be pixel-identical.
- **One plugin connection at a time**; the newest wins.
- **JPEG has no transparency** — components with transparent backgrounds render filled.
- **Structure and styling only.** Responsive behaviour, state, and data wiring remain your job.

## Layout

```
designsicle/
├── plugin/
│   ├── manifest.json
│   ├── code.ts        # sandbox: node tree, extraction, pruning, JPEG export
│   └── ui.html         # iframe: panel UI + WebSocket
└── server/
    └── index.js        # MCP server (stdio) + WebSocket server (:3055)
```

A Figma plugin cannot be connected to — it can only dial out. That's why the MCP server hosts the WebSocket. The sandbox has full node access but no sockets; the iframe has sockets but no node access; they talk over `postMessage`. The server knows nothing about designs and nothing about your code — it relays and assembles prompts.
