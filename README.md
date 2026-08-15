# dsh-web-enhance

[English](README.md) | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@yangzhe1991/dsh-web-enhance)](https://www.npmjs.com/package/@yangzhe1991/dsh-web-enhance)
[![npm downloads](https://img.shields.io/npm/dm/@yangzhe1991/dsh-web-enhance)](https://www.npmjs.com/package/@yangzhe1991/dsh-web-enhance)
[![license](https://img.shields.io/github/license/yangzhe1991/dsh-web-enhance)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-1e90ff)](https://github.com/topics/dsh-plugin)

**dsh-web-enhance** is a browser plugin for the [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) web UI that adds small quality-of-life features. It currently ships:

- **Turn-by-turn conversation navigation** — a floating button pair in the bottom-right corner of the conversation that jumps to the start of the turn you are reading (or the previous turn's start) and to the end of the current turn (or the next turn's end) — always landing on the actual reply text, with reasoning, tool calls, and transition sentences skipped.
- **Thinking chain default-expand** — a toggle (the lightbulb button, on by default) that automatically expands every "Think" reasoning disclosure in the conversation, so the full thinking chain is visible while streaming instead of a one-line summary.

## Features

- 💡 **Thinking chain default-expand** — the third floating button (lightbulb icon) in the bottom-right corner, below the navigation pair:

  ```
      ⬆   ← back to the start of the current turn
      ⬇   ← to the end of the current turn
      💡  ← thinking chain default-expand toggle (highlighted when on)
  ```

  - When **on** (default), every "Think" reasoning row is expanded automatically — including rows that mount while the agent is still streaming — so you read the full reasoning text without clicking each one.
  - Toggle it off to restore the built-in collapsed one-line summaries.
  - The preference persists across reloads (localStorage). Manually collapsing an individual row is respected and will not be force-expanded.

- ⬆️⬇️ **Turn-by-turn navigation** — a floating button pair in the bottom-right corner of the conversation, right above the built-in "scroll to bottom" button:

  ```
      ⬆   ← back to the start of the current turn
      ⬇   ← to the end of the current turn
  ```

  - **Up arrow** — back to the start of the turn you are currently reading: the first sentence of that turn's **final result** (all reasoning, tool calls, and transition sentences skipped). Once your viewport is already pinned to the turn start, it jumps to the start of the **previous** turn.
  - **Down arrow** — to the **end** of the current turn (the bottom of its last rendered row). Once your viewport is already pinned to the turn end, it jumps to the end of the **next** turn.
  - The buttons only appear once the session has at least one turn with actual text.

## Install (30 seconds)

```sh
dsh plugin --profile web add @yangzhe1991/dsh-web-enhance
```

Restart the Web GUI (`Ctrl+C` the `dsh web` process and run it again) and refresh the browser tab. (`dsh plugin` runs `pnpm add` and auto-appends the bundle to `dsh.profile.bundles`.)

For local development, install from a path instead — the `link:` spec keeps a live symlink so edits take effect after a rebuild + restart:

```sh
dsh plugin --profile web add link:/path/to/@yangzhe1991/dsh-web-enhance
```

## How it works

The plugin subscribes to the conversation snapshot through the standard `useSession` hook and reads the turn model (`chat.timeline.turnOrder` + `chat.locations.getTurn(turn)` from `dsh-client-runtime`). A turn's "final result" is its last node that contains non-empty text and whose blocks end with a text block (transition sentences look like `[reasoning, text, tool…]` — the agent is still working — while a final result looks like `[reasoning, text]` or `[text]`); turns without a closing summary fall back to their last text-bearing node.

Scrolling reuses the same DOM primitives as the built-in UI: rows are located via the official `data-chat-anchor-key` marker inside the `[data-chat-flow]` list, the scrollport is `[data-conversation-scroll]`, and the start anchor skips the leading thinking block (`DisclosureRow`, carrying `aria-expanded`) so the viewport lands exactly on the reply text. "Already pinned to the turn start/end" is decided by scroll distance (< 60px) to the anchor, not by which row happens to be at the viewport edge.

The thinking-chain default-expand works on the official reasoning rows (`[data-variant="think"]` with a `[data-disclosure-row][aria-expanded="false"]` row inside). Because the full reasoning text is only mounted when a row is open, the plugin clicks each collapsed row to flip the built-in component's own React state. A `MutationObserver` on `document.body` watches for newly mounted rows (streaming output, new turns) and expands them as they appear; a one-time sweep covers rows that are already rendered. Only *added* subtrees are scanned, so a row you collapse by hand is left alone.

## Development

```sh
npm install
npm run build        # lib/index.js (node half) + lib/client.js (browser half)
npx tsc --noEmit     # type-check
```

## Uninstall

```sh
dsh plugin --profile web remove @yangzhe1991/dsh-web-enhance
```

## License

MIT
