"use client";
import { useEffect, useState } from "react";
import { Radio, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import type { Observation } from "@/lib/lifeor/types";
import { request } from "./use-workspace";
export function TrafficInspector({
  runId,
  active,
}: {
  runId: string;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{
    entries: Observation[];
    limited: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await request<{
          entries: Observation[];
          limited: boolean;
        }>(`traffic?run=${encodeURIComponent(runId)}`);
        if (!canceled) {
          setData(result);
          setError("");
        }
      } catch {
        if (!canceled)
          setError("Traffic could not be loaded. Close and reopen to retry.");
      }
      if (!canceled && active) timer = setTimeout(load, 2000);
    };
    void load();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [open, runId, active]);
  const entries =
    data?.entries.filter((e) => filter === "all" || e.channel === filter) ?? [];
  return (
    <details
      className="traffic-inspector"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Radio size={14} /> Inspect traffic <span>MODEL · MCP</span>
      </summary>
      {open && (
        <div className="traffic-content">
          <p className="traffic-note">
            Model request bodies, assembled model responses, and MCP messages.
            Credentials and private reasoning are excluded. Large payloads are
            shown as previews. This includes your conversation and record data.
          </p>
          <label className="traffic-filter">
            Show{" "}
            <select
              aria-label="Filter traffic"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All traffic</option>
              <option value="model">Model</option>
              <option value="compaction">Compaction</option>
              <option value="mcp">MCP</option>
            </select>
          </label>
          {error && <p role="status">{error}</p>}
          {!data && !error && <p role="status">Loading traffic…</p>}
          {data && !entries.length && (
            <p>
              No captured traffic
              {filter === "all" ? " for this turn" : " in this category"}.
            </p>
          )}
          <ol className="traffic-entries">
            {entries.map((e) => (
              <li key={e.id}>
                <details>
                  <summary>
                    {e.direction === "request" ? (
                      <ArrowUpRight size={15} />
                    ) : (
                      <ArrowDownLeft size={15} />
                    )}
                    <span className="traffic-direction">
                      {e.direction === "request" ? "SENT" : "RECEIVED"}
                    </span>
                    <span className="traffic-label">{e.label}</span>
                    <span className="traffic-channel">{e.channel}</span>
                  </summary>
                  <div className="traffic-meta">
                    <time dateTime={new Date(e.at).toISOString()}>
                      {new Date(e.at).toLocaleTimeString()}
                    </time>{" "}
                    · Exchange {e.exchange.slice(0, 8)}
                  </div>
                  {e.truncated && (
                    <p className="traffic-truncated">
                      Preview truncated at 48,000 bytes.
                    </p>
                  )}
                  <pre tabIndex={0} aria-label={`${e.direction} payload`}>
                    {e.body}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
          {data?.limited && (
            <p className="traffic-truncated">
              Capture limit reached: showing the first 128 entries for this
              turn.
            </p>
          )}
        </div>
      )}
    </details>
  );
}
