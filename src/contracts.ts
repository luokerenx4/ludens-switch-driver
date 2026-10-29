import type { ToolArguments, ToolDefinition, ToolResult } from "./tool-contract.ts";
export type { ToolArguments, ToolDefinition, ToolResult, JsonSchema } from "./tool-contract.ts";

export interface Clock {
  id: string;
  now(): number;
}

/** Host-owned video metadata, kept local so the driver has no host dependency. */
export interface VideoFrameReference {
  pts: number;
  timeBase: [number, number];
  width: number;
  height: number;
  status?: "gap";
  reason?: string;
}

export interface Observation {
  id: string;
  controllerId: string;
  mediaType: string;
  /** Explicit caller-owned output or a timeline asset; inline media has no path. */
  path?: string;
  timeline?: { recordId?: string; sequence?: number; asset: string; video?: VideoFrameReference };
  /** Transient response bytes; never written into device event logs. */
  data?: string;
  timing: { clock: string; requestedAtMs: number; receivedAtMs: number };
  sourceSequence?: number;
  /** Position of the original native media content block. */
  contentIndex?: number;
}

export interface ExecutionResult {
  id: string;
  /** A command concerning a separately running device action, not its completion. */
  actionId?: string;
  /** A state query can require ownership without changing device input. */
  readOnly?: boolean;
  status: "completed" | "interrupted" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  timing: { clock: string; requestedAtMs: number; receivedAtMs: number };
  observations?: Observation[];
  /** Native payload; timing and control metadata remain outside its contract. */
  result?: ToolResult;
}

export interface ToolExecutionResult extends ExecutionResult { result: ToolResult }

export interface Controller {
  tool: ToolDefinition;
  /** Independent of readOnlyHint: even state queries may require device ownership. */
  requiresControl: boolean;
  mediaTypes?: readonly string[];
  acquire?(epoch: string): Promise<void>;
  execute(args: ToolArguments, context: ControllerContext): Promise<ToolExecutionResult>;
  release?(epoch: string): Promise<void>;
}

export interface ControllerContext {
  epoch?: string;
  signal: AbortSignal;
  /** Lifetime of device ownership, independent of an individual caller/waiter. */
  controlSignal?: AbortSignal;
  record?(type: "action_start" | "action_end", data: Record<string, unknown>): void;
}

export interface Capabilities {
  controllers: Controller[];
}
