import * as path from 'path';
import * as vscode from 'vscode';
import { claudeSettingsPath, loadConfig, validateConfig } from './configLoader';
import { Orchestrator } from './orchestrator';
import { Master } from './master';
import { Worker } from './worker';
import {
  LogLevel,
  StageId,
  SubTask,
  TaskStatus,
  WebviewInboundMessage,
  WebviewOutboundMessage,
} from './types';

/**
 * The MasterX sidebar panel: a self-contained vanilla HTML/CSS/JS webview using
 * only VS Code theme variables. No bundler, no framework.
 *
 * Top:      status bar (Master model / Worker model)
 * Input:    goal textarea + Execute / Reset
 * Progress: 4-stage tracker + live task list
 * Console:  auto-scrolling log terminal
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'masterx.chatView';

  private view?: vscode.WebviewView;
  private running = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionVersion: string
  ) {}

  // ---------------------------------------------------------------- lifecycle

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (raw: WebviewInboundMessage) => {
        try {
          await this.handleMessage(raw);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.post({ type: 'log', message: `Internal error: ${message}`, level: 'error' });
          this.post({ type: 'busy', value: false });
          this.post({ type: 'stage', stage: 'error', detail: message });
        }
      },
      undefined
    );

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    // Push resolved configuration as soon as the webview is ready for it.
    this.postInit();
  }

  // ------------------------------------------------------------------- public

  /** Focus the sidebar panel and reveal this view. */
  focus(): void {
    void vscode.commands.executeCommand('masterx.chatView.focus');
    this.post({ type: 'focus-input' });
  }

  /** Clear the panel back to its idle state. */
  reset(): void {
    this.post({ type: 'reset' });
    this.postInit();
    this.log('Panel reset.', 'info');
  }

  /** Start a run from the command palette (picks up the current goal text). */
  async executeFromCommand(): Promise<void> {
    if (this.running) {
      this.log('A run is already in progress. Wait for it to finish or press Reset.', 'warn');
      return;
    }
    // The webview owns the goal text; ask it to kick off execution.
    this.post({ type: 'do-execute' });
  }

  /** Show the resolved configuration in a readable quick-pick. */
  async showConfig(): Promise<void> {
    const { config, warnings } = loadConfig();
    const problems = validateConfig(config);

    const lines: string[] = [
      'MasterX — Resolved Configuration',
      '',
      `Claude CLI:          ${config.claudeCliPath || '(not found)'}`,
      `CLI settings:        ${claudeSettingsPath()}`,
      '',
      `Master model:        ${config.master.model}`,
      `Master source:       ${config.master.modelSource}`,
      '',
      `Worker model:        ${config.worker.model}`,
      `Worker source:       ${config.worker.modelSource}`,
      '',
      `Workspace folder:    ${this.workspaceFolderLabel()}`,
      '',
    ];

    if (problems.length > 0) {
      lines.push('Configuration problems:');
      for (const problem of problems) {
        lines.push(`  • ${problem}`);
      }
    } else {
      lines.push('Configuration is complete — ready to run.');
    }
    if (warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      for (const warning of warnings) {
        lines.push(`  • ${warning}`);
      }
    }

    void vscode.window.showInformationMessage(lines.join('\n'), { modal: true, detail: lines.join('\n') });
    this.log('Displayed resolved configuration.', 'info');
  }

  // ---------------------------------------------------------------- messaging

  private async handleMessage(message: WebviewInboundMessage): Promise<void> {
    switch (message?.type) {
      case 'ready':
        this.postInit();
        return;

      case 'reset':
        this.post({ type: 'reset' });
        this.postInit();
        return;

      case 'execute': {
        const goal = (message.goal ?? '').trim();
        if (!goal) {
          this.log('Enter a goal before executing.', 'warn');
          return;
        }
        if (this.running) {
          this.log('A run is already in progress.', 'warn');
          return;
        }
        await this.runGoal(goal);
        return;
      }

      default:
        this.log(`Unknown message from panel: ${JSON.stringify(message).slice(0, 120)}`, 'warn');
    }
  }

  private post(message: WebviewOutboundMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private log(message: string, level: LogLevel = 'info'): void {
    this.post({ type: 'log', message, level });
  }

  /** Send resolved models + workspace so the status bar can render. */
  private postInit(): void {
    const { config, warnings } = loadConfig();
    const problems = validateConfig(config);

    this.post({
      type: 'init',
      masterModel: config.master.model,
      workerModel: config.worker.model,
      workspaceFolder: this.workspaceFolderLabel(),
    });

    for (const warning of warnings) {
      this.log(warning, 'warn');
    }
    for (const problem of problems) {
      this.log(problem, 'error');
    }
    if (problems.length === 0) {
      this.log(
        `Ready. Master ${config.master.model} · Worker ${config.worker.model}.`,
        'success'
      );
    }
  }

  private workspaceFolderLabel(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.basename(folder.uri.fsPath) : '(no folder open)';
  }

  private requireWorkspaceRootPath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open. Open a folder before running MasterX.');
    }
    return folder.uri.fsPath;
  }

  // ------------------------------------------------------------------- runner

  private async runGoal(goal: string): Promise<void> {
    this.running = true;
    this.post({ type: 'busy', value: true });
    this.post({ type: 'reset' });
    this.postInit();
    this.log(`Goal: ${goal}`, 'info');

    try {
      const { config, warnings } = loadConfig();
      for (const warning of warnings) {
        this.log(warning, 'warn');
      }

      const problems = validateConfig(config);
      if (problems.length > 0) {
        for (const problem of problems) {
          this.log(problem, 'error');
        }
        this.post({ type: 'stage', stage: 'error', detail: problems[0] });
        return;
      }

      const cwd = this.requireWorkspaceRootPath();

      // Two independent `claude` CLI instances with different models: a cheap
      // Worker that indexes and drafts, a deep-thinking Master that plans and
      // reviews. The CLI owns authentication via ~/.claude/settings.json.
      const worker = new Worker({
        cliPath: config.claudeCliPath,
        cwd,
        model: config.worker.model,
        log: (message, level) => this.log(message, level),
      });
      const master = new Master({
        cliPath: config.claudeCliPath,
        cwd,
        model: config.master.model,
        log: (message, level) => this.log(message, level),
      });

      const orchestrator = new Orchestrator(worker, master, {
        onLog: (message, level) => this.log(message, level),
        onStage: (stage: StageId, detail: string) =>
          this.post({ type: 'stage', stage, detail }),
        onSubtasks: (tasks: SubTask[]) =>
          this.post({
            type: 'subtasks',
            tasks: tasks.map((t) => ({ id: t.id, action: t.action, targetPath: t.targetPath })),
          }),
        onTask: (id: string, status: TaskStatus, detail: string) =>
          this.post({ type: 'task', id, status, detail }),
        onSummary: (text: string) => this.post({ type: 'summary', text }),
      });

      await orchestrator.run(goal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(message, 'error');
      this.post({ type: 'stage', stage: 'error', detail: message });
    } finally {
      this.running = false;
      this.post({ type: 'busy', value: false });
    }
  }

  // --------------------------------------------------------------------- html

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MasterX</title>
  <style>
    :root {
      --mx-gap: 8px;
      --mx-radius: 4px;
      --mx-font: var(--vscode-font-family);
      --mx-mono: var(--vscode-editor-font-family, monospace);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 10px;
      font-family: var(--mx-font);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: var(--mx-gap);
      height: 100vh;
      overflow: hidden;
    }

    /* ---------- status bar ---------- */
    .status {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: var(--mx-radius);
      background: var(--vscode-editor-background);
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      line-height: 1.4;
    }
    .status-label {
      color: var(--vscode-descriptionForeground);
      min-width: 52px;
    }
    .status-value {
      color: var(--vscode-foreground);
      font-family: var(--mx-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--vscode-charts-green);
    }
    .status-dot.warn { background: var(--vscode-charts-yellow); }
    .status-dot.error { background: var(--vscode-charts-red); }

    /* ---------- input area ---------- */
    .input-area {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    textarea#goal {
      width: 100%;
      min-height: 64px;
      resize: vertical;
      padding: 6px 8px;
      font-family: var(--mx-font);
      font-size: var(--vscode-font-size);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: var(--mx-radius);
      outline: none;
    }
    textarea#goal:focus {
      border-color: var(--vscode-focusBorder);
    }
    .button-row {
      display: flex;
      gap: 6px;
    }
    button {
      flex: 1;
      padding: 5px 10px;
      font-family: var(--mx-font);
      font-size: var(--vscode-font-size);
      border: none;
      border-radius: var(--mx-radius);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.primary:disabled {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: not-allowed;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    /* ---------- progress tracker ---------- */
    .tracker {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .stage {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 4px;
      font-size: 11px;
      border-radius: var(--mx-radius);
    }
    .stage .marker {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 1.5px solid var(--vscode-descriptionForeground);
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .stage.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .stage.active .marker {
      border-color: var(--vscode-progressBar-background);
      background: var(--vscode-progressBar-background);
    }
    .stage.done .marker {
      border-color: var(--vscode-charts-green);
      background: var(--vscode-charts-green);
    }
    .stage.error .marker {
      border-color: var(--vscode-charts-red);
      background: var(--vscode-charts-red);
    }
    .stage-title { font-weight: 600; }
    .stage-detail {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 55%;
    }

    /* ---------- task list ---------- */
    .task-list {
      margin: 4px 0 0 18px;
      padding: 0;
      list-style: none;
      display: none;
      flex-direction: column;
      gap: 2px;
    }
    .task-list.visible { display: flex; }
    .task-item {
      display: flex;
      align-items: baseline;
      gap: 5px;
      font-family: var(--mx-mono);
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .task-item .badge {
      font-family: var(--mx-font);
      padding: 0 4px;
      border-radius: 2px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      flex-shrink: 0;
    }
    .task-item.status-running { color: var(--vscode-foreground); }
    .task-item.status-done .badge {
      background: var(--vscode-charts-green);
      color: var(--vscode-editor-background);
    }
    .task-item.status-failed .badge {
      background: var(--vscode-charts-red);
      color: var(--vscode-editor-background);
    }
    .task-item .path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ---------- summary ---------- */
    .summary {
      display: none;
      white-space: pre-wrap;
      word-break: break-word;
      padding: 8px;
      border-radius: var(--mx-radius);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      background: var(--vscode-editor-background);
      max-height: 30vh;
      overflow-y: auto;
      font-size: 11px;
      line-height: 1.5;
    }
    .summary.visible { display: block; }

    /* ---------- console ---------- */
    .console-wrap {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
      min-height: 90px;
    }
    .console-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
    }
    .console {
      flex: 1;
      min-height: 90px;
      overflow-y: auto;
      padding: 6px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: var(--mx-radius);
      background: var(--vscode-editor-background);
      font-family: var(--mx-mono);
      font-size: 10px;
      line-height: 1.55;
    }
    .log-line { white-space: pre-wrap; word-break: break-word; }
    .log-line.info    { color: var(--vscode-foreground); }
    .log-line.debug   { color: var(--vscode-descriptionForeground); }
    .log-line.warn    { color: var(--vscode-charts-yellow); }
    .log-line.error   { color: var(--vscode-charts-red); }
    .log-line.success { color: var(--vscode-charts-green); }

    /* ---------- misc ---------- */
    .footer {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    .hint {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="status" aria-label="Model status">
    <div class="status-row">
      <span class="status-dot" id="masterDot"></span>
      <span class="status-label">Master</span>
      <span class="status-value" id="masterModel" title="">loading…</span>
    </div>
    <div class="status-row">
      <span class="status-dot" id="workerDot"></span>
      <span class="status-label">Worker</span>
      <span class="status-value" id="workerModel" title="">loading…</span>
    </div>
    <div class="status-row">
      <span class="status-label">Folder</span>
      <span class="status-value" id="workspaceFolder" title="">—</span>
    </div>
  </div>

  <div class="input-area">
    <textarea id="goal" placeholder="Describe the goal, e.g. 'Add a REST endpoint that lists all TODO items'" spellcheck="false"></textarea>
    <div class="button-row">
      <button class="primary" id="executeBtn" type="button">▶ Execute</button>
      <button class="secondary" id="resetBtn" type="button">↺ Reset</button>
    </div>
    <div class="hint">Worker indexes & drafts · Master plans & reviews · keys never leave your machine</div>
  </div>

  <div class="tracker" id="tracker">
    <div class="stage" data-stage="indexing">
      <span class="marker"></span>
      <span class="stage-title">1 · Worker Indexing</span>
      <span class="stage-detail"></span>
    </div>
    <div class="stage" data-stage="planning">
      <span class="marker"></span>
      <span class="stage-title">2 · Master Planning</span>
      <span class="stage-detail"></span>
    </div>
    <div class="stage" data-stage="executing">
      <span class="marker"></span>
      <span class="stage-title">3 · Worker Executing</span>
      <span class="stage-detail"></span>
    </div>
    <div class="stage" data-stage="completed">
      <span class="marker"></span>
      <span class="stage-title">4 · Completed</span>
      <span class="stage-detail"></span>
    </div>
    <ul class="task-list" id="taskList"></ul>
  </div>

  <div class="summary" id="summary"></div>

  <div class="console-wrap">
    <div class="console-head">
      <span>Console</span>
      <span id="logCount">0</span>
    </div>
    <div class="console" id="console"></div>
  </div>

  <div class="footer">MasterX · asymmetric Master-Worker orchestration</div>

  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var busy = false;

      var els = {
        masterModel: document.getElementById('masterModel'),
        workerModel: document.getElementById('workerModel'),
        workspaceFolder: document.getElementById('workspaceFolder'),
        masterDot: document.getElementById('masterDot'),
        workerDot: document.getElementById('workerDot'),
        goal: document.getElementById('goal'),
        executeBtn: document.getElementById('executeBtn'),
        resetBtn: document.getElementById('resetBtn'),
        tracker: document.getElementById('tracker'),
        taskList: document.getElementById('taskList'),
        summary: document.getElementById('summary'),
        console: document.getElementById('console'),
        logCount: document.getElementById('logCount')
      };

      var STAGES = ['indexing', 'planning', 'executing', 'completed'];
      var logTotal = 0;

      function post(msg) {
        vscode.postMessage(msg);
      }

      function setBusy(value) {
        busy = value;
        els.executeBtn.disabled = value;
        els.executeBtn.textContent = value ? '⏳ Running…' : '▶ Execute';
      }

      function appendLog(message, level) {
        var line = document.createElement('div');
        line.className = 'log-line ' + (level || 'info');
        line.textContent = message;
        els.console.appendChild(line);
        logTotal += 1;
        els.logCount.textContent = String(logTotal);
        els.console.scrollTop = els.console.scrollHeight;
        while (els.console.childElementCount > 800) {
          els.console.removeChild(els.console.firstChild);
        }
      }

      function resetStages() {
        var nodes = els.tracker.querySelectorAll('.stage');
        for (var i = 0; i < nodes.length; i++) {
          nodes[i].className = 'stage';
          var detail = nodes[i].querySelector('.stage-detail');
          if (detail) { detail.textContent = ''; }
        }
        els.taskList.innerHTML = '';
        els.taskList.className = 'task-list';
        els.summary.textContent = '';
        els.summary.className = 'summary';
      }

      function setStage(stage, detail) {
        var order = STAGES.indexOf(stage);
        if (stage === 'error') {
          var active = els.tracker.querySelector('.stage.active');
          if (active) { active.className = 'stage error'; }
          if (detail) { appendLog('FAILED: ' + detail, 'error'); }
          return;
        }
        for (var i = 0; i < STAGES.length; i++) {
          var node = els.tracker.querySelector('.stage[data-stage="' + STAGES[i] + '"]');
          if (!node) { continue; }
          if (i < order) { node.className = 'stage done'; }
          else if (i === order) { node.className = 'stage active'; }
          else { node.className = 'stage'; }
        }
        if (order >= 0) {
          var current = els.tracker.querySelector('.stage[data-stage="' + stage + '"] .stage-detail');
          if (current) { current.textContent = detail || ''; }
        }
      }

      function addSubtasks(tasks) {
        els.taskList.innerHTML = '';
        for (var i = 0; i < tasks.length; i++) {
          var li = document.createElement('li');
          li.className = 'task-item status-pending';
          li.id = 'task-' + tasks[i].id;
          li.innerHTML = '<span class="badge">' + tasks[i].id + '</span>' +
            '<span class="path">' + tasks[i].action + ' · ' + tasks[i].targetPath + '</span>';
          els.taskList.appendChild(li);
        }
        els.taskList.className = 'task-list visible';
      }

      function setTask(id, status, detail) {
        var li = document.getElementById('task-' + id);
        if (!li) { return; }
        li.className = 'task-item status-' + status;
        var badge = li.querySelector('.badge');
        if (badge) {
          badge.textContent = status === 'done' ? '✓' : status === 'failed' ? '✕' : id;
        }
        li.title = detail || '';
      }

      function setSummary(text) {
        els.summary.textContent = text;
        els.summary.className = 'summary visible';
      }

      els.executeBtn.addEventListener('click', function () {
        if (busy) { return; }
        var goal = els.goal.value.trim();
        if (!goal) {
          appendLog('Enter a goal before executing.', 'warn');
          return;
        }
        post({ type: 'execute', goal: goal });
      });

      els.resetBtn.addEventListener('click', function () {
        if (busy) {
          appendLog('Wait for the current run to finish before resetting.', 'warn');
          return;
        }
        post({ type: 'reset' });
      });

      els.goal.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          els.executeBtn.click();
        }
      });

      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg || !msg.type) { return; }

        switch (msg.type) {
          case 'init':
            els.masterModel.textContent = msg.masterModel || '(unset)';
            els.masterModel.title = msg.masterModel || '';
            els.workerModel.textContent = msg.workerModel || '(unset)';
            els.workerModel.title = msg.workerModel || '';
            els.workspaceFolder.textContent = msg.workspaceFolder || '—';
            els.masterDot.className = 'status-dot';
            els.workerDot.className = 'status-dot';
            if (!msg.masterModel) { els.masterDot.className = 'status-dot error'; }
            if (!msg.workerModel) { els.workerDot.className = 'status-dot error'; }
            break;

          case 'log':
            appendLog(msg.message, msg.level);
            if (msg.level === 'error') {
              els.masterDot.className = 'status-dot error';
            }
            break;

          case 'stage':
            setStage(msg.stage, msg.detail);
            break;

          case 'subtasks':
            addSubtasks(msg.tasks || []);
            break;

          case 'task':
            setTask(msg.id, msg.status, msg.detail);
            break;

          case 'summary':
            setSummary(msg.text);
            break;

          case 'busy':
            setBusy(!!msg.value);
            break;

          case 'reset':
            resetStages();
            logTotal = 0;
            els.logCount.textContent = '0';
            els.console.innerHTML = '';
            break;

          case 'focus-input':
            els.goal.focus();
            break;

          case 'do-execute':
            els.executeBtn.click();
            break;
        }
      });

      post({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}

/** CSP nonce for the inline script. */
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
