export type Dataset = { id: string; name: string };
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
};
export type Run = {
  _id: string;
  conversationId: string;
  requestId: string;
  status:
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "canceled"
    | "interrupted";
  prompt: string;
  answer: string;
  error?: string;
  createdAt: number;
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
};
export type Credentials = Connection & { tokens: string; refreshing: boolean };
export type Store = <T>(
  op: string,
  payload?: Record<string, unknown>,
) => Promise<T>;
