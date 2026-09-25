# dsh-web-enhance

[English](README.md) | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@yangzhe1991/dsh-web-enhance)](https://www.npmjs.com/package/@yangzhe1991/dsh-web-enhance)
[![npm downloads](https://img.shields.io/npm/dm/@yangzhe1991/dsh-web-enhance)](https://www.npmjs.com/package/@yangzhe1991/dsh-web-enhance)
[![license](https://img.shields.io/github/license/yangzhe1991/dsh-web-enhance)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-1e90ff)](https://github.com/topics/dsh-plugin)

**dsh-web-enhance** is a browser plugin for the [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) web UI that adds small quality-of-life features. It currently ships:

- **Thinking chain default-expand** — a floating toggle (the lightbulb button at the bottom-right, on by default) that automatically expands every "Think" reasoning disclosure in the conversation, so the full thinking chain is visible while streaming instead of a one-line summary.
- **Session cost meter** — when a session runs on the official DeepSeek API, an estimated session cost (CNY) is shown at the far left of the same line as the built-in input/output token stats, priced per request at the real peak/off-peak hour using the official pricing page rates.
- **Open files in the system app** — clicking a file path in the conversation hands it to your desktop default application (VS Code, text editor, …) instead of popping the right sidebar. Can be turned off in Settings → General.
- **Completion alert** — a chime when a session *really* finishes its work (or the moment a dialog waits for your choice), plus a tab-title alert while you are on another tab. On by default; can be turned off in Settings → General. *(Merged in from the retired [dsh-task-notify](https://github.com/yangzhe1991/dsh-task-notify) plugin.)*

> **Migrating from dsh-task-notify?** That plugin is retired — its completion alert now lives here as a built-in feature (same decision rules, plus an on/off switch in Settings → General). Switch over with:
>
> ```sh
> dsh plugin --profile web remove @yangzhe1991/dsh-task-notify
> dsh plugin --profile web add @yangzhe1991/dsh-web-enhance
> ```
>
> then restart the Web GUI and refresh the tab. This plugin's other features come along for free.

## Compatibility

- **dsh ≥ 0.1.7-rc.2** — required since **0.2.0** (the release that merges in the completion alert). The watcher reads three current Client contracts: the session-list snapshot (`useSessions`: `ids` / `byId.origin`), the per-session UI status (`useSessionStatus`: agent `running` + `pendingInteraction`) and on-demand job rosters from the `jobs` client service (`watchRows` → `state.rows`). On **dsh ≤ 0.1.6** the completion alert simply stays off (the rest of the plugin is unaffected) — those versions carried job rosters inside the session-list snapshot and dialogs behind `useSessionPendingInteraction`, both removed in 0.1.7.
- **dsh ≥ 0.1.2-alpha.4** — supported since **0.1.5** for everything else. The restructured frontend provides the chat snapshot as the session-standard `useChat` hook and trajectory as `useTrajectory`; both are adapted, with the legacy paths retained for older dsh. Verified against **dsh 0.1.3-alpha.2** since **0.1.9**, against **dsh 0.1.5-rc.2** since **0.1.10** (the release that adds "Open files in the system app", verified end-to-end on a real desktop), and against **dsh 0.1.7-rc.2** since **0.1.11** — dsh 0.1.7 replaced the per-request `provenance` field with `requestConfig`/`providerMetadata` in the trajectory snapshot, which had silently hidden the cost meter; **0.1.11** reads all three shapes, so the meter keeps working from 0.1.2-alpha.4 onward. **0.2.0** (completion alert) is verified against **dsh 0.1.7-rc.2**.
  - Note for **0.2.0**: dsh 0.1.7 also renamed the icon exports of `dsh-client-ui-primitives` (`IconChevronUpOutline14` → `IconChevronUpOutlineMedium`). **0.2.0** uses the current names; older releases render an empty page on 0.1.7+.
- **dsh 0.1.0-rc.x** — still supported via the legacy snapshot paths.

## Features

- 💡 **Thinking chain default-expand** — the floating lightbulb button in the bottom-right corner (highlighted when on), sitting above the built-in "scroll to bottom" button:

  - When **on** (default), every "Think" reasoning row is expanded automatically — including rows that mount while the agent is still streaming — so you read the full reasoning text without clicking each one.
  - Toggle it off to restore the built-in collapsed one-line summaries.
  - The preference persists across reloads (localStorage). Manually collapsing an individual row is respected and will not be force-expanded.

- 💰 **Session cost meter** — on the **same line as the built-in stats line, at its far left**, e.g. `≈ ¥0.83 · 2 turns 12 steps | …`:

  - Only rendered while the session's requests go through the **official DeepSeek API** (provider route `deepseek-official`); it disappears once you switch to another API.
  - Cost = tokens × official unit prices (CNY; both models currently on sale are covered — `deepseek-flash` and `deepseek-v4-pro`; the retired names `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` are still callable and are billed at Flash rates, so they are priced the same), priced per request at its **actual time** with peak/off-peak rates (peak = Beijing time **Monday–Friday** 09:00–12:00 and 14:00–18:00, twice the off-peak price; weekends are off-peak all day), with cache-hit input at the discounted rate.
  - Models **missing from the price table** (just released upstream, or not yet synced here) are never dropped: they fall back to the **cheapest price among the known DeepSeek models**, and the hover detail says so ("not in the price table, estimated at the cheapest rate").
  - **Accumulate as it happens**: every observed request is priced at its real time and persisted immediately (localStorage, per session, last-wins so nothing double-counts) — history paging pushing old requests out of the browser window does not matter. A session that has used this plugin since its creation has an **exact total for its whole life**, regardless of how long it gets.
  - Only history that was **never loaded** (before the plugin was installed, or on another machine) has no per-request data: its remainder is estimated at the current model's off-peak rate (the cheapest-rate fallback applies here too when the model is unknown); together with any fallback-priced models this marks the total with a `≈` prefix (hover for details: model, tokens, peak/off-peak request counts, unknown models). Clicking "Load earlier" to page that history in turns the remainder exact.
  - The price table is updated in `src/client/cost.ts` whenever the official pricing page changes.

- 📂 **Open files in the system app** (on by default) — clicking a file no longer pops the right sidebar:

  - **Why**: since dsh 0.1.5, file paths in the transcript and in tool rows are hard-wired to the right sidebar's document-preview tab (literally `ctx.sidebarRight.openResource(...)` in the shipped source, with no setting to disable it), so glancing at a file means the sidebar pushes in and squeezes the conversation.
  - **What this plugin does**: it intercepts that open and hands the **absolute path** to the host's native `session.openWorkspacePath`, which opens the file in your **desktop default application** — the same thing as double-clicking it in Finder/Explorer. The conversation column stays put; the sidebar stays closed.
  - **Only file clicks are intercepted**: the sidebar's own navigation (the file tree, the guide page, tab menus) keeps working exactly as before, so you can still open a file into the official preview from the file tree; non-file resources such as image attachments are untouched.
  - **Falls back when it cannot open**: on a remote-only browser (no host desktop) or when the host refuses, the click falls back to the official sidebar preview — never a dead click.
  - **Toggle**: Settings → General → "Open files in the system app"; takes effect immediately and persists across reloads.

- 🔔 **Completion alert** (on by default) — a chime when the work is *really* over, and a tab-title alert while you are on another tab:

  - **What counts as "really over"**: a session is *busy* while its agent is running, **or** while any of its background jobs is `running`/`stopping`, **or** while a dialog is waiting for you. When it stops being busy and stays that way for ~2 seconds, the chime rings once — and only once.
    - The 2-second quiet window exists because a settling background job and the agent waking up for it are two separate streams on the client: without the window, the frame that reports the job first would look like "all done".
    - Job rosters are streamed per session and only while needed: the watcher subscribes for sessions whose agent is running **and keeps the subscription** for as long as the session still counts as busy — including the gap where the agent has already yielded and is waiting for its jobs.
    - An agent that ends its turn to wait for a background job, and a background job that finishes and wakes the agent to keep working, are both **not** the end of the work — neither rings. (That was the main source of premature alerts in the old plugin.)
  - **Dialogs ring immediately** — a tool approval, an `ask_user_question` prompt, or a plan review. Same chime as above; the tab title distinguishes the two.
  - **Tone**: ascending *do → mi* normally; descending *mi → do* when a background job settled `failed` or `killed` during that busy period.
  - **Tab-title alert**: while the page is not the active tab (`document.hidden`), the title becomes `🔔 N session(s) finished — <original title>`, or `🔔 waiting for your choice — <original title>` when a dialog is waiting. Switching back restores it.
  - **No false positives**: switching sessions, loading history, or refreshing the page never re-alerts for old turns or already-settled jobs. Background **subagent** child sessions are not announced on their own — their completion wakes the parent session, which is still the same piece of work.
  - **First-run note**: browsers block audio until you have interacted with the page. **Click or press a key anywhere once** and chimes are unlocked from then on (the tab-title alert is never affected).
  - **Toggle**: Settings → General → "Completion alert" — one switch for both the chime and the tab title; takes effect immediately and persists across reloads.

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

The thinking-chain default-expand works on the official reasoning rows (`[data-variant="think"]` with a `[data-disclosure-row][aria-expanded="false"]` row inside). Because the full reasoning text is only mounted when a row is open, the plugin clicks each collapsed row to flip the built-in component's own React state. A `MutationObserver` on `document.body` watches for newly mounted rows (streaming output, new turns) and expands them as they appear; a one-time sweep covers rows that are already rendered. Only *added* subtrees are scanned, so a row you collapse by hand is left alone.

The session cost meter registers into `conversation.composer.dock` (the same slot as the built-in stats line, sharing its row as the first element). It combines two data sources: the `trajectory` view (per-request provider/model/usage/timestamp/startSeq — the basis of the exact pricing) and the `tokenUsage` projection (whole-session token totals). The per-request provider/model has moved across dsh versions (`provenance` up to 0.1.5, `requestConfig`/`providerMetadata` from 0.1.7), so `requestRoute` in `cost.ts` reads all three shapes — a version that renames the field again shows up as an empty line, which is why the component also publishes its decision to `document.documentElement.dataset.dshWebeCost` (window request count, how many are `deepseek-official`, the latest route, the total, whether it rendered). Every request observed with usage is persisted into a per-session accumulator keyed by startSeq (localStorage, last-wins so retried usage replaces instead of double-counting); the projection's remainder beyond the accumulator (history that was never observed) is estimated at the off-peak rate and marked `≈`. The line hides whenever the most recent request is not `deepseek-official`.

The completion alert registers into `shell.overlay` (a root-scoped slot entry that renders `null`). Its decision logic is a pure state machine in `notify-monitor.ts` — no React, no DOM, injectable timers, so the timing rules can be replayed offline with a fake clock (`node probe/notify-probe.mjs` covers the interesting sequences: busy → idle, a job that keeps the session busy after the agent yields, a failure inside a busy period, a dialog appearing, and the on/off switch). React only projects the official snapshots into "per-session facts": `useSessions` (`ids` / `byId.origin`, skipping subagent children) and `useSessionStatus` (`running`, `pendingInteraction.key`), while the job rosters come from the `jobs` client service (`watchRows` per session, subscribed only while a session is running or still counted as busy). If that service is missing the alert stays off and everything else keeps working — the plugin deliberately does **not** declare `jobs` in its `inject` list, and publishes the assembly state to `document.documentElement.dataset.dshWebeNotify` (`tier`, `error`, `enabled`, session/job counts, per-session phases) so "it never rings" can be diagnosed with one line in the console instead of guesswork.

## Development

```sh
npm install
npm run build        # lib/index.js (node half) + lib/client.js (browser half)
npx tsc --noEmit     # type-check
node probe/notify-probe.mjs   # offline probe: alert state machine + bundle assembly (needs a build first)
```

Local-only notes for contributors:

- **Icon exports are version-sensitive.** dsh 0.1.7 renamed the `dsh-client-ui-primitives` icons from a size suffix (`IconChevronUpOutline14`) to a semantic one (`IconChevronUpOutlineMedium`). Importing a name the running host does not export yields `undefined`, and React turns that into `Element type is invalid` — a blank page that looks exactly like "the plugin failed to load". Check the served bundle when in doubt: the page's `assets/index-*.js` contains the module table, `grep -o 'IconChevron[A-Za-z]*'`.
- **The chat DOM is not a stable contract.** This project used to ship its own turn-navigation arrows; they were **removed in 0.2.0** because dsh 0.1.7 added an official turn rail (TurnNavigator) *and* changed the chat DOM in ways that silently break naive queries: `[data-chat-flow]` is no longer unique (every collapsed step-process group carries `data-step-process-content[data-chat-flow]` inside it), and collapsed rows are hidden via the `hidden` attribute with all-zero `getBoundingClientRect()`. If a future feature needs to walk the transcript, derive the column from a *visible* anchor row and use the official exclusion selector `:not([hidden]):not([hidden] *):not(:empty)` — and replay it offline before shipping (that is why `probe/` exists).

- **`tsconfig.json`'s `paths` must point at the same official packages the host loads** (the dsh CLI's `node_modules`), because the official packages rely on cross-package declaration merging: resolving one of them to a second copy silently drops augmentations (`GlobalStandardProps` would lose `useSessions`). The repo's own `node_modules` still carries older peer-dependency copies, so `paths` wins over them on purpose.

## Uninstall

```sh
dsh plugin --profile web remove @yangzhe1991/dsh-web-enhance
```

## License

MIT
