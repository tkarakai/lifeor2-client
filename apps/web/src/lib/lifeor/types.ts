export type Dataset = { id: string; name: string };
export type ContextUsage = {
  tokens: number;
  window: number;
  percent: number;
  outputReserve: number;
  estimated: boolean;
};
export type Memory = { messages: string; through: number };
export type Observation = {
  id: string;
  exchange: string;
  channel: "model" | "compaction" | "mcp";
  direction: "request" | "response";
  label: string;
  body: string;
  at: number;
  truncated: boolean;
};
export type Observe = (
  entry: Omit<Observation, "id" | "at" | "body" | "truncated"> & {
    body: unknown;
  },
) => Promise<void>;
export type Connection = {
  identity: string;
  status: "connected" | "reconnect_required" | "disconnected";
  scopes: string[];
  datasets: Dataset[];
};
export type Conversation = {
  _id: string;
  connection: string;
  datasetId: string;
  datasetName: string;
  title: string;
  updatedAt: number;
  memory?: Memory;
};
export type Run = {
  _id: string;
  conversationId: string;
  requestId: string;
  kind?: "compaction";
  status:
    "running" | "waiting" | "completed" | "failed" | "canceled" | "interrupted";
  prompt: string;
  answer: string;
  error?: string;
  createdAt: number;
  context?: ContextUsage;
  events: { id: string; type: string; text: string; data?: string }[];
  confirmation?: {
    id: string;
    message: string;
    operation: string;
    arguments: string;
    schema: string;
    expiresAt: number;
    decision?: string;
  };
};
export type Workspace = {
  connection: Connection | null;
  conversations: Conversation[];
  runs: Run[];
  server: string;
  configured: boolean;
  historyCursor?: string | null;
};
export type Credentials = Connection & { tokens: string; refreshing: boolean };
export type Store = <T>(
  op: string,
  payload?: Record<string, unknown>,
) => Promise<T>;
