import { runFlow, type RunFlowOptions } from "./core/flow.js";
import type { FlowRunner, FlowRunContext } from "./flow-runner.js";
import type { FlowConfig } from "./core/agents.js";
import type { AgentSessionMode } from "./core/session-mode.js";
import type { FlowDetails, SingleResult } from "./types/flow.js";

/** Hatchet task name used by the parent runner and worker entrypoint. */
export const HATCHET_FLOW_TASK_NAME = "pi-agent-flow.runFlow";

/** JSON-safe payload submitted to Hatchet for one flow attempt. */
export interface HatchetFlowPayload {
  cwd: string;
  flows: FlowConfig[];
  flowName: string;
  intent: string;
  aim: string;
  acceptance?: string;
  taskCwd?: string;
  forkSessionSnapshotJsonl: string | null;
  parentDepth: number;
  parentFlowStack: string[];
  maxDepth: number;
  preventCycles: boolean;
  toolOptimize?: boolean;
  structuredOutput?: boolean;
  model?: string;
  sessionMode?: AgentSessionMode;
  projectFlowsDir: string | null;
}

interface HatchetSdkModule {
  [key: string]: unknown;
}

type HatchetSubmitter = (taskName: string, payload: HatchetFlowPayload) => Promise<SingleResult>;

function makeFlowDetails(projectFlowsDir: string | null): (results: SingleResult[]) => FlowDetails {
  return (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: projectFlowsDir, results });
}

function assertJsonSerializable(payload: HatchetFlowPayload): void {
  JSON.parse(JSON.stringify(payload));
}

export function serializeHatchetFlowPayload(
  options: RunFlowOptions,
  projectFlowsDir: string | null = null,
): HatchetFlowPayload {
  const payload: HatchetFlowPayload = {
    cwd: options.cwd,
    flows: options.flows,
    flowName: options.flowName,
    intent: options.intent,
    aim: options.aim,
    ...(options.acceptance !== undefined ? { acceptance: options.acceptance } : {}),
    ...(options.taskCwd !== undefined ? { taskCwd: options.taskCwd } : {}),
    forkSessionSnapshotJsonl: options.forkSessionSnapshotJsonl,
    parentDepth: options.parentDepth,
    parentFlowStack: [...options.parentFlowStack],
    maxDepth: options.maxDepth,
    preventCycles: options.preventCycles,
    ...(options.toolOptimize !== undefined ? { toolOptimize: options.toolOptimize } : {}),
    ...(options.structuredOutput !== undefined ? { structuredOutput: options.structuredOutput } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.sessionMode !== undefined ? { sessionMode: options.sessionMode } : {}),
    projectFlowsDir,
  };
  assertJsonSerializable(payload);
  return payload;
}

export function deserializeHatchetFlowPayload(payload: HatchetFlowPayload): RunFlowOptions {
  assertJsonSerializable(payload);
  return {
    cwd: payload.cwd,
    flows: payload.flows,
    flowName: payload.flowName,
    intent: payload.intent,
    aim: payload.aim,
    acceptance: payload.acceptance,
    taskCwd: payload.taskCwd,
    forkSessionSnapshotJsonl: payload.forkSessionSnapshotJsonl,
    parentDepth: payload.parentDepth,
    parentFlowStack: payload.parentFlowStack,
    maxDepth: payload.maxDepth,
    preventCycles: payload.preventCycles,
    toolOptimize: payload.toolOptimize,
    structuredOutput: payload.structuredOutput,
    model: payload.model,
    sessionMode: payload.sessionMode,
    makeDetails: makeFlowDetails(payload.projectFlowsDir),
  };
}

async function loadHatchetSdk(): Promise<HatchetSdkModule> {
  try {
    return await import("@hatchet-dev/typescript-sdk");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PI_FLOW_RUNNER=hatchet requires optional package @hatchet-dev/typescript-sdk. Install and configure Hatchet before using this backend. (${message})`,
    );
  }
}

function getProperty(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

function asAsyncFunction(value: unknown): ((...args: unknown[]) => Promise<unknown>) | undefined {
  return typeof value === "function" ? (value as (...args: unknown[]) => Promise<unknown>) : undefined;
}

async function createHatchetClient(factory: (...args: unknown[]) => Promise<unknown>): Promise<unknown> {
  try {
    return new (factory as unknown as { new (): unknown })();
  } catch {
    return await factory();
  }
}

async function defaultSubmitHatchetTask(taskName: string, payload: HatchetFlowPayload): Promise<SingleResult> {
  const sdk = await loadHatchetSdk();
  const clientFactory =
    asAsyncFunction(getProperty(sdk, "HatchetClient")) ??
    asAsyncFunction(getProperty(sdk, "Hatchet")) ??
    asAsyncFunction(getProperty(sdk, "default"));
  const client = clientFactory ? await createHatchetClient(clientFactory) : getProperty(sdk, "hatchet") ?? sdk;

  const directRun = asAsyncFunction(getProperty(client, "run"));
  if (directRun) return (await directRun(taskName, payload)) as SingleResult;

  const workflows = getProperty(client, "workflows") ?? getProperty(client, "workflow");
  const workflowRun = asAsyncFunction(getProperty(workflows, "run"));
  if (workflowRun) return (await workflowRun(taskName, payload)) as SingleResult;

  const tasks = getProperty(client, "tasks") ?? getProperty(client, "task");
  const taskRun = asAsyncFunction(getProperty(tasks, "run")) ?? asAsyncFunction(getProperty(tasks, "execute"));
  if (taskRun) return (await taskRun(taskName, payload)) as SingleResult;

  throw new Error(
    "Hatchet SDK loaded, but no supported task submission method was found. Expected client.run, client.workflows.run, or client.tasks.run.",
  );
}

export class HatchetFlowRunner implements FlowRunner {
  constructor(private readonly submitTask: HatchetSubmitter = defaultSubmitHatchetTask) {}

  async run(options: RunFlowOptions, context?: FlowRunContext): Promise<SingleResult> {
    const payload = serializeHatchetFlowPayload(options, context?.projectFlowsDir ?? null);
    return this.submitTask(HATCHET_FLOW_TASK_NAME, payload);
  }
}

export async function runHatchetFlowTask(payload: HatchetFlowPayload): Promise<SingleResult> {
  process.env.PI_FLOW_SPAWN_COMMAND = process.env.PI_FLOW_SPAWN_COMMAND?.trim() || "pi";
  return runFlow(deserializeHatchetFlowPayload(payload));
}
