"use client";
import type { ContextUsage } from "@/lib/lifeor/types";
export function ContextMeter({
  usage,
  compacting,
}: {
  usage?: ContextUsage;
  compacting: boolean;
}) {
  const percent = usage?.percent;
  return (
    <div className={`context-meter ${compacting ? "is-compacting" : ""}`}>
      <span
        className="context-track"
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent ?? 0)}
        aria-valuetext={
          usage
            ? `${percent}% ${usage.estimated ? "estimated " : ""}context used`
            : "Context not measured yet"
        }
      >
        <span style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
      </span>
      <span>
        {compacting
          ? "Compacting context…"
          : usage
            ? `Context ${usage.estimated ? "~" : ""}${percent}%`
            : "Context —"}
      </span>
      <details className="context-explanation">
        <summary aria-label="About context usage">ⓘ</summary>
        <p>
          {usage
            ? `${usage.estimated ? "Approximately " : ""}${usage.tokens.toLocaleString()} of ${usage.window.toLocaleString()} tokens used, with ${usage.outputReserve.toLocaleString()} tokens reserved for the next response. `
            : "Usage appears when the first model request starts. "}
          {usage?.estimated === false
            ? "Usage was reported by the model provider."
            : "This is an estimate of the working context."}{" "}
          Instructions and tools are included. It excludes your unsent draft.
          Older context is summarized automatically; original history stays
          saved.
        </p>
      </details>
    </div>
  );
}
