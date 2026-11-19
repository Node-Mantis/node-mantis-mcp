import { StringDecoder } from "node:string_decoder";

/**
 * Minimal Model Context Protocol server over a newline-delimited JSON-RPC
 * stream (the stdio transport). This module exposes tools and uses only
 * standard library modules.
 *
 * It serves both protocol eras on one stream:
 *  - legacy clients open with an `initialize` handshake (revisions up to
 *    2025-11-25);
 *  - clients using revision 2026-07-28 send no handshake and declare the
 *    protocol version in every request's `_meta`; they may probe with
 *    `server/discover` first.
 * A request that carries the modern version key is served under modern rules,
 * anything else under legacy rules.
 */

export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/**
 * Modern revisions require caching hints on discovery and list results. The
 * tool list is fixed for the life of the process and the same for everyone.
 */
const CACHE_HINTS = { ttlMs: 5 * 60_000, cacheScope: "public" } as const;

/** Longest accepted input line; a client never needs more for a tool call. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpToolResult {
  /** Model-readable text. */
  text: string;
  /** The same result as JSON, for clients that read structured output. */
  structuredContent?: unknown;
  /** True for a tool execution error the model can react to. */
  isError?: boolean;
}

export interface McpToolCallContext {
  /** Aborted when the client cancels this request. */
  signal: AbortSignal;
  /** Sends a progress note for this request, if the client asked for them. */
  progress: (message: string) => void;
}

export interface McpServerOptions {
  name: string;
  title: string;
  version: string;
  instructions: string;
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>, context: McpToolCallContext) => Promise<McpToolResult>;
  /** Writes one protocol line (without the trailing newline). */
  write: (line: string) => void;
  /** Diagnostics; never the protocol stream. */
  log?: (line: string) => void;
}

type JsonRpcId = string | number;

interface IncomingMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** A protocol-level failure answered as a JSON-RPC error. */
class ProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export class McpServer {
  private readonly inFlight = new Map<JsonRpcId, AbortController>();
  private readonly pending = new Set<Promise<void>>();
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";
  private overflow = false;

  constructor(private readonly options: McpServerOptions) {}

  /** Feed raw bytes from the client. */
  push(chunk: Buffer | string): void {
    this.buffered += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (this.overflow) {
        // The tail of an oversized line: already answered, drop it.
        this.overflow = false;
        continue;
      }
      this.handleLine(line);
    }
    if (!this.overflow && Buffer.byteLength(this.buffered) > MAX_LINE_BYTES) {
      this.buffered = "";
      this.overflow = true;
      this.sendError(null, INVALID_REQUEST, "Message too large");
    }
  }

  /** Abort every in-flight request (the client went away). */
  abortAll(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  /** Resolves once every request that already started has been answered. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.sendError(null, PARSE_ERROR, "Parse error");
      return;
    }
    if (!isRecord(message)) {
      // JSON-RPC batches were removed from the protocol; nothing else is valid here.
      this.sendError(null, INVALID_REQUEST, "Expected one JSON-RPC message object per line");
      return;
    }
    const incoming = message as IncomingMessage;
    if (typeof incoming.method !== "string") {
      // A response (we never send requests) or garbage. Only garbage with an id gets an answer.
      if (isRequestId(incoming.id) && !("result" in message) && !("error" in message)) {
        this.sendError(incoming.id, INVALID_REQUEST, "Missing method");
      }
      return;
    }
    if (incoming.id === undefined || incoming.id === null) {
      this.handleNotification(incoming.method, incoming.params);
      return;
    }
    if (!isRequestId(incoming.id)) {
      this.sendError(null, INVALID_REQUEST, "Request id must be a string or number");
      return;
    }
    const id = incoming.id;
    const task = this.handleRequest(id, incoming.method, incoming.params).catch(error => {
      this.options.log?.(`mcp: unexpected failure answering ${String(incoming.method)}: ${String(error)}`);
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "notifications/cancelled" && isRecord(params) && isRequestId(params.requestId)) {
      const controller = this.inFlight.get(params.requestId);
      if (controller) {
        this.inFlight.delete(params.requestId);
        controller.abort();
      }
    }
    // notifications/initialized and anything unknown: nothing to do.
  }

  private async handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    try {
      const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined;
      const modern = meta !== undefined && META_PROTOCOL_VERSION in meta;
      if (modern) this.assertModernMeta(meta);
      const result = await this.dispatch(method, isRecord(params) ? params : {}, meta, modern, controller.signal);
      // A cancelled request gets no response.
      if (controller.signal.aborted) return;
      this.send({
        jsonrpc: "2.0",
        id,
        result: modern
          ? { resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: this.serverInfo() } }
          : result,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ProtocolError) {
        this.sendError(id, error.code, error.message, error.data);
      } else {
        this.options.log?.(`mcp: ${method} failed: ${String(error)}`);
        this.sendError(id, INTERNAL_ERROR, "Internal error");
      }
    } finally {
      if (this.inFlight.get(id) === controller) this.inFlight.delete(id);
    }
  }

  private assertModernMeta(meta: Record<string, unknown>): void {
    const requested = meta[META_PROTOCOL_VERSION];
    if (typeof requested !== "string" || !(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
      throw new ProtocolError(UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
        supported: [...MODERN_PROTOCOL_VERSIONS],
        requested,
      });
    }
    if (!isRecord(meta[META_CLIENT_CAPABILITIES])) {
      throw new ProtocolError(INVALID_PARAMS, `Missing required _meta field ${META_CLIENT_CAPABILITIES}`);
    }
  }

  private serverInfo(): { name: string; title: string; version: string } {
    return { name: this.options.name, title: this.options.title, version: this.options.version };
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
    modern: boolean,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case "initialize": {
        if (modern) throw new ProtocolError(METHOD_NOT_FOUND, "initialize is not part of this protocol version");
        const requested = params.protocolVersion;
        const protocolVersion = typeof requested === "string"
          && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : LEGACY_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: this.serverInfo(),
          instructions: this.options.instructions,
        };
      }
      case "server/discover":
        if (!modern) {
          throw new ProtocolError(INVALID_PARAMS, `Missing required _meta field ${META_PROTOCOL_VERSION}`);
        }
        return {
          supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
          capabilities: { tools: {} },
          instructions: this.options.instructions,
          ...CACHE_HINTS,
        };
      case "ping":
        return {};
      case "tools/list":
        return modern ? { tools: this.options.tools, ...CACHE_HINTS } : { tools: this.options.tools };
      case "tools/call":
        return this.callTool(params, meta, signal);
      default:
        throw new ProtocolError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private async callTool(
    params: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const name = params.name;
    if (typeof name !== "string" || !this.options.tools.some(tool => tool.name === name)) {
      throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${String(name)}`);
    }
    const args = params.arguments ?? {};
    if (!isRecord(args)) throw new ProtocolError(INVALID_PARAMS, "Tool arguments must be an object");

    const token = meta?.progressToken;
    const progressToken = typeof token === "string" || typeof token === "number" ? token : undefined;
    let sent = 0;
    const progress = (message: string) => {
      if (progressToken === undefined || signal.aborted) return;
      sent += 1;
      this.send({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken, progress: sent, message },
      });
    };

    let result: McpToolResult;
    try {
      result = await this.options.callTool(name, args, { signal, progress });
    } catch (error) {
      // Anything a tool throws is feedback for the model, not a protocol fault.
      result = { text: error instanceof Error ? error.message : String(error), isError: true };
    }
    return {
      content: [{ type: "text", text: result.text }],
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      isError: result.isError === true,
    };
  }

  private sendError(id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }

  private send(message: unknown): void {
    // JSON.stringify never emits a raw newline, so one message is one line.
    this.options.write(JSON.stringify(message));
  }
}
