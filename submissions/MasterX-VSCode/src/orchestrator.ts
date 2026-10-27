import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Master } from './master';
import { Worker } from './worker';
import {
  LogFn,
  StageId,
  SubTask,
  TaskResult,
  TaskStatus,
} from './types';

/** How many files the Worker sees listed during indexing. */
const MAX_INDEX_FILES = 400;

/** How many files are sampled for content during indexing. */
const MAX_SAMPLE_FILES = 12;

/** Per-file sample cap, in characters. */
const MAX_SAMPLE_CHARS = 2_000;

/** Command execution timeout (ms). */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Polling interval while waiting for a command to finish (ms). */
const COMMAND_POLL_MS = 300;

/** Marker appended to the command log to signal completion + exit code. */
const EXIT_MARKER = '__MASTERX_EXIT:';

/** Text file extensions eligible for content sampling during indexing. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.html', '.css',
  '.scss', '.sass', '.less', '.py', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.cs',
  '.c', '.h', '.hpp', '.cpp', '.cc', '.swift', '.scala', '.sh', '.bash', '.ps1', '.bat',
  '.cmd', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.xml', '.sql', '.graphql', '.vue',
  '.svelte', '.astro', '.lock', '.env', '.example', '.dockerfile', '.gradle', '.cmake',
  '.proto', '.tf', '.prisma', '.razor', '.cshtml', '.html.erb',
]);

/** File names with no extension that are still plain text. */
const TEXT_FILENAMES = new Set([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile', 'LICENSE', 'README',
  'CHANGELOG', 'CNAME', 'Jenkinsfile', 'CODEOWNERS', '.gitignore', '.npmrc', '.env',
]);

export interface OrchestratorHooks {
  onLog: LogFn;
  onStage: (stage: StageId, detail: string) => void;
  onSubtasks: (tasks: SubTask[]) => void;
  onTask: (id: string, status: TaskStatus, detail: string) => void;
  onSummary: (text: string) => void;
}

interface WorkspaceScan {
  fileList: string[];
  sampleContents: string;
}

interface CommandOutcome {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * The 3-stage lifecycle that ties the pipeline together:
 *   1. Worker scans the workspace and writes a dense architectural summary.
 *   2. Master turns the summary + goal into a strict JSON execution plan.
 *   3. Worker executes every task (files written via workspace.fs, commands run
 *      in a VS Code terminal with captured output).
 *   4. Master synthesizes the final report from the execution results.
 *
 * Every step reports through the streaming hooks so the webview stays live.
 */
export class Orchestrator {
  constructor(
    private readonly worker: Worker,
    private readonly master: Master,
    private readonly hooks: OrchestratorHooks
  ) {}

  /** Run the full lifecycle for one goal. Never throws; failures are reported. */
  async run(goal: string): Promise<void> {
    const results: TaskResult[] = [];

    try {
      // ---- Stage 1: Worker indexes the codebase -----------------------------
      this.hooks.onStage('indexing', 'Worker indexing codebase…');
      this.hooks.onLog('Stage 1/4 — Worker: scanning workspace files…', 'info');

      const scan = await this.scanWorkspace();
      this.hooks.onLog(
        `Workspace scan: ${scan.fileList.length} file(s) listed, sampled content ${scan.sampleContents.length} chars.`,
        'debug'
      );

      const summary = await this.worker.indexAndSummarize(goal, scan.fileList, scan.sampleContents);
      this.hooks.onLog(`Worker summary ready (${summary.length} chars).`, 'success');

      // ---- Stage 2: Master plans -------------------------------------------
      this.hooks.onStage('planning', 'Master thinking & planning…');
      this.hooks.onLog('Stage 2/4 — Master: generating execution plan…', 'info');

      const plan = await this.master.plan(goal, summary);
      this.hooks.onLog(`Master plan received: ${plan.tasks.length} task(s).`, 'success');
      if (plan.thought.trim()) {
        this.hooks.onLog(`Master reasoning: ${plan.thought.trim()}`, 'debug');
      }
      this.hooks.onSubtasks(plan.tasks);

      if (plan.tasks.length === 0) {
        this.hooks.onLog('Master produced an empty plan; nothing to execute.', 'warn');
      }

      // ---- Stage 3: Worker executes ---------------------------------------
      this.hooks.onStage('executing', `Worker executing ${plan.tasks.length} task(s)…`);
      this.hooks.onLog('Stage 3/4 — Worker: executing plan tasks…', 'info');

      for (const task of plan.tasks) {
        this.hooks.onTask(task.id, 'running', task.targetPath);
        try {
          const result = await this.executeOne(task);
          results.push(result);
          if (result.success) {
            this.hooks.onTask(task.id, 'done', result.output.split('\n')[0] ?? 'done');
          } else {
            this.hooks.onTask(task.id, 'failed', result.error ?? 'failed');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            taskId: task.id,
            action: task.action,
            targetPath: task.targetPath,
            success: false,
            output: '',
            error: message,
          });
          this.hooks.onTask(task.id, 'failed', message);
          this.hooks.onLog(`Task ${task.id} failed: ${message}`, 'error');
        }
      }

      const okCount = results.filter((r) => r.success).length;
      this.hooks.onLog(`Execution finished: ${okCount}/${results.length} task(s) succeeded.`, okCount === results.length ? 'success' : 'warn');

      // ---- Stage 4: Master synthesizes ------------------------------------
      this.hooks.onStage('completed', 'Master writing final report…');
      this.hooks.onLog('Stage 4/4 — Master: synthesizing final report…', 'info');

      const report = await this.master.synthesize(goal, results);
      this.hooks.onSummary(report);
      this.hooks.onLog('Final report ready.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hooks.onLog(message, 'error');
      this.hooks.onStage('error', message);
    }
  }

  /** Execute one Master-specified task and return its result. */
  private async executeOne(task: SubTask): Promise<TaskResult> {
    if (task.action === 'run_command') {
      const command = await this.worker.executeTask(task);
      this.hooks.onLog(`Running command (${task.id}): ${command}`, 'info');
      const outcome = await this.runCommand(command, this.requireWorkspaceRoot().uri.fsPath);
      if (outcome.success) {
        this.hooks.onLog(`Command completed (exit 0): ${command}`, 'success');
      } else {
        this.hooks.onLog(`Command failed: ${outcome.error ?? 'unknown error'}`, 'error');
      }
      return {
        taskId: task.id,
        action: task.action,
        targetPath: task.targetPath,
        success: outcome.success,
        output: outcome.output,
        error: outcome.error,
      };
    }

    const root = this.requireWorkspaceRoot();
    const target = this.resolveWorkspacePath(task.targetPath);
    const existingContent = await this.readExisting(target, task.action);

    this.hooks.onLog(
      `${task.action === 'create_file' ? 'Creating' : 'Editing'} ${path.relative(root.uri.fsPath, target).replace(/\\/g, '/')} (${task.id})…`,
      'info'
    );

    const contents = await this.worker.executeTask(task, existingContent);

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(contents, 'utf8'));

    this.hooks.onLog(`Wrote ${contents.length} chars to ${path.basename(target)}.`, 'success');
    return {
      taskId: task.id,
      action: task.action,
      targetPath: task.targetPath,
      success: true,
      output: `Wrote ${contents.length} chars to ${path.relative(root.uri.fsPath, target).replace(/\\/g, '/')}.`,
    };
  }

  /** Read the current contents of a file for edit tasks; undefined for creates. */
  private async readExisting(target: string, action: SubTask['action']): Promise<string | undefined> {
    if (action === 'create_file') {
      return undefined;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
      return Buffer.from(bytes).toString('utf8');
    } catch {
      // File does not exist yet — the Worker will create it from instructions.
      return undefined;
    }
  }

  /**
   * Run one command in a dedicated VS Code terminal (so the user sees live
   * output) while tee-ing the output to a temp log that this method reads back,
   * giving the pipeline a real exit code and stdout for the Master's review.
   */
  private async runCommand(command: string, cwd: string): Promise<CommandOutcome> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logFile = path.join(os.tmpdir(), `masterx-${stamp}.log`);
    const scriptFile = path.join(os.tmpdir(), `masterx-${stamp}.cmd`);
    const isWindows = process.platform === 'win32';

    let shellPath: string;
    let shellArgs: string[];

    if (isWindows) {
      // cmd.exe has no tee, so the command's output is redirected to a log file
      // and replayed into the terminal at the end. The orchestrator streams the
      // same log live into the MasterX console so the user still sees progress.
      const windir = process.env.windir ?? 'C:\\Windows';
      shellPath = path.join(windir, 'System32', 'cmd.exe');
      const script = [
        '@echo off',
        `set "MASTERX_LOG=${logFile}"`,
        `${command} > "%MASTERX_LOG%" 2>&1`,
        `echo ${EXIT_MARKER}%ERRORLEVEL% >> "%MASTERX_LOG%"`,
        `type "%MASTERX_LOG%"`,
        '',
      ].join('\r\n');
      fs.writeFileSync(scriptFile, script, 'utf8');
      shellArgs = ['/d', '/c', scriptFile];
    } else {
      shellPath = '/bin/bash';
      const shScript =
        '{ ' + command + ' 2>&1; echo "' + EXIT_MARKER + '$?"; } | tee ' + quoteShell(logFile);
      shellArgs = ['-c', shScript];
    }

    let terminal: vscode.Terminal;
    try {
      terminal = vscode.window.createTerminal({
        name: `MasterX: ${command.slice(0, 40)}${command.length > 40 ? '…' : ''}`,
        cwd,
        shellPath,
        shellArgs,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { success: false, output: '', error: `Failed to create command terminal: ${detail}` };
    }

    terminal.show(true);

    // Fail fast if the terminal is closed before the command reports in.
    let closedEarly = false;
    const closeSubscription = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        closedEarly = true;
      }
    });

    try {
      const deadline = Date.now() + COMMAND_TIMEOUT_MS;
      let streamPos = 0;

      while (Date.now() < deadline) {
        await delay(COMMAND_POLL_MS);

        if (closedEarly && !fs.existsSync(logFile)) {
          return {
            success: false,
            output: '',
            error: 'The command terminal was closed before the command finished.',
          };
        }

        const text = readLogIfAny(logFile);
        if (text === undefined) {
          continue;
        }

        // Stream whatever the command has emitted so far into the MasterX
        // console — cmd.exe itself only replays the log once the command ends.
        const markerIndex = text.lastIndexOf(EXIT_MARKER);
        const visible = markerIndex === -1 ? text : text.slice(0, markerIndex);
        if (visible.length > streamPos) {
          const chunk = visible.slice(streamPos);
          streamPos = visible.length;
          for (const line of chunk.split(/\r?\n/)) {
            if (line.trim() !== '') {
              this.hooks.onLog(line, 'debug');
            }
          }
        }

        if (markerIndex === -1) {
          continue;
        }

        const codeMatch = text.slice(markerIndex + EXIT_MARKER.length).match(/(-?\d+)/);
        const exitCode = codeMatch ? parseInt(codeMatch[1], 10) : 0;
        const output = text.slice(0, markerIndex).trim();

        return {
          success: exitCode === 0,
          output: output || `Command produced no output (exit code ${exitCode}).`,
          error: exitCode === 0 ? undefined : `Command exited with code ${exitCode}.`,
        };
      }

      const partial = readLogIfAny(logFile) ?? '';
      return {
        success: false,
        output: partial.trim(),
        error: `Command timed out after ${Math.round(COMMAND_TIMEOUT_MS / 60000)} minutes.`,
      };
    } finally {
      closeSubscription.dispose();
      terminal.dispose();
      try {
        if (fs.existsSync(logFile)) {
          fs.unlinkSync(logFile);
        }
        if (fs.existsSync(scriptFile)) {
          fs.unlinkSync(scriptFile);
        }
      } catch {
        // Best-effort cleanup of the temp files.
      }
    }
  }

  /** List workspace files and sample the contents of a few representative ones. */
  private async scanWorkspace(): Promise<WorkspaceScan> {
    const root = this.requireWorkspaceRoot();

    const uris = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,out,dist,build,bin,obj,.git,.vscode,.idea,target,vendor}/**',
      MAX_INDEX_FILES
    );

    const fileList = uris
      .map((uri) => path.relative(root.uri.fsPath, uri.fsPath).replace(/\\/g, '/'))
      .sort();

    const sampleParts: string[] = [];
    let budget = 24_000;

    const sorted = [...uris].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    for (const uri of sorted) {
      if (sampleParts.length >= MAX_SAMPLE_FILES || budget <= 0) {
        break;
      }
      if (!isTextFile(uri.fsPath)) {
        continue;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        if (text.includes('\u0000')) {
          continue; // binary content
        }
        const relPath = path.relative(root.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
        const slice = text.slice(0, MAX_SAMPLE_CHARS);
        sampleParts.push(`--- ${relPath} ---\n${slice}`);
        budget -= slice.length;
      } catch {
        // Unreadable file — skip it silently during sampling.
      }
    }

    return { fileList, sampleContents: sampleParts.join('\n\n') };
  }

  /** Resolve a workspace-relative task path and refuse escapes outside the root. */
  private resolveWorkspacePath(targetPath: string): string {
    const root = this.requireWorkspaceRoot();
    const expanded = targetPath.trim();
    const absolute = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(root.uri.fsPath, expanded);

    const relative = path.relative(root.uri.fsPath, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Task target "${targetPath}" resolves outside the workspace and was refused. ` +
          'All file tasks must stay inside the workspace folder.'
      );
    }
    return absolute;
  }

  /** Return the first workspace folder or throw an actionable error. */
  private requireWorkspaceRoot(): vscode.WorkspaceFolder {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open. Open a folder before running MasterX.');
    }
    return folder;
  }
}

/** Delay helper for polling loops. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a log file if it exists; undefined when missing or unreadable. */
function readLogIfAny(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Decide whether a path looks like a plain text file worth sampling. */
function isTextFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (TEXT_FILENAMES.has(base)) {
    return true;
  }
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Quote a path for a POSIX shell word. */
function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
