import * as path from 'path';
import {
  ClaudeCliError,
  ClaudeCliResult,
  parseJsonResult,
  runClaudeCli,
  stripWrappingFences,
  truncate,
} from './claudeCli';
import { LogFn, SubTask } from './types';

/** Cap on characters of raw file content sent to the Worker during indexing. */
const SAMPLE_CONTENT_CAP = 24_000;

/** Cap on characters of existing file content shown when editing. */
const EXISTING_CONTENT_CAP = 30_000;

/** Read-only tools: the Worker may inspect the codebase but never drive it. */
const INDEX_TOOLS = ['Read', 'Glob', 'Grep'];

/** Drafting is text-in/text-out; no tools needed. */
const DRAFT_TOOLS: string[] = [];

export interface WorkerOptions {
  /** Resolved path to the `claude` executable. */
  cliPath: string;
  /** Workspace directory the Worker runs in. */
  cwd: string;
  /** Model id for the Worker (a cheaper Claude CLI model than the Master's). */
  model: string;
  log?: LogFn;
}

/**
 * The Worker: a separate `claude` CLI instance bound to a lighter model. It
 * does the high-volume work — walking the codebase into a dense summary, then
 * drafting complete file contents and commands to the Master's specification —
 * so the Master never has to read raw source or write boilerplate.
 */
export class Worker {
  private readonly cliPath: string;
  private readonly cwd: string;
  private readonly model: string;
  private readonly log: LogFn;

  constructor(options: WorkerOptions) {
    this.cliPath = options.cliPath;
    this.cwd = options.cwd;
    this.model = options.model;
    this.log = options.log ?? (() => undefined);

    if (!this.model || !this.model.trim()) {
      throw new ClaudeCliError('Worker: model id is empty. Set `masterx.workerModel`.');
    }
  }

  /** The model id this Worker is bound to (shown in the status bar). */
  get modelId(): string {
    return this.model;
  }

  /**
   * Stage 1: review the workspace file listing and sampled contents, then
   * return a concise, high-density architectural summary the Master can plan
   * from without reading the raw codebase.
   *
   * The Worker is given read-only tools so it can spot-check files it wants to
   * understand better than the samples allow.
   */
  async indexAndSummarize(goal: string, fileList: string[], sampleContents: string): Promise<string> {
    const truncatedList = fileList.slice(0, 400);
    const listBlock =
      truncatedList.length > 0
        ? truncatedList.map((f) => `- ${f}`).join('\n')
        : '(workspace contains no files)';

    const sampleBlock =
      sampleContents.trim().length > 0
        ? sampleContents.slice(0, SAMPLE_CONTENT_CAP)
        : '(no sample file contents available)';

    const system =
      'You are the indexing Worker in a Master-Worker code-generation pipeline, running as a ' +
      'separate Claude CLI instance with a lightweight model. ' +
      'Your job is to inspect a codebase listing plus sampled file contents and produce a ' +
      'HIGH-DENSITY architectural summary. A separate expensive planning model will read ONLY ' +
      'your summary — never the raw code — so every line you write must carry information. ' +
      'Cover: purpose of the project, languages/frameworks, directory layout, key modules and ' +
      'their responsibilities, important types/interfaces/exports, entry points, build tooling, ' +
      'and any conventions or constraints that would affect writing new code. ' +
      'You have Read, Glob and Grep available: use them sparingly to confirm details the samples ' +
      'leave ambiguous, then stop. ' +
      'Do not include raw source dumps. Do not ask questions. Do not modify anything. ' +
      'Output plain structured text with short section headings only.';

    const prompt =
      `USER GOAL (context for what the planner will later implement):\n${goal.trim() || '(no specific goal yet — summarize the codebase)'}\n\n` +
      `WORKSPACE FILE LIST (${truncatedList.length} shown of ${fileList.length} total):\n${listBlock}\n\n` +
      `SAMPLED FILE CONTENTS (truncated to ${SAMPLE_CONTENT_CAP} chars):\n${sampleBlock}\n\n` +
      `Produce the high-density architectural summary now.`;

    const outcome = await runClaudeCli({
      cliPath: this.cliPath,
      cwd: this.cwd,
      model: this.model,
      role: 'worker',
      prompt,
      system,
      tools: INDEX_TOOLS,
      allowedTools: INDEX_TOOLS,
      permissionMode: 'dontAsk',
      timeoutMs: 10 * 60 * 1000,
      log: this.log,
    });

    this.logFor(outcome);
    return outcome.result.trim();
  }

  /**
   * Stage 3: produce the deliverable for one Master-specified SubTask —
   * complete file contents for file actions, or the exact command line for
   * run_command actions.
   */
  async executeTask(task: SubTask, existingContent?: string): Promise<string> {
    if (task.action === 'run_command') {
      return this.draftCommand(task);
    }
    return this.draftFile(task, existingContent);
  }

  /** Draft a single shell command line from the Master's instructions. */
  private async draftCommand(task: SubTask): Promise<string> {
    const targetShell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const syntaxHint =
      process.platform === 'win32'
        ? 'Use cmd.exe syntax only — no PowerShell, no bash, no POSIX sh. Prefer `where` over `which`, `dir` over `ls`. One simple command is best.'
        : 'Use POSIX bash syntax only.';

    const system =
      'You are the executing Worker in a Master-Worker code-generation pipeline. ' +
      `You receive one instruction from the planning model and must return EXACTLY ONE ${targetShell} ` +
      'command line to run in the project workspace. ' +
      `${syntaxHint} ` +
      'Respond with the command line only: no markdown fences, no commentary, no surrounding quotes. ' +
      'The command must be non-interactive and safe to run unattended.';

    const prompt =
      `COMMAND LABEL: ${task.targetPath}\n\n` +
      `MASTER INSTRUCTIONS:\n${task.instructions.trim()}\n\n` +
      'Return the single command line now.';

    const outcome = await runClaudeCli({
      cliPath: this.cliPath,
      cwd: this.cwd,
      model: this.model,
      role: 'worker',
      prompt,
      system,
      tools: DRAFT_TOOLS,
      allowedTools: [],
      timeoutMs: 5 * 60 * 1000,
      log: this.log,
    });

    this.logFor(outcome);

    const command = stripWrappingFences(outcome.result).trim();
    if (!command) {
      throw new ClaudeCliError(`Worker returned an empty command for task ${task.id}.`);
    }
    // Collapse to one line: the Master asked for a single command line.
    return command.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' && ');
  }

  /** Draft complete file contents from the Master's instructions. */
  private async draftFile(task: SubTask, existingContent?: string): Promise<string> {
    const isCreate = task.action === 'create_file';
    const system =
      'You are the executing Worker in a Master-Worker code-generation pipeline. ' +
      'You receive one file task from the planning model and must return the COMPLETE contents ' +
      'of the file to write — a full, working implementation with proper error handling and no ' +
      'placeholders, stubs, or "TODO: implement" sections. ' +
      'When editing an existing file you are given its current contents: return the entire updated ' +
      'file with the requested changes applied and everything else preserved — never a diff, never ' +
      'only the changed lines. ' +
      'Respond with the raw file contents ONLY: no markdown fences, no explanations before or after. ' +
      'If the instructions specify a language or style, follow it exactly.';

    const existingBlock =
      existingContent !== undefined && existingContent.length > 0
        ? `\n\nCURRENT FILE CONTENTS:\n${existingContent.slice(0, EXISTING_CONTENT_CAP)}${
            existingContent.length > EXISTING_CONTENT_CAP ? '\n… [truncated]' : ''
          }`
        : existingContent !== undefined
          ? '\n\nCURRENT FILE CONTENTS:\n(empty file)'
          : '';

    const prompt =
      `ACTION: ${isCreate ? 'CREATE a new file' : 'EDIT an existing file'}\n` +
      `TARGET PATH: ${task.targetPath}\n\n` +
      `MASTER INSTRUCTIONS:\n${task.instructions.trim()}${existingBlock}\n\n` +
      'Return the complete file contents now.';

    const outcome = await runClaudeCli({
      cliPath: this.cliPath,
      cwd: this.cwd,
      model: this.model,
      role: 'worker',
      prompt,
      system,
      tools: DRAFT_TOOLS,
      allowedTools: [],
      timeoutMs: 10 * 60 * 1000,
      log: this.log,
    });

    this.logFor(outcome);

    const contents = stripWrappingFences(outcome.result);
    if (!contents.trim()) {
      throw new ClaudeCliError(
        `Worker returned empty file contents for task ${task.id} (${task.targetPath}).`
      );
    }
    return contents;
  }

  private logFor(outcome: ClaudeCliResult): void {
    this.log(
      `Worker finished: ${outcome.output_tokens} output tokens, ` +
        `$${outcome.total_cost_usd.toFixed(4)}, ${Math.round(outcome.durationMs / 1000)}s.`,
      'debug'
    );
  }
}

/** Re-exported so the orchestrator can path-normalize task targets uniformly. */
export function toPosixRelative(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/g, '/');
}

/** Re-exported for callers that need to validate structured Worker output. */
export { parseJsonResult, truncate };
