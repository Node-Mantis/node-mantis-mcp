import type { Effort, JsonValue } from "node-mantis";
import type { McpClient } from "./mcp-client";
import {
  type FlagSpec,
  booleanFlag,
  formatFlagHelp,
  numberFlag,
  parseArgs,
  UsageError,
} from "./args";
const EXIT_OK = 0;
const stderrLine = (line: string) => { process.stderr.write(`${line}\n`); };
const stdoutLine = (line: string) => { process.stdout.write(`${line}\n`); };
import {
  type TaskSessionFactory,
  type TaskSnapshot,
  TaskLimitError,
  TaskManager,
} from "./mcp-jobs";
import {
  type McpToolCallContext,
  type McpToolDefinition,
  type McpToolResult,
  McpServer,
} from "./mcp-protocol";

/**
 * `nodemantis mcp`: a Model Context Protocol server on stdin/stdout, so an
 * assistant can hand website tasks to NodeMantis. Four task-level tools; the
 * task itself runs in the background (see mcp-jobs) so each tool call can return within a bounded time.
 */

export const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 600;
const DEFAULT_MAX_TASKS = 4;
/** Maximum wait for sessions to close before ending the MCP process. */
const SHUTDOWN_WAIT_MS = 3_000;
/** Last resort if something keeps the process alive after shutdown. */
const EXIT_GRACE_MS = 2_000;

const MCP_FLAGS: FlagSpec[] = [
  { name: "wait-seconds", type: "number", valueName: "<n>", description: `how long a tool call waits for a task before returning its id (default ${DEFAULT_WAIT_SECONDS})` },
  { name: "max-tasks", type: "number", valueName: "<n>", description: `how many tasks may run at once (default ${DEFAULT_MAX_TASKS})` },
  { name: "headed", short: "H", type: "boolean", description: "show the browser window by default (a tool call can still choose)" },
];

export function mcpHelp(): string {
  return [
    "Usage: nodemantis mcp [options]",
    "",
    "Run a Model Context Protocol server on stdin/stdout so an assistant can",
    "give NodeMantis website tasks. Assistants start this command themselves;",
    "add it to their MCP settings as:",
    "",
    "  command: npx",
    "  args:    -y node-mantis mcp",
    "  env:     NODEMANTIS_API_KEY=sk_live_...   (not needed after nodemantis configure)",
    "",
    "Tools: run_task, retrieve_data, get_task, cancel_task",
    "",
    "Options:",
    formatFlagHelp(MCP_FLAGS),
    "",
    "Environment: NODEMANTIS_API_KEY, NODEMANTIS_SECRET_<NAME> (values for the secrets",
    "a task may type), NODEMANTIS_PROXY / NODEMANTIS_PROXY_LIST / NODEMANTIS_PROXY_FILE",
    "(used when a task sets use_proxy), NODEMANTIS_TIER, CHROME_PATH",
  ].join("\n");
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const satisfies readonly Effort[];

const SERVER_INSTRUCTIONS = [
  "Node Mantis carries out tasks on websites in a real browser and returns the result as structured data.",
  "Use run_task for anything that needs clicking, typing or moving between pages, and retrieve_data to read data from one page.",
  "Both answer directly when the work finishes quickly. Otherwise they return status \"running\" with a task_id:",
  "call get_task with that id until the status is succeeded, failed or cancelled.",
  "Pass result_schema (a JSON Schema) to get the data in a fixed shape.",
  "Never put a password or other private value in a goal. Ask the user to set NODEMANTIS_SECRET_<NAME> in this server's",
  "environment, pass the name in secrets, and refer to it in the goal as <secret:NAME>.",
].join(" ");

const RESULT_SCHEMA_PROPERTY = {
  type: "object",
  description: "JSON Schema describing the shape of the data to return, for example "
    + "{\"type\":\"object\",\"properties\":{\"price\":{\"type\":\"number\"}},\"required\":[\"price\"]}. "
    + "Omit it for a free-form answer.",
};
const EFFORT_PROPERTY = {
  type: "string",
  enum: [...EFFORT_LEVELS],
  description: "How much capability to spend. Default medium; raise it for hard pages, lower it for simple ones.",
};
const USE_PROXY_PROPERTY = {
  type: "boolean",
  description: "Route the browser through the proxy configured in this server's environment. Default false.",
};
const SHOW_BROWSER_PROPERTY = {
  type: "boolean",
  description: "Show the browser window while the task runs. Default false unless the server was started with --headed.",
};

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "run_task",
    title: "Run a website task",
    description:
      "Carry out a task on a website from a plain-English goal: navigate, click, type, fill in forms and read the outcome, "
      + "in a real browser. Returns the outcome and, when result_schema is given, the data in that shape. "
      + "If the task is still going when the call returns, the reply has status \"running\" and a task_id: "
      + "call get_task with it. Each call starts a fresh browser session with no saved logins.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "What to accomplish, with every detail needed to finish it, e.g. \"Find the cheapest direct flight "
            + "from Boston to Denver on March 3 and return the airline, times and price\".",
        },
        start_url: { type: "string", description: "Page to open first (http or https). Omit to let the task find its own way." },
        result_schema: RESULT_SCHEMA_PROPERTY,
        effort: EFFORT_PROPERTY,
        max_cost_usd: { type: "number", exclusiveMinimum: 0, description: "Stop once the task has spent this many US dollars." },
        max_steps: { type: "integer", minimum: 1, maximum: 200, description: "Stop after this many steps. Default 30." },
        timeout_seconds: { type: "integer", minimum: 10, maximum: 3600, description: "Stop after this long. Default 300." },
        secrets: {
          type: "array",
          items: { type: "string" },
          description: "Names of private values the task may type (passwords, one-time codes). Each value is read from "
            + "NODEMANTIS_SECRET_<NAME> in this server's environment; refer to one in the goal as <secret:NAME>.",
        },
        use_proxy: USE_PROXY_PROPERTY,
        show_browser: SHOW_BROWSER_PROPERTY,
      },
      required: ["goal"],
      additionalProperties: false,
    },
    annotations: {
      title: "Run a website task",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "retrieve_data",
    title: "Read data from a page",
    description:
      "Open one page and read data from it without changing anything on it. Returns the data, shaped by result_schema "
      + "when given. Use run_task instead when getting to the data takes clicking, typing or several pages. "
      + "If reading is still going when the call returns, the reply has status \"running\" and a task_id: call get_task with it.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page to read (http or https)." },
        prompt: { type: "string", description: "What to read from the page, e.g. \"every listing with its title, price and link\"." },
        result_schema: RESULT_SCHEMA_PROPERTY,
        effort: EFFORT_PROPERTY,
        use_proxy: USE_PROXY_PROPERTY,
        show_browser: SHOW_BROWSER_PROPERTY,
      },
      required: ["url", "prompt"],
      additionalProperties: false,
    },
    annotations: {
      title: "Read data from a page",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "get_task",
    title: "Check a task",
    description:
      "Wait for a task started by run_task or retrieve_data and return its status, latest progress and, once finished, "
      + "its result. Returns as soon as the task finishes, or after wait_seconds with status \"running\" (call again). "
      + "Tasks are kept for an hour after they finish and are lost when this server restarts.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task_id returned by run_task or retrieve_data." },
        wait_seconds: {
          type: "integer",
          minimum: 0,
          maximum: MAX_WAIT_SECONDS,
          description: "How long to wait for the task to finish before answering. 0 answers immediately.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Check a task",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "cancel_task",
    title: "Cancel a task",
    description: "Stop a running task and close its browser. A task that already finished is left unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task_id returned by run_task or retrieve_data." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Cancel a task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

// ── argument validation ─────────────────────────────────────────────────────

/** A problem with what the model passed; returned as a tool error it can fix. */
class ToolInputError extends Error {}

function assertKnownArguments(tool: McpToolDefinition, args: Record<string, unknown>): void {
  const allowed = Object.keys(tool.inputSchema.properties as Record<string, unknown>);
  const unknown = Object.keys(args).filter(name => !allowed.includes(name));
  if (unknown.length > 0) {
    throw new ToolInputError(`Unknown parameter ${unknown.map(name => `"${name}"`).join(", ")} for ${tool.name}. Allowed: ${allowed.join(", ")}.`);
  }
}

function requiredText(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`"${name}" is required and must be a non-empty string.`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError(`"${name}" must be true or false.`);
  return value;
}

function optionalNumber(
  args: Record<string, unknown>,
  name: string,
  rule: { integer?: boolean; min?: number; max?: number; exclusiveMin?: number },
): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  const valid = typeof value === "number" && Number.isFinite(value)
    && (!rule.integer || Number.isInteger(value))
    && (rule.min === undefined || value >= rule.min)
    && (rule.max === undefined || value <= rule.max)
    && (rule.exclusiveMin === undefined || value > rule.exclusiveMin);
  if (!valid) {
    const range = [
      rule.exclusiveMin !== undefined ? `greater than ${rule.exclusiveMin}` : undefined,
      rule.min !== undefined ? `at least ${rule.min}` : undefined,
      rule.max !== undefined ? `at most ${rule.max}` : undefined,
    ].filter(Boolean).join(" and ");
    throw new ToolInputError(`"${name}" must be ${rule.integer ? "a whole number" : "a number"}${range ? ` ${range}` : ""}.`);
  }
  return value as number;
}

function optionalEffort(args: Record<string, unknown>): Effort | undefined {
  const value = args.effort;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(value)) {
    throw new ToolInputError(`"effort" must be one of ${EFFORT_LEVELS.join(", ")}.`);
  }
  return value as Effort;
}

function optionalSchema(args: Record<string, unknown>): JsonValue | undefined {
  const value = args.result_schema;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError("\"result_schema\" must be a JSON Schema object.");
  }
  return value as JsonValue;
}

/** Pages are opened by address only: web pages, plus inline data: documents. */
function pageUrl(args: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new ToolInputError(`"${name}" is required.`);
    return undefined;
  }
  let protocol: string | undefined;
  if (typeof value === "string") {
    try {
      protocol = new URL(value).protocol;
    } catch {
      // Reported below.
    }
  }
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "data:") {
    throw new ToolInputError(`"${name}" must be a full http or https address, e.g. https://example.com/page.`);
  }
  return value as string;
}

function secretsFromNames(args: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const value = args.secrets;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(name => typeof name !== "string")) {
    throw new ToolInputError("\"secrets\" must be a list of secret names.");
  }
  if (value.length === 0) return undefined;
  try {
    return loadSecretsOption(value.join(","), env);
  } catch (error) {
    if (error instanceof UsageError) {
      throw new ToolInputError(`${error.message}. The user sets it in this MCP server's environment; values are never passed in a tool call.`);
    }
    throw error;
  }
}

const SECRET_NAME = /^[A-Za-z0-9_]{1,64}$/;

/** Environment variable holding the value of the secret called `name`. */
export function secretEnvName(name: string): string {
  return `NODEMANTIS_SECRET_${name.toUpperCase()}`;
}

/**
 * Resolve `--secrets a,b` against the environment. Values come only from
 * environment variables, so they never appear in argv or shell history.
 */
export function loadSecretsOption(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const secrets: Record<string, string> = {};
  for (const name of value.split(",").map(part => part.trim()).filter(part => part.length > 0)) {
    if (!SECRET_NAME.test(name)) {
      throw new UsageError(`Secret name "${name}" is invalid: use letters, digits and underscores`);
    }
    const secret = env[secretEnvName(name)];
    if (secret === undefined || secret.length === 0) {
      throw new UsageError(`Secret "${name}" has no value: set the ${secretEnvName(name)} environment variable`);
    }
    secrets[name] = secret;
  }
  if (Object.keys(secrets).length === 0) throw new UsageError("Option --secrets requires at least one name");
  return secrets;
}

// ── the server ──────────────────────────────────────────────────────────────

export interface NodeMantisMcpOptions {
  client: McpClient;
  write: (line: string) => void;
  log?: (line: string) => void;
  waitSeconds?: number;
  maxTasks?: number;
  /** Show the browser unless a tool call says otherwise. */
  headed?: boolean;
  env?: NodeJS.ProcessEnv;
  startSession?: TaskSessionFactory;
  version?: string;
}

export interface NodeMantisMcp {
  server: McpServer;
  tasks: TaskManager;
}

function renderSnapshot(snapshot: TaskSnapshot): McpToolResult {
  const payload = snapshot.status === "running"
    ? {
      ...snapshot,
      next_step: `Still running. Call get_task with task_id "${snapshot.task_id}" to wait for the result, or cancel_task to stop it.`,
    }
    : snapshot;
  return {
    text: JSON.stringify(payload, null, 2),
    structuredContent: payload,
    isError: snapshot.status === "failed",
  };
}

function unknownTask(id: string): McpToolResult {
  return {
    text: `No task with id "${id}". Tasks are kept for an hour after they finish and are lost when this server restarts; start a new one.`,
    isError: true,
  };
}

export function createNodeMantisMcp(options: NodeMantisMcpOptions): NodeMantisMcp {
  const env = options.env ?? process.env;
  const waitMs = Math.round((options.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000);
  const tasks = new TaskManager({
    startSession: options.startSession ?? (startOptions => options.client.startSession(startOptions)),
    maxRunning: options.maxTasks ?? DEFAULT_MAX_TASKS,
  });
  const tool = (name: string) => MCP_TOOLS.find(candidate => candidate.name === name)!;

  const sessionSettings = (args: Record<string, unknown>) => {
    // Resolved per call, so a key added with `nodemantis configure` works without a restart.
    const apiKey = options.client.resolveApiKey(env);
    if (!apiKey) {
      options.client.reportMissingApiKey();
      throw new ToolInputError(
        "No Node Mantis API key is configured, so the task was not started. Ask the user to add NODEMANTIS_API_KEY "
        + "to this MCP server's environment settings, or to run: nodemantis configure --api-key \"sk_live_...\". "
        + "Keys are created in the Node Mantis dashboard at https://nodemantis.com.",
      );
    }
    let serviceTier;
    try {
      serviceTier = env.NODEMANTIS_TIER || "flex";
      if (serviceTier !== "flex" && serviceTier !== "standard") {
        throw new UsageError(`NODEMANTIS_TIER expects flex or standard, got "${serviceTier}".`);
      }
    } catch (error) {
      throw new ToolInputError(error instanceof Error ? error.message : String(error));
    }
    return {
      apiKey,
      serviceTier: serviceTier as "flex" | "standard",
      effort: optionalEffort(args),
      useProxy: optionalBoolean(args, "use_proxy") === true,
      headless: !(optionalBoolean(args, "show_browser") ?? options.headed === true),
    };
  };

  /** Start the task, then wait on it like get_task would. */
  const startAndWait = async (
    start: () => TaskSnapshot,
    context: McpToolCallContext,
  ): Promise<McpToolResult> => {
    const started = start();
    const snapshot = await tasks.wait(started.task_id, waitMs, context.signal, context.progress);
    // The client gave up on the call that started the task and never saw its
    // id, so nothing could collect the result: stop the task too.
    if (context.signal.aborted) {
      tasks.cancel(started.task_id);
      return renderSnapshot(tasks.snapshot(started.task_id) ?? started);
    }
    return renderSnapshot(snapshot ?? started);
  };

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    context: McpToolCallContext,
  ): Promise<McpToolResult> => {
    try {
      assertKnownArguments(tool(name), args);
      switch (name) {
        case "run_task": {
          const goal = requiredText(args, "goal");
          const startUrl = pageUrl(args, "start_url", false);
          const resultSchema = optionalSchema(args);
          const maxCostUsd = optionalNumber(args, "max_cost_usd", { exclusiveMin: 0 });
          const maxSteps = optionalNumber(args, "max_steps", { integer: true, min: 1, max: 200 });
          const timeoutSeconds = optionalNumber(args, "timeout_seconds", { integer: true, min: 10, max: 3600 });
          const secrets = secretsFromNames(args, env);
          const settings = sessionSettings(args);
          return await startAndWait(() => tasks.start({
            kind: "run_task",
            ...settings,
            goal,
            startUrl,
            resultSchema,
            maxCostUsd,
            maxSteps,
            timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
            secrets,
          }), context);
        }
        case "retrieve_data": {
          const url = pageUrl(args, "url", true)!;
          const prompt = requiredText(args, "prompt");
          const schema = optionalSchema(args);
          const settings = sessionSettings(args);
          return await startAndWait(() => tasks.start({ kind: "retrieve_data", ...settings, url, prompt, schema }), context);
        }
        case "get_task": {
          const id = requiredText(args, "task_id");
          const waitSeconds = optionalNumber(args, "wait_seconds", { integer: true, min: 0, max: MAX_WAIT_SECONDS });
          const snapshot = await tasks.wait(
            id,
            waitSeconds === undefined ? waitMs : waitSeconds * 1000,
            context.signal,
            context.progress,
          );
          return snapshot ? renderSnapshot(snapshot) : unknownTask(id);
        }
        case "cancel_task": {
          const id = requiredText(args, "task_id");
          const snapshot = tasks.cancel(id);
          return snapshot ? renderSnapshot(snapshot) : unknownTask(id);
        }
        default:
          throw new ToolInputError(`Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof ToolInputError || error instanceof TaskLimitError) {
        return { text: error.message, isError: true };
      }
      throw error;
    }
  };

  const server = new McpServer({
    name: "node-mantis",
    title: "Node Mantis",
    version: options.version ?? options.client.version(),
    instructions: SERVER_INSTRUCTIONS,
    tools: MCP_TOOLS,
    callTool,
    write: options.write,
    log: options.log,
  });
  return { server, tasks };
}

// ── the command ─────────────────────────────────────────────────────────────

/**
 * stdout carries protocol messages only. Anything else in this process that
 * writes to stdout is sent to stderr instead, so a stray line can never
 * corrupt the stream. Returns the writer for protocol lines.
 */
function claimStdout(): (line: string) => void {
  const stdout = process.stdout;
  const protocolWrite = stdout.write.bind(stdout) as (chunk: string) => boolean;
  stdout.write = ((...args: Parameters<typeof process.stderr.write>) => process.stderr.write(...args)) as typeof stdout.write;
  return line => {
    protocolWrite(`${line}\n`);
  };
}

export async function mcpCommand(argv: string[], client: McpClient): Promise<number> {
  const { flags, positionals, helpRequested } = parseArgs(argv, MCP_FLAGS);
  if (helpRequested) {
    stdoutLine(mcpHelp());
    return EXIT_OK;
  }
  if (positionals.length > 0) throw new UsageError(`mcp takes no arguments, got "${positionals[0]}"`);
  const waitSeconds = numberFlag(flags, "wait-seconds");
  if (waitSeconds !== undefined && (waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS)) {
    throw new UsageError(`--wait-seconds expects 0 to ${MAX_WAIT_SECONDS}, got ${waitSeconds}`);
  }
  const maxTasks = numberFlag(flags, "max-tasks");
  if (maxTasks !== undefined && (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 32)) {
    throw new UsageError(`--max-tasks expects a whole number from 1 to 32, got ${maxTasks}`);
  }

  if (process.stdin.isTTY) {
    stderrLine("NodeMantis MCP server: waiting for an MCP client on stdin. Assistants start this command themselves; "
      + "see nodemantis mcp --help. Press Ctrl+C to stop.");
  }

  const write = claimStdout();
  return (async () => {
    const { server, tasks } = createNodeMantisMcp({
      write,
      log: stderrLine,
      waitSeconds,
      maxTasks,
      headed: booleanFlag(flags, "headed"),
      client,
    });

    // The client closing stdin is the normal way to stop; signals and a
    // broken stdout end it the same way.
    await new Promise<void>(resolve => {
      process.stdin.on("data", chunk => server.push(chunk));
      process.stdin.once("end", resolve);
      process.stdin.once("close", resolve);
      process.stdin.once("error", () => resolve());
      process.stdout.once("error", () => resolve());
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => resolve());
    });

    server.abortAll();
    const closedInTime = await Promise.race([
      tasks.closeAll().then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), SHUTDOWN_WAIT_MS).unref()),
    ]);
    setTimeout(() => process.exit(EXIT_OK), closedInTime ? EXIT_GRACE_MS : 250).unref();
    return EXIT_OK;
  })();
}
