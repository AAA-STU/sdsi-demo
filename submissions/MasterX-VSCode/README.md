# MasterX

**Asymmetric Master-Worker orchestration for VS Code.** Two separate `claude` CLI instances with **different models**: a cheap Worker indexes and drafts, a deep-thinking Master plans and reviews. You spend high-tier tokens only on reasoning — never on raw source dumps.

## How it works

| Stage | Who | Model | What |
|-------|-----|-------|------|
| 1 · Indexing | **Worker** | lighter (e.g. `deepseek/deepseek-v4-flash`) | Scans the workspace, samples file contents, emits a dense architectural summary |
| 2 · Planning | **Master** | deep (e.g. `xiaomi/mimo-v2.6-pro`) | Reads **only the summary**, reasons deeply, emits a strict JSON plan of `create_file` / `edit_file` / `run_command` tasks |
| 3 · Execution | **Worker** | lighter | Drafts complete file contents and command lines to the Master's spec |
| 4 · Synthesis | **Master** | deep | Reviews execution logs and writes the final report |

Each step is its own `claude --print` invocation bound to its own `--model`. Every step streams to the sidebar console as it happens.

## Install

```bash
npm install
npm run compile
```

Then press **F5** (Run Extension) in VS Code.

**Requirement:** the Claude CLI must be installed and on `PATH` —
`npm install -g @anthropic-ai/claude-code`, or set `masterx.claudeCliPath`.

## Where to configure the models

MasterX never handles API keys. The `claude` CLI reads its own credentials from
`~/.claude/settings.json` / the environment / your login. MasterX only chooses
**which model each role runs**.

### 1. VS Code settings (most direct)

`Ctrl+,` → search **`@ext:masterx`** → open the **MasterX** section:

| Setting | Controls | Example |
|---------|----------|---------|
| `masterx.masterModel` | **Master** — planning + synthesis | `xiaomi/mimo-v2.6-pro`, `opus`, `sonnet` |
| `masterx.workerModel` | **Worker** — indexing + drafting | `deepseek/deepseek-v4-flash`, `haiku` |
| `masterx.claudeCliPath` | Absolute path to `claude` | `C:\Users\you\.local\bin\claude.exe` |
| `masterx.useClaudeCliConfig` | Read defaults from `~/.claude/settings.json` | `true` |

Or edit `.vscode/settings.json` in the workspace:

```json
{
  "masterx.masterModel": "xiaomi/mimo-v2.6-pro",
  "masterx.workerModel": "deepseek/deepseek-v4-flash"
}
```

### 2. `~/.claude/settings.json` (what you already have)

When the VS Code settings are empty, MasterX resolves defaults from the same
file the Claude CLI uses:

```json
{
  "model": "opus",                                         // → Master
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "xiaomi/mimo-v2.6-pro",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek/deepseek-v4-flash"   // → Worker
  }
}
```

| Role | Resolves from | Example |
|------|---------------|---------|
| **Master** | `model` (alias `opus` → `env.ANTHROPIC_DEFAULT_OPUS_MODEL`) | `xiaomi/mimo-v2.6-pro` |
| **Worker** | `env.CLAUDE_CODE_SUBAGENT_MODEL` | `deepseek/deepseek-v4-flash` |

The sidebar and **Show Resolved Configuration** both display the model *and*
the exact source it was read from, e.g.
`C:\Users\you\.claude\settings.json → env.CLAUDE_CODE_SUBAGENT_MODEL`.

### 3. Environment variables (lowest precedence)

`ANTHROPIC_MODEL` (Master), `ANTHROPIC_DEFAULT_HAIKU_MODEL` (Worker fallback),
`CLAUDE_CODE_SUBAGENT_MODEL` (Worker), `CLAUDE_CLI_PATH` (binary).

### Resolution order

```
masterx.masterModel  →  ~/.claude/settings.json `model`  →  ANTHROPIC_MODEL  →  claude-opus-5-5
masterx.workerModel  →  CLAUDE_CODE_SUBAGENT_MODEL  →  ANTHROPIC_DEFAULT_HAIKU_MODEL  →  claude-haiku-5-5
```

Aliases (`opus`, `sonnet`, `haiku`, `fable`) expand exactly the way the Claude
CLI does, via `ANTHROPIC_DEFAULT_<ALIAS>_MODEL`, so the sidebar shows a real
model id.

**Verify what got picked up:** `Ctrl+Shift+P` → **`MasterX: Show Resolved
Configuration`**.

## Use

1. Open a workspace folder.
2. Click the **MasterX** icon in the Activity Bar.
3. Type a goal (e.g. *“Add a REST endpoint that lists all TODO items”*).
4. Press **Execute** (or `Ctrl+Enter`).

Watch the 4-stage tracker and console. The sidebar shows which model each side is running.

### Commands

| Command | What it does |
|---------|--------------|
| `MasterX: Execute Goal` | Focus the panel and start a run |
| `MasterX: Focus Panel` | Reveal the sidebar |
| `MasterX: Reset Panel` | Clear the tracker and console |
| `MasterX: Show Resolved Configuration` | Inspect which CLI/models were resolved |

## Design notes

- **The Worker is tool-light.** Indexing gets `Read`/`Glob`/`Grep` only; drafting
  gets **no tools** — it returns text that the extension writes itself. The
  Master gets no tools at all; it only reasons. This keeps both cheap and keeps
  the worker from driving your shell.
- **The Master's plan is structurally validated.** It is sent with
  `--json-schema`, and the extension re-checks every task
  (`action` / `targetPath` / `instructions`) before executing.
- **Commands run in `cmd.exe`** (on Windows), in a visible VS Code terminal, with
  output streamed live into the MasterX console and the real exit code captured.
- **File writes stay inside the workspace.** Any task path that resolves outside
  the root is refused.
- **No credentials in extension code.** The CLI owns authentication.

## Architecture

```
src/
  types.ts           Shared contracts (SubTask, MasterPlan, TaskResult, messages)
  configLoader.ts    Resolves the two model ids + the claude CLI path
  claudeCli.ts       Spawns `claude -p`, parses the result envelope
  master.ts          Master role: plan (JSON schema) + synthesize
  worker.ts          Worker role: index + draft files/commands
  orchestrator.ts    4-stage lifecycle with streaming hooks
  chatViewProvider.ts  Vanilla HTML/CSS/JS webview (no bundler, no framework)
  extension.ts       Activation + command registration
```

## Requirements

- VS Code `^1.85.0`
- Node `>= 18`
- Claude CLI 2.x installed and authenticated
- Two different model ids — that asymmetry is the whole point
