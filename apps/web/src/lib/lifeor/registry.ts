import type { ContextUsage } from "./types";
import { randomUUID } from "node:crypto";
export type LiveRun = {
  ownerId: string;
  sessionId: string;
  connection: string;
  controller: AbortController;
  answer: string;
  stage: string;
  context?: ContextUsage;
};
const host = globalThis as typeof globalThis & {
  lifeorRuntime?: {
    instance: string;
    runs: Map<string, LiveRun>;
    locks: Map<string, Promise<unknown>>;
    reservations: number;
  };
};
export const registry = (host.lifeorRuntime ??= {
  instance: randomUUID(),
  runs: new Map(),
  locks: new Map(),
  reservations: 0,
});
export async function serial<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = registry.locks.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(work);
  registry.locks.set(key, task);
  try {
    return await task;
  } finally {
    if (registry.locks.get(key) === task) registry.locks.delete(key);
  }
}
export function cancelConnection(ownerId: string): void {
  for (const run of registry.runs.values())
    if (run.ownerId === ownerId) run.controller.abort();
}
