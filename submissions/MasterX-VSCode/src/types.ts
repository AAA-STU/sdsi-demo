/**
 * Shared types for the MasterX Master-Worker orchestration pipeline.
 *
 * Both roles are separate `claude` CLI instances configured with different
 * models. The CLI owns authentication (it reads ~/.claude/settings.json and the
 * environment itself), so MasterX never handles credentials.
 */

/** Actions the Master may emit in a plan. */
export type TaskAction = 'create_file' | 'edit_file' | 'run_command';

/** A single unit of work produced by the Master. */
export interface SubTask {
  /** Stable identifier within one plan (assigned during normalization). */
  id: string;
  action: TaskAction;
  /** Workspace-relative path for file actions; command label for run_command. */
  targetPath: string;
  /** Precise, self-contained specification the Worker must follow. */
  instructions: string;
}

/** The strict JSON execution plan produced by the Master. */
export interface MasterPlan {
  /** The Master's reasoning about how to approach the goal. */
  thought: string;
  tasks: SubTask[];
}

/** Outcome of executing one SubTask. */
export interface TaskResult {
  taskId: string;
  action: TaskAction;
  targetPath: string;
  success: boolean;
  /** File content written, command dispatched, or stdout summary. */
  output: string;
  /** Present only when success is false. */
  error?: string;
}

/** Severity for console log lines pushed to the webview. */
export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';

export type LogFn = (message: string, level: LogLevel) => void;

/** Progress stages shown in the webview tracker. */
export type StageId = 'indexing' | 'planning' | 'executing' | 'completed' | 'error';

/** Per-task execution status shown in the webview task list. */
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

/** One model id plus a human-readable note about where it came from. */
export interface ResolvedModel {
  model: string;
  modelSource: string;
}

/**
 * Fully resolved configuration for one MasterX run. Both roles are Claude CLI
 * instances; only the model id and the prompts differ.
 */
export interface MasterXConfig {
  /** Resolved path to the `claude` executable. */
  claudeCliPath: string;
  /** Deep-thinking role: plans and synthesizes. */
  master: ResolvedModel;
  /** Lightweight role: indexes the codebase and drafts code and commands. */
  worker: ResolvedModel;
}

/** Result of reading settings + environment + ~/.claude/settings.json. */
export interface ConfigLoadResult {
  config: MasterXConfig;
  /** Non-fatal problems worth surfacing to the user. */
  warnings: string[];
}

/** Shape of the message envelope shared with the webview. */
export type WebviewOutboundMessage =
  | { type: 'init'; masterModel: string; workerModel: string; workspaceFolder: string }
  | { type: 'log'; message: string; level: LogLevel }
  | { type: 'stage'; stage: StageId; detail: string }
  | { type: 'subtasks'; tasks: Array<Pick<SubTask, 'id' | 'action' | 'targetPath'>> }
  | { type: 'task'; id: string; status: TaskStatus; detail: string }
  | { type: 'summary'; text: string }
  | { type: 'busy'; value: boolean }
  | { type: 'reset' }
  | { type: 'focus-input' }
  | { type: 'do-execute' };

export type WebviewInboundMessage =
  | { type: 'ready' }
  | { type: 'execute'; goal: string }
  | { type: 'reset' };
