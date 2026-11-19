import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import type {
  AgentOperationResult,
  AgentRetrieveResult,
  NodeMantisRetrieveOptions,
  NodeMantisRunOptions,
  NodeMantisStartOptions,
} from "node-mantis";
import { MCP_TOOLS, createNodeMantisMcp } from "../src/mcp-server";
import type { TaskSession } from "../src/mcp-jobs";
import { LEGACY_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSIONS } from "../src/mcp-protocol";

/**
 * The MCP server in-process, against a fake browser session: protocol
 * handling for both eras, the four tools, and the wait-then-poll task flow.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeSession implements TaskSession {
  closed = false;
  runCalls: Array<{ goal: string; options: NodeMantisRunOptions }> = [];
  retrieveCalls: Array<{ prompt: string; options: NodeMantisRetrieveOptions }> = [];
  readonly runResult = deferred<AgentOperationResult>();
  readonly retrieveResult = deferred<AgentRetrieveResult>();

  constructor(readonly startOptions: NodeMantisStartOptions) {
    // close() rejects both; only the operation in use has a listener.
    this.runResult.promise.catch(() => undefined);
    this.retrieveResult.promise.catch(() => undefined);
  }

  run(goal: string, options: NodeMantisRunOptions = {}): Promise<AgentOperationResult> {
    this.runCalls.push({ goal, options });
    return this.runResult.promise;
  }

  retrieve(prompt: string, options: NodeMantisRetrieveOptions = {}): Promise<AgentRetrieveResult> {
    this.retrieveCalls.push({ prompt, options });
    return this.retrieveResult.promise;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Like the real session: closing interrupts whatever is in flight.
    this.runResult.reject(new Error("session closed"));
    this.retrieveResult.reject(new Error("session closed"));
  }
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSIONS[0],
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface ToolReply {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

function harness(options: { waitSeconds?: number; maxTasks?: number; env?: Record<string, string>; headed?: boolean } = {}) {
  const messages: Array<Record<string, unknown>> = [];
  const sessions: FakeSession[] = [];
  let nextId = 0;
  const mcp = createNodeMantisMcp({
    client: {
      startSession: async () => { throw new Error("The test must supply a session factory"); },
      resolveApiKey: env => env.NODEMANTIS_API_KEY,
      reportMissingApiKey: () => {},
      version: () => "9.9.9",
    },
    write: line => {
      expect(line).not.toContain("\n");
      messages.push(JSON.parse(line) as Record<string, unknown>);
    },
    waitSeconds: options.waitSeconds ?? 30,
    maxTasks: options.maxTasks,
    headed: options.headed,
    version: "9.9.9",
    env: { NODEMANTIS_API_KEY: "ak_test_key", NODEMANTIS_CONFIG_FILE: "/nonexistent/nodemantis.json", ...options.env },
    startSession: async startOptions => {
      const session = new FakeSession(startOptions);
      sessions.push(session);
      return session;
    },
  });

  const send = (message: Record<string, unknown>) => mcp.server.push(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = async (id: number): Promise<Record<string, unknown>> => {
    await expect.poll(() => messages.some(message => message.id === id), { timeout: 5_000 }).toBe(true);
    return messages.find(message => message.id === id)!;
  };
  const request = async (method: string, params?: Record<string, unknown>) => {
    const id = ++nextId;
    send({ id, method, ...(params ? { params } : {}) });
    return reply(id);
  };
  const startCall = (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): number => {
    const id = ++nextId;
    send({ id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });
    return id;
  };
  const toolReply = async (id: number) => (await reply(id)).result as ToolReply;
  const call = async (name: string, args: Record<string, unknown>) => toolReply(startCall(name, args));
  const session = async (index = 0): Promise<FakeSession> => {
    await expect.poll(() => sessions.length > index, { timeout: 5_000 }).toBe(true);
    return sessions[index];
  };
  const progress = () => messages.filter(message => message.method === "notifications/progress")
    .map(message => message.params as { progressToken: string; progress: number; message: string });

  return { mcp, messages, sessions, send, request, startCall, toolReply, call, session, progress };
}

const RUN_OK: AgentOperationResult = {
  ok: true,
  reason: "Found the price",
  costUsd: 0.012,
  iterations: 4,
  traceId: "op_1",
  value: { price: 19.5 },
};

test("a legacy client negotiates a version with the initialize handshake", async () => {
  const { request, send, messages } = harness();
  const known = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  expect(known.result).toMatchObject({
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "node-mantis", title: "Node Mantis", version: "9.9.9" },
  });
  expect((known.result as { instructions: string }).instructions).toContain("get_task");
  expect(known.result).not.toHaveProperty("resultType");

  const unknown = await request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
  expect((unknown.result as { protocolVersion: string }).protocolVersion).toBe(LEGACY_PROTOCOL_VERSIONS[0]);

  const before = messages.length;
  send({ method: "notifications/initialized" });
  expect((await request("ping")).result).toEqual({});
  // The notification itself is never answered.
  expect(messages.length).toBe(before + 1);
});

test("a modern client needs no handshake: discovery, per-request version, and version errors", async () => {
  const { request } = harness();
  const discover = await request("server/discover", { _meta: MODERN_META });
  expect(discover.result).toMatchObject({
    resultType: "complete",
    supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
    capabilities: { tools: {} },
    // Discovery and list results must carry caching hints in this era.
    ttlMs: 300_000,
    cacheScope: "public",
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "node-mantis", version: "9.9.9" } },
  });

  const list = await request("tools/list", { _meta: MODERN_META });
  expect(list.result).toMatchObject({ resultType: "complete", ttlMs: 300_000, cacheScope: "public" });
  // The handshake era has no such fields.
  expect((await request("tools/list")).result).not.toHaveProperty("ttlMs");
  expect((list.result as { tools: unknown[] }).tools).toHaveLength(4);

  const unsupported = await request("tools/list", {
    _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
  });
  expect(unsupported.error).toEqual({
    code: -32022,
    message: "Unsupported protocol version",
    data: { supported: [...MODERN_PROTOCOL_VERSIONS], requested: "2099-01-01" },
  });

  const noCapabilities = await request("tools/list", {
    _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSIONS[0] },
  });
  expect((noCapabilities.error as { code: number }).code).toBe(-32602);

  // A probe without the modern version key gets a plain error, so a dual-era
  // client falls back to initialize.
  const legacyProbe = await request("server/discover");
  expect((legacyProbe.error as { code: number }).code).toBe(-32602);
});

test("tools/list describes the four tools with schemas and annotations", async () => {
  const { request } = harness();
  const tools = ((await request("tools/list")).result as { tools: typeof MCP_TOOLS }).tools;
  expect(tools.map(tool => tool.name)).toEqual(["run_task", "retrieve_data", "get_task", "cancel_task"]);
  for (const tool of tools) {
    expect(tool.title.length).toBeGreaterThan(0);
    expect(tool.description.length).toBeGreaterThan(40);
    expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(tool.annotations?.title).toBe(tool.title);
    expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
  }
  expect(tools[0].inputSchema.required).toEqual(["goal"]);
  expect(tools[1].annotations?.readOnlyHint).toBe(true);
});

test("malformed input and unknown methods get JSON-RPC errors", async () => {
  const { mcp, messages, request } = harness();
  mcp.server.push("this is not json\n");
  expect(messages.at(-1)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  mcp.server.push("[1,2]\n\r\n");
  expect((messages.at(-1)!.error as { code: number }).code).toBe(-32600);

  expect(((await request("resources/list")).error as { code: number }).code).toBe(-32601);
  const unknownTool = await request("tools/call", { name: "nope", arguments: {} });
  expect(unknownTool.error).toMatchObject({ code: -32602, message: "Unknown tool: nope" });
});

test("a message split across chunks is read as one line", async () => {
  const { mcp, messages } = harness();
  const line = `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`;
  mcp.server.push(Buffer.from(line.slice(0, 9)));
  expect(messages).toHaveLength(0);
  mcp.server.push(Buffer.from(line.slice(9)));
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
});

test("run_task that finishes within the wait returns the result directly", async () => {
  const { startCall, toolReply, session } = harness();
  const id = startCall("run_task", {
    goal: "Find the price",
    start_url: "https://shop.example/item",
    result_schema: { type: "object", properties: { price: { type: "number" } } },
    effort: "high",
    max_cost_usd: 0.5,
    max_steps: 12,
    timeout_seconds: 90,
    use_proxy: true,
  });
  const fake = await session();
  expect(fake.startOptions).toMatchObject({
    startUrl: "https://shop.example/item",
    headless: true,
    useProxy: true,
    apiKey: "ak_test_key",
  });
  await expect.poll(() => fake.runCalls.length).toBe(1);
  expect(fake.runCalls[0].goal).toBe("Find the price");
  expect(fake.runCalls[0].options).toMatchObject({
    effort: "high",
    serviceTier: "flex",
    maxIterations: 12,
    timeout: 90_000,
    maxCost: 0.5,
    resultSchema: { type: "object", properties: { price: { type: "number" } } },
  });
  fake.runResult.resolve(RUN_OK);

  const reply = await toolReply(id);
  expect(reply.isError).toBe(false);
  expect(reply.structuredContent).toMatchObject({
    tool: "run_task",
    status: "succeeded",
    result: { ok: true, reason: "Found the price", value: { price: 19.5 }, steps: 4, cost_usd: 0.012, trace_id: "op_1" },
  });
  expect(reply.structuredContent).not.toHaveProperty("next_step");
  expect(JSON.parse(reply.content[0].text)).toEqual(reply.structuredContent);
  await expect.poll(() => fake.closed).toBe(true);
});

test("a task that outlasts the wait returns an id; get_task relays progress and the result", async () => {
  const { startCall, toolReply, session, progress } = harness({ waitSeconds: 0.05 });
  const started = await toolReply(startCall("run_task", { goal: "Long task" }, { progressToken: "tok-1" }));
  expect(started.isError).toBe(false);
  expect(started.structuredContent).toMatchObject({ tool: "run_task", status: "running" });
  const taskId = started.structuredContent!.task_id as string;
  expect(taskId).toMatch(/^task_[0-9a-f-]{36}$/);
  expect(String(started.structuredContent!.next_step)).toContain(taskId);

  const fake = await session();
  await expect.poll(() => fake.runCalls.length).toBe(1);
  const pollId = startCall("get_task", { task_id: taskId, wait_seconds: 30 }, { progressToken: "tok-2" });
  await new Promise(resolve => setTimeout(resolve, 20));
  fake.runCalls[0].options.onProgress?.({ iteration: 1, maxIterations: 30, message: "Looking at the page", action: "click(\"Next\")" });
  fake.runCalls[0].options.onProgress?.({ iteration: 2, maxIterations: 30, message: "Reading results" });
  fake.runResult.resolve({ ...RUN_OK, ok: false, reason: "Ran out of steps" });

  const finished = await toolReply(pollId);
  // A task that did not reach its goal is an error the model can act on,
  // and it still carries what was found.
  expect(finished.isError).toBe(true);
  expect(finished.structuredContent).toMatchObject({
    task_id: taskId,
    status: "failed",
    result: { ok: false, reason: "Ran out of steps", value: { price: 19.5 } },
  });

  const notes = progress().filter(note => note.progressToken === "tok-2");
  expect(notes.map(note => note.message)).toEqual([
    "Step 1/30: Looking at the page — click(\"Next\")",
    "Step 2/30: Reading results",
  ]);
  expect(notes.map(note => note.progress)).toEqual([1, 2]);
  // The first call's progress token is never used after that call returned.
  expect(progress().filter(note => note.progressToken === "tok-1").every(note => !note.message.startsWith("Step"))).toBe(true);

  const again = await toolReply(startCall("get_task", { task_id: taskId }));
  expect(again.structuredContent).toMatchObject({ status: "failed" });
});

test("retrieve_data opens the page and returns the data", async () => {
  const { startCall, toolReply, session } = harness({ headed: true });
  const id = startCall("retrieve_data", {
    url: "https://example.com/list",
    prompt: "all titles",
    result_schema: { type: "array", items: { type: "string" } },
    effort: "low",
  });
  const fake = await session();
  expect(fake.startOptions).toMatchObject({ startUrl: "https://example.com/list", headless: false });
  expect(fake.startOptions.useProxy).toBeUndefined();
  await expect.poll(() => fake.retrieveCalls.length).toBe(1);
  expect(fake.retrieveCalls[0]).toMatchObject({ prompt: "all titles", options: { effort: "low", serviceTier: "flex" } });
  fake.retrieveResult.resolve({
    status: "success",
    data: ["a", "b"],
    message: "Retrieved requested information.",
    costUsd: 0.002,
    tokens: { input: 1, output: 1, cached: 0 },
    finalUrl: "https://example.com/list",
    traceId: "op_2",
  });
  const reply = await toolReply(id);
  expect(reply.isError).toBe(false);
  expect(reply.structuredContent).toMatchObject({
    tool: "retrieve_data",
    status: "succeeded",
    result: { status: "success", data: ["a", "b"], final_url: "https://example.com/list", cost_usd: 0.002 },
  });
  // Token counts are internal accounting, not part of the tool result.
  expect(JSON.stringify(reply.structuredContent)).not.toContain("tokens");
});

test("data that is not on the page is a failed task marked retryable or not", async () => {
  const { startCall, toolReply, session } = harness();
  const id = startCall("retrieve_data", { url: "https://example.com", prompt: "the phone number" });
  const fake = await session();
  await expect.poll(() => fake.retrieveCalls.length).toBe(1);
  fake.retrieveResult.resolve({
    status: "unavailable",
    data: null,
    retryable: false,
    message: "The requested information was not available.",
    costUsd: 0.001,
    tokens: { input: 1, output: 1, cached: 0 },
    finalUrl: "https://example.com/",
  });
  const reply = await toolReply(id);
  expect(reply.isError).toBe(true);
  expect(reply.structuredContent).toMatchObject({ status: "failed", result: { status: "unavailable", retryable: false } });
});

test("an error thrown by the session becomes a failed task with its message, code and cost", async () => {
  const { startCall, toolReply, session } = harness();
  const id = startCall("run_task", { goal: "Do it" });
  const fake = await session();
  await expect.poll(() => fake.runCalls.length).toBe(1);
  fake.runResult.reject(Object.assign(new Error("Cost limit reached"), { code: "COST_LIMIT", costUsd: 0.5 }));
  const reply = await toolReply(id);
  expect(reply.isError).toBe(true);
  expect(reply.structuredContent).toMatchObject({
    status: "failed",
    error: { message: "Cost limit reached", code: "COST_LIMIT", cost_usd: 0.5 },
  });
  await expect.poll(() => fake.closed).toBe(true);
});

test("cancel_task stops a running task and closes its browser", async () => {
  const { call, session } = harness({ waitSeconds: 0.05 });
  const started = await call("run_task", { goal: "Long task" });
  const taskId = started.structuredContent!.task_id as string;
  const fake = await session();
  await expect.poll(() => fake.runCalls.length).toBe(1);

  const cancelled = await call("cancel_task", { task_id: taskId });
  expect(cancelled.isError).toBe(false);
  expect(cancelled.structuredContent).toMatchObject({ task_id: taskId, status: "cancelled" });
  await expect.poll(() => fake.closed).toBe(true);

  // Cancelling again, and a late result, change nothing.
  expect((await call("cancel_task", { task_id: taskId })).structuredContent).toMatchObject({ status: "cancelled" });
  expect((await call("get_task", { task_id: taskId })).structuredContent).toMatchObject({ status: "cancelled" });

  const missing = await call("get_task", { task_id: "task_missing" });
  expect(missing.isError).toBe(true);
  expect(missing.content[0].text).toContain("No task with id");
});

test("a client that cancels the call that started a task stops the task and gets no reply", async () => {
  const { startCall, send, session, messages, mcp } = harness();
  const id = startCall("run_task", { goal: "Abandoned" });
  const fake = await session();
  await expect.poll(() => fake.runCalls.length).toBe(1);
  send({ method: "notifications/cancelled", params: { requestId: id, reason: "timeout" } });
  await expect.poll(() => fake.closed).toBe(true);
  await mcp.server.idle();
  expect(messages.some(message => message.id === id)).toBe(false);
});

test("a client that stops waiting in get_task leaves the task running", async () => {
  const { startCall, call, send, session, messages, mcp } = harness({ waitSeconds: 0.05 });
  const taskId = (await call("run_task", { goal: "Long task" })).structuredContent!.task_id as string;
  const fake = await session();
  const pollId = startCall("get_task", { task_id: taskId, wait_seconds: 60 });
  await new Promise(resolve => setTimeout(resolve, 20));
  send({ method: "notifications/cancelled", params: { requestId: pollId } });
  await mcp.server.idle();
  expect(messages.some(message => message.id === pollId)).toBe(false);
  expect(fake.closed).toBe(false);
  expect((await call("get_task", { task_id: taskId, wait_seconds: 0 })).structuredContent).toMatchObject({ status: "running" });
  await mcp.tasks.closeAll();
  expect(fake.closed).toBe(true);
});

test("without an API key the tool explains what the user must set and starts nothing", async () => {
  const { call, sessions } = harness({ env: { NODEMANTIS_API_KEY: "" } });
  const reply = await call("run_task", { goal: "Anything" });
  expect(reply.isError).toBe(true);
  expect(reply.content[0].text).toContain("NODEMANTIS_API_KEY");
  expect(reply.content[0].text).toContain("nodemantis configure");
  expect(sessions).toHaveLength(0);
});

test("bad arguments are tool errors the model can correct", async () => {
  const { call, sessions } = harness();
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["run_task", {}, "\"goal\" is required"],
    ["run_task", { goal: "x", url: "https://a.example" }, "Unknown parameter \"url\" for run_task. Allowed: goal, start_url"],
    ["run_task", { goal: "x", start_url: "example.com" }, "full http or https address"],
    ["run_task", { goal: "x", start_url: "file:///etc/passwd" }, "full http or https address"],
    ["run_task", { goal: "x", effort: "maximum" }, "one of low, medium, high, xhigh"],
    ["run_task", { goal: "x", max_steps: 0 }, "\"max_steps\" must be a whole number at least 1"],
    ["run_task", { goal: "x", max_cost_usd: 0 }, "greater than 0"],
    ["run_task", { goal: "x", result_schema: "string" }, "JSON Schema object"],
    ["run_task", { goal: "x", secrets: ["LOGIN_PASSWORD"] }, "NODEMANTIS_SECRET_LOGIN_PASSWORD"],
    ["retrieve_data", { prompt: "x" }, "\"url\" is required"],
    ["get_task", {}, "\"task_id\" is required"],
    ["get_task", { task_id: "t", wait_seconds: 9999 }, "at most 600"],
  ];
  for (const [name, args, expected] of cases) {
    const reply = await call(name, args);
    expect(reply.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    expect(reply.content[0].text).toContain(expected);
  }
  expect(sessions).toHaveLength(0);
});

test("secret names resolve to values from the server environment, never from the call", async () => {
  const { startCall, session, mcp } = harness({ env: { NODEMANTIS_SECRET_LOGIN_PASSWORD: "hunter2" } });
  startCall("run_task", { goal: "Sign in with <secret:login_password>", secrets: ["login_password"] });
  const fake = await session();
  await expect.poll(() => fake.runCalls.length).toBe(1);
  expect(fake.runCalls[0].options.secrets).toEqual({ login_password: "hunter2" });
  await mcp.tasks.closeAll();
});

test("only so many tasks run at once", async () => {
  const { call, mcp } = harness({ waitSeconds: 0.02, maxTasks: 2 });
  const first = await call("run_task", { goal: "one" });
  await call("run_task", { goal: "two" });
  const third = await call("run_task", { goal: "three" });
  expect(third.isError).toBe(true);
  expect(third.content[0].text).toContain("2 tasks are already running (limit 2)");
  expect(third.content[0].text).toContain(first.structuredContent!.task_id as string);

  await call("cancel_task", { task_id: first.structuredContent!.task_id });
  expect((await call("run_task", { goal: "three" })).isError).toBe(false);
  await mcp.tasks.closeAll();
});

test("shutting down cancels every task and closes every browser", async () => {
  const { call, sessions, mcp } = harness({ waitSeconds: 0.02 });
  await call("run_task", { goal: "one" });
  await call("retrieve_data", { url: "https://example.com", prompt: "two" });
  await expect.poll(() => sessions.length).toBe(2);
  mcp.server.abortAll();
  await mcp.tasks.closeAll();
  expect(sessions.every(session => session.closed)).toBe(true);
});

test("tool definitions match the fixture the Python server is checked against", () => {
  // Both implementations carry the same definitions and are
  // pinned to this one file so an assistant sees the same tools from either.
  const fixture = JSON.parse(readFileSync(
    resolve(__dirname, "../../fixtures/mcp-tools.json"),
    "utf8",
  )) as { tools: unknown };
  expect(JSON.parse(JSON.stringify(MCP_TOOLS))).toEqual(fixture.tools);
});
