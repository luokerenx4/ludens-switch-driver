import type { Clock, ControllerContext, ExecutionResult, ToolArguments, ToolExecutionResult } from "./contracts.ts";
import type { Bridge } from "./bridge.ts";
import { structuredResult, toolExecution } from "./tool-contract.ts";

type ActionStatus = "running" | ExecutionResult["status"];
interface Action {
  id: string;
  epoch: string;
  status: ActionStatus;
  requestedAtMs: number;
  receivedAtMs?: number;
  output?: unknown;
  error?: string;
  done: Promise<void>;
}

/** One native pad action per device; the ownership lease, not a CLI process, owns it. */
export function createPadPlayer(options: {
  bridge: Bridge; clock: Clock;
  encode(inputs: unknown): string;
  decode(fields: string[]): unknown;
}) {
  const { bridge, clock } = options;
  const actions = new Map<string, Action>();
  let active: Action | undefined;
  const payload = (action: Action) => ({ actionId: action.id, status: action.status,
    timing: { clock: clock.id, submittedAtMs: action.requestedAtMs, completedAtMs: action.receivedAtMs },
    ...(action.output as Record<string, unknown> | undefined), ...(action.error ? { error: action.error } : {}) });

  async function wait(action: Action, signal: AbortSignal) {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error("Wait cancelled"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try { await Promise.race([action.done, cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
  }

  return {
    // Native STOP/DISOWN acknowledgements can arrive before the action's terminal reply.
    async settle() { await active?.done; },
    reset() {
      if (active) throw new Error("BUSY: previous pad action has not finished releasing");
      actions.clear();
    },
    async execute(command: string, args: ToolArguments, context: ControllerContext): Promise<ToolExecutionResult> {
      const { signal, controlSignal, epoch } = context;
      signal.throwIfAborted();
      if (!epoch) throw new Error("STALE_EPOCH");
      const requestedAtMs = clock.now();
      let action: Action;
      if (command === "play") {
        const sequence = options.encode(args.inputs);
        signal.throwIfAborted();
        controlSignal?.throwIfAborted();
        if (active) throw new Error("BUSY: a pad action is already running");
        action = { id: crypto.randomUUID(), epoch, status: "running", requestedAtMs: clock.now(), done: Promise.resolve() };
        active = action;
        actions.set(action.id, action);
        // A submitted job can subsequently fail in the native bridge. Keep that terminal
        // result for wait/status and publish it even if the submitting RPC has closed.
        context.record?.("action_start", { ...payload(action) });
        const pending = bridge.request("APPLY", [epoch, sequence], action.id);
        const cancel = () => { void bridge.request("STOP", [epoch, action.id]).catch(() => {}); };
        controlSignal?.addEventListener("abort", cancel, { once: true });
        const submitted = action;
        action.done = (async () => {
          try {
            const [outcome, ...fields] = await pending;
            if (outcome !== "completed" && outcome !== "interrupted") throw new Error(`Unexpected action outcome: ${outcome}`);
            submitted.status = outcome;
            submitted.output = options.decode(fields);
          } catch (error) {
            submitted.status = controlSignal?.aborted ? "interrupted" : "failed";
            submitted.error = String(error);
          } finally {
            controlSignal?.removeEventListener("abort", cancel);
            submitted.receivedAtMs = clock.now();
            active = undefined;
            // Bounded in-memory lookup; full results remain in the event log.
            while (actions.size > 64) actions.delete(actions.keys().next().value!);
            context.record?.("action_end", { ...payload(submitted), id: submitted.id,
              exitCode: submitted.status === "completed" ? 0 : submitted.status === "interrupted" ? 130 : 1,
              stdout: JSON.stringify(payload(submitted)), stderr: submitted.error ?? "",
              timing: { clock: clock.id, requestedAtMs: submitted.requestedAtMs, receivedAtMs: submitted.receivedAtMs } });
          }
        })();
        if (args.wait === true) await wait(action, signal);
      } else if (command === "wait" || command === "status" || command === "cancel") {
        const found = actions.get(args.actionId as string);
        if (!found || found.epoch !== epoch) throw new Error("Unknown action in this control epoch (only the latest 64 results are retained)");
        action = found;
        if (command === "cancel" && action.status === "running") await bridge.request("STOP", [epoch, action.id]);
        if (command !== "status") await wait(action, signal);
      } else throw new Error("Unknown pad command; see --help");

      const terminal = command === "wait" || command === "cancel" || command === "play" && args.wait === true;
      const status = terminal && action.status !== "running" ? action.status : "completed";
      const result = structuredResult(payload(action));
      if (status !== "completed") result.isError = true;
      return toolExecution(clock, requestedAtMs, result, { actionId: action.id, status,
        readOnly: command === "status" || command === "wait",
        exitCode: status === "completed" ? 0 : status === "interrupted" ? 130 : 1,
        stdout: JSON.stringify(payload(action)), stderr: terminal ? action.error ?? "" : "" });
    },
  };
}
