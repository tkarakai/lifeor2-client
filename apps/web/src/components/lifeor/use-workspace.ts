"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Run, Workspace, ContextUsage } from "@/lib/lifeor/types";
export async function request<T>(
  path: string,
  input?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    `/api/lifeor/${path}`,
    input
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      : { cache: "no-store" },
  );
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? "The request could not be completed.");
  return value;
}
export function useWorkspace() {
  const [state, setState] = useState<Workspace | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [live, setLive] = useState<{
    answer: string;
    stage: string;
    context?: ContextUsage;
  } | null>(null);
  const loadedEarlier = useRef(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const selection = useRef(selected);
  selection.current = selected;
  const load = useCallback(async () => {
    try {
      const id = selection.current;
      const result = await request<Workspace>(
        `state${id ? `?conversation=${encodeURIComponent(id)}` : ""}`,
      );
      if (selection.current === id)
        setState((previous) => {
          const merged = new Map((previous?.runs ?? []).map((r) => [r._id, r]));
          for (const run of result.runs) merged.set(run._id, run);
          return {
            ...result,
            runs: [...merged.values()].sort(
              (a, b) => a.createdAt - b.createdAt,
            ),
            historyCursor: loadedEarlier.current
              ? previous?.historyCursor
              : result.historyCursor,
          };
        });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load, selected]);
  const active = state?.runs.find(
    (r) => r.status === "running" || r.status === "waiting",
  );
  useEffect(() => {
    if (!active) return;
    const source = new EventSource(
      `/api/lifeor/stream?run=${encodeURIComponent(active._id)}`,
    );
    source.onmessage = (e) => {
      const data = JSON.parse(e.data) as {
        run: Run;
        answer: string;
        stage: string;
        context?: ContextUsage;
      };
      if (data.run.conversationId !== selection.current) return;
      setLive({
        answer: data.answer,
        stage: data.stage,
        context: data.context,
      });
      setState((prev) =>
        prev
          ? {
              ...prev,
              runs: prev.runs.map((r) =>
                r._id === data.run._id ? data.run : r,
              ),
            }
          : prev,
      );
      if (!["running", "waiting"].includes(data.run.status)) {
        source.close();
        setLive(null);
        void load();
      }
    };
    source.onerror = () => {
      source.close();
      setLive(null);
      void load();
    };
    return () => {
      source.close();
      setLive(null);
    };
  }, [active?._id, load]); // eslint-disable-line react-hooks/exhaustive-deps
  async function action<T>(
    path: string,
    input: Record<string, unknown>,
  ): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      const result = await request<T>(path, input);
      await load();
      return result;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function loadEarlier() {
    const id = selection.current;
    if (!id || !state?.historyCursor || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const result = await request<{ runs: Run[]; cursor: string | null }>(
        `history?conversation=${encodeURIComponent(id)}&cursor=${encodeURIComponent(state.historyCursor)}`,
      );
      if (selection.current === id) {
        loadedEarlier.current = true;
        setState((prev) => {
          if (!prev) return prev;
          const merged = new Map(
            [...result.runs, ...prev.runs].map((r) => [r._id, r]),
          );
          return {
            ...prev,
            runs: [...merged.values()].sort(
              (a, b) => a.createdAt - b.createdAt,
            ),
            historyCursor: result.cursor,
          };
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingEarlier(false);
    }
  }
  function select(id: string | null) {
    selection.current = id;
    loadedEarlier.current = false;
    setSelected(id);
    setLive(null);
    setError("");
    setState((prev) => (prev ? { ...prev, runs: [] } : null));
  }
  return {
    state,
    selected,
    select,
    error,
    setError,
    busy,
    live,
    active,
    load,
    action,
    loadEarlier,
    loadingEarlier,
  };
}
