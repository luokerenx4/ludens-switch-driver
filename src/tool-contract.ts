import { readFile } from "node:fs/promises";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Clock, Observation, ToolExecutionResult } from "./contracts.ts";

/** CUA exposes this native MCP contract. Baseware preserves it instead of translating argv. */
export type ToolDefinition = Tool;
export type ToolResult = CallToolResult;
export type ToolArguments = Record<string, unknown>;
export type JsonSchema = Record<string, unknown>;

export function objectArguments(value: unknown): ToolArguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be a JSON object");
  return value as ToolArguments;
}

/** CLI decoding only. Files contain the same complete argument object as --args. */
export async function readToolArguments(argv: readonly string[]): Promise<ToolArguments> {
  if (!argv.length) return {};
  if (argv.length !== 2 || !["--args", "--file"].includes(argv[0]!)) throw new Error("Use --args '<JSON object>' or --file <arguments.json>");
  const text = argv[0] === "--file" ? await readFile(argv[1]!, "utf8") : argv[1]!;
  return objectArguments(JSON.parse(text));
}

export function argumentValidator(tool: ToolDefinition): (value: unknown) => ToolArguments {
  // MCP defaults to 2020-12; explicitly declared draft-07 schemas keep their own semantics.
  const options = { strict: false, allErrors: true };
  const ajv = typeof tool.inputSchema.$schema === "string" && tool.inputSchema.$schema.includes("draft-07")
    ? new Ajv(options) : new Ajv2020(options);
  addFormats(ajv);
  const validate = ajv.compile(tool.inputSchema);
  return value => {
    const args = objectArguments(value);
    if (!validate(args)) throw new Error(`Invalid arguments for ${tool.name}: ${ajv.errorsText(validate.errors)}`);
    return args;
  };
}

export function structuredResult(output: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
}

/** The native result remains intact; stdout is only a text summary for existing run consumers. */
export function toolExecution(clock: Clock, requestedAtMs: number, result: ToolResult,
  extra: Partial<Omit<ToolExecutionResult, "result" | "timing">> = {}): ToolExecutionResult {
  const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  return { id: crypto.randomUUID(), status: result.isError ? "failed" : "completed", exitCode: result.isError ? 1 : 0,
    stdout: result.isError ? "" : text, stderr: result.isError ? text : "",
    timing: { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() }, ...extra, result };
}

/** Log representation only: keep references when available, never inline binary payloads. */
export function archivedToolResult(result: ToolResult, observations: readonly Observation[] = []): Record<string, unknown> {
  return { ...result, content: result.content.map((block, index) => {
    const observation = observations.find(item => item.contentIndex === index);
    if (block.type === "image" || block.type === "audio") {
      const { data, ...rest } = block;
      return { ...rest, ...(observation?.timeline ? { timeline: observation.timeline }
        : observation?.path ? { dataPath: observation.path } : { dataOmitted: true }), encodedBytes: data.length };
    }
    if (block.type === "resource" && "blob" in block.resource) {
      const { blob, ...resource } = block.resource;
      return { ...block, resource: { ...resource, ...(observation?.timeline ? { timeline: observation.timeline }
        : observation?.path ? { blobPath: observation.path } : { blobOmitted: true }), encodedBytes: blob.length } };
    }
    return block;
  }) };
}

export function observationMetadata({ data: _data, ...observation }: Observation): Observation { return observation; }
