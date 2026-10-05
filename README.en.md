# ensoul

> [简体中文](README.zh-CN.md) | **English**

**Open a panel on a whim, embed tools into conversations, and let panels collaborate.**

![ensoul: a conversation with an embedded widget](docs/assets/showcase/cover.png)

[Core Experience](#experience-how-panels-work-together) · [Quick Start](#quick-start) · [Development & Extension](#development--extension) · [License](#license)

## Experience how panels work together

When a new thought strikes, click `+` to open a panel. Embed handy widgets directly inside conversation tabs, or drag sticky-note tasks over to an AI agent. The task enters their workflow, the result is delivered back, and the original sticky note gets stamped upon completion.

![Core experience demo: quick new panel, embedded todo widget, sticky-note delegation and completion stamp](docs/assets/showcase/demo.gif)

*Real UI, mock data, and scripted playback. Window creation, docking guides, and sticky delivery leverage real frontend interactions. Drag trails are synthesized animations. Does not invoke live APIs; animation duration does not reflect real-time inference latency.* [Watch smooth 30fps MP4](docs/assets/showcase/demo.mp4)

## Open a panel on a whim — no need to define it beforehand

A panel is an evolving canvas: each with its own conversation thread, model, and context window. Open one for an impromptu question, split-screen when multitasking, stack into tabs, or undock into standalone floating windows.

You can also prompt it directly: *"Turn this panel into a Pomodoro timer."* Start with templates or plugins, then tune specifications or modify code on the fly. Layouts, features, and sessions persist together — no rebuilding your workspace every morning.

## Panels can nest inside panels

Writing an article? Drag a todo panel right into the conversation viewport and drop it. Panels can strip their frames away to leave only minimal controls; chat goes on while tasks stay at your fingertips.

![A borderless todo panel embedded inside a writing conversation](docs/assets/showcase/embed.png)

These embedded widgets remain fully standalone panels with independent sessions and capabilities. They anchor to their parent tab group and reposition dynamically with window layouts. Frequently used panels can be tucked into the top component deck, or exported and shared via component packs.

## Seamless inter-panel delegation

A sticky note can become an entry point for a task, an AI agent's panel receives it, and the deliverables report back to the original card. Tools and plugins turn them into a cohesive workflow.

**Write sticky note → Drag to agent on left → Agent receives task context → Stamp original card when resolved.** The card retains the assignee and history; double-clicking a resolved card jumps straight into the task log.

![Task enters agent chat, original sticky note displays assignee and completion seal](docs/assets/showcase/collaborate.png)

Inter-panel communication yields tangible results: wherever you jot down a task is where you watch it finish.

| Experience | Capability |
| --- | --- |
| Spawn instantly | Independent threads & context; customizable models & reasoning depth |
| Keep tools inside chat | Embedded widgets anchored to conversation views |
| Delegate across panels | Sticky-note dispatch, agent conversations, task lifecycle & receipts |
| Reshape workspace at will | Splits, tab groups, floating windows, component docking & packs |
| Expand on demand | Plugin-powered tools & panels, dynamic skills loaded just-in-time |

Themes, accents, typography, and interface zoom levels can all be customized in Settings.

## Built on plugins, configured by you

The repository includes out-of-the-box plugins for Pomodoro timers, task boards, sticky notes, token/cost counters, web browsers, and task dispatching. Plugins provide tools, states, settings, and full custom UI panels, while skills arm the models with runtime capabilities.

Architectural philosophy: **Start with plugins, reuse panel layouts, and extend common runtime capabilities when needed.** Never reinvent window management for a single tool.

ensoul is built on **Electron + React + TypeScript + Node.js**. Panels can point to different model providers; a headless [RPC / daemon entrypoint](docs/rpc.md) is also available.

Currently in **0.1.x active development**, run directly from source.

## Quick Start

Run the automated installer on first launch to bootstrap the environment and start the application:

- **Windows**: Double-click `安装.cmd` in the root directory.
- **macOS**: Double-click `安装.command` in the root directory (run `chmod +x *.command` first if downloaded from ZIP without execute permissions).

The installer reuses local Node.js 22+ if present; otherwise, it downloads a portable Node.js runtime into `.runtime/` without requiring administrator privileges or global installations. It then configures npm dependencies, downloads Electron, compiles code, and launches. Network access is required on first run (supports `HTTPS_PROXY` and tries `127.0.0.1:7897` automatically).

Subsequently, use `启动.cmd` / `启动.command` for daily instant launch without reinstalling dependencies.

If you already have **Node.js 22+** and **npm** installed, launch via CLI:

```bash
git clone https://github.com/kafnosake/Ensoul.git
cd Ensoul
npm run setup
npm run app
```

`npm run setup` installs dependencies, verifies Electron, and builds packages; `npm run app` launches existing builds.

On your first launch:
1. Select a workspace folder in the top-left corner.
2. Go to **Settings → Models** to configure your model providers, API endpoints, and keys.
3. Open a new chat panel and select a model.
4. Try saying: *"Help me organize today's tasks."* You can also add a Pomodoro timer or Todo list from the menu and refine it via conversation.

## Development & Extension

| Resource | Scope |
| --- | --- |
| [Development Guide](docs/development.md) | Entrypoints, code boundaries, scoped updates |
| [Plugin Specification](docs/plugin-spec.md) | Tools, states, settings & panel integration |
| [File Safety & Leases](docs/file-write-safety.md) | Concurrency leases and conflict prevention |
| [Reliable Tasks](docs/reliable-tasks.md) | Request IDs, async dispatch, cancellations & recovery |
| [Runtime Hardening](docs/runtime-hardening.md) | Implemented safeguards & current limitations |
| [Agent Scheduling](docs/agent-scheduling.md) / [Architecture Review](docs/architecture-review.md) | Future roadmap & technical debt review |
| [Showcase Assets](docs/showcase.md) | Cover, video specs, and reproduction steps |

```bash
npm run dev              # Renderer dev server
npm run build:main       # Build main process & preload
npm run build:renderer   # Build renderer bundle
npm run test:runtime     # Runtime regression test
```

Plugin backends live in `plugins/<name>/index.js`, frontends in `plugins/<name>/panel.tsx` / `panel.css`, and state files write to `.ensoul/state/`.

## License

[MIT](LICENSE)

---

*介绍页由chatgpt6.1sol生成。*
