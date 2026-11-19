import type { TaskSessionFactory } from "./mcp-jobs";

/** Client services used by the MCP layer. Tests supply a fake session factory. */
export interface McpClient {
  startSession: TaskSessionFactory;
  resolveApiKey(env: NodeJS.ProcessEnv): string | undefined;
  reportMissingApiKey(): void;
  version(): string;
}
