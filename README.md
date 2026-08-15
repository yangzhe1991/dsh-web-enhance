# dsh-web-enhance

[English](README.md) | [中文](README.zh.md)

**dsh-web-enhance** is a browser plugin for the [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) web UI that adds small quality-of-life features. It currently ships **turn-by-turn conversation navigation**: a floating button pair in the bottom-right corner of the conversation that jumps to the start of the turn you are reading (or the previous turn's start) and to the end of the current turn (or the next turn's end) — always landing on the actual reply text, with reasoning, tool calls, and transition sentences skipped.

## Features

- ⬆️⬇️ **Turn-by-turn navigation** — a floating button pair in the bottom-right corner of the conversation, right above the built-in "scroll to bottom" button:
  - **Up arrow** — back to the start of the turn you are currently reading: the first sentence of that turn's **final result** (all reasoning, tool calls, and transition sentences skipped). Once your viewport is already pinned to the turn start, it jumps to the start of the **previous** turn.
  - **Down arrow** — to the **end** of the current turn (the bottom of its last rendered row). Once your viewport is already pinned to the turn end, it jumps to the end of the **next** turn.
  - The buttons only appear once the session has at least one turn with actual text.

## Install (30 seconds)

```sh
dsh plugin --profile web add link:/path/to/dsh-web-enhance
```

Restart the Web GUI (`Ctrl+C` the `dsh web` process and run it again) and refresh the browser tab. (`dsh plugin` runs `pnpm add` and auto-appends the bundle to `dsh.profile.bundles`; the `link:` spec keeps a live symlink so edits take effect after a rebuild + restart.)

## How it works

The plugin subscribes to the conversation snapshot through the standard `useSession` hook and reads the turn model (`chat.timeline.turnOrder` + `chat.locations.getTurn(turn)` from `dsh-client-runtime`). A turn's "final result" is its last node that contains non-empty text and whose blocks end with a text block (transition sentences look like `[reasoning, text, tool…]` — the agent is still working — while a final result looks like `[reasoning, text]` or `[text]`); turns without a closing summary fall back to their last text-bearing node.

Scrolling reuses the same DOM primitives as the built-in UI: rows are located via the official `data-chat-anchor-key` marker inside the `[data-chat-flow]` list, the scrollport is `[data-conversation-scroll]`, and the start anchor skips the leading thinking block (`DisclosureRow`, carrying `aria-expanded`) so the viewport lands exactly on the reply text. "Already pinned to the turn start/end" is decided by scroll distance (< 60px) to the anchor, not by which row happens to be at the viewport edge.

## Development

```sh
npm install
npm run build        # lib/index.js (node half) + lib/client.js (browser half)
npx tsc --noEmit     # type-check
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-web-enhance
```

## License

MIT
