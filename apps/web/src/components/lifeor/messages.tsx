"use client";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TrafficInspector } from "./traffic-inspector";
import { Copy, Check } from "lucide-react";
import type { Run } from "@/lib/lifeor/types";
function Answer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="message-markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          disallowedElements={["img"]}
          components={{ a: ({ children }) => <span>{children}</span> }}
        >
          {text}
        </Markdown>
      </div>
      <button
        className="copy-button"
        aria-label="Copy response"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
        {copied ? "Copied" : "Copy"}
      </button>
    </>
  );
}
function compactionText(run: Run): string | undefined {
  const event = run.events.findLast((e) => e.type === "compaction");
  if (
    event?.text.startsWith("Compacting") &&
    !["running", "waiting"].includes(run.status)
  )
    return "Compaction did not finish. Original history is saved.";
  return event?.text;
}
export function Messages({
  runs,
  live,
}: {
  runs: Run[];
  live: { answer: string; stage: string } | null;
}) {
  return (
    <>
      {runs.map((run) => (
        <article className="turn" key={run._id}>
          <div className="user-message">
            <span className="message-label">YOU</span>
            <p>{run.prompt}</p>
          </div>
          <div className="assistant-message">
            <span className="message-label accent">LIFEOR2</span>
            {(run.answer ||
              (["running", "waiting"].includes(run.status) &&
                live?.answer)) && (
              <Answer
                text={
                  ["running", "waiting"].includes(run.status)
                    ? live?.answer || run.answer
                    : run.answer
                }
              />
            )}
            {run.events.length > 0 && (
              <details className="activity">
                <summary>
                  {run.events.filter((e) => e.type === "result").length}{" "}
                  completed operations · Activity
                </summary>
                <ol>
                  {run.events
                    .filter((e) => e.type !== "assistant")
                    .map((e) => (
                      <li key={e.id}>
                        <span>{e.text}</span>
                        {e.data && (
                          <details>
                            <summary>Details</summary>
                            <pre>
                              {JSON.stringify(JSON.parse(e.data), null, 2)}
                            </pre>
                          </details>
                        )}
                      </li>
                    ))}
                </ol>
              </details>
            )}
            {run.events.some((e) => e.type === "compaction") && (
              <p className="compaction-notice">{compactionText(run)}</p>
            )}
            <TrafficInspector
              runId={run._id}
              active={["running", "waiting"].includes(run.status)}
            />
            {run.error && (
              <p className="run-error" role="status">
                {run.error}
              </p>
            )}
            {["running", "waiting"].includes(run.status) && (
              <p className="run-stage" role="status">
                <span className="status-dot" />
                {live?.stage ??
                  (run.status === "waiting"
                    ? "Waiting for your confirmation"
                    : "Working on your request")}
              </p>
            )}
          </div>
        </article>
      ))}
    </>
  );
}
