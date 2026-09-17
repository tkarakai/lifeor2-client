"use client";
import { useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { Run } from "@/lib/lifeor/types";
export function Confirmation({
  run,
  dataset,
  busy,
  onAnswer,
}: {
  run: Run;
  dataset: string;
  busy: boolean;
  onAnswer: (action: string, content: Record<string, unknown>) => void;
}) {
  const [content, setContent] = useState<Record<string, unknown>>({});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.focus({ preventScroll: true });
    form.current?.scrollIntoView({ block: "end" });
  }, [run.confirmation?.id]);
  const c = run.confirmation;
  if (!c) return null;
  const schema = JSON.parse(c.schema) as {
    properties: Record<
      string,
      { type: string; title?: string; description?: string; enum?: string[] }
    >;
    required?: string[];
  };
  const expired = c.expiresAt < Date.now(),
    disabled = busy || expired || !!c.decision;
  return (
    <form
      className="confirmation"
      ref={form}
      tabIndex={-1}
      aria-label="Confirm LifeOR2 operation"
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer("accept", content);
      }}
    >
      <div className="confirmation-heading">
        <ShieldAlert size={20} />
        <h3>Your confirmation is needed</h3>
      </div>
      <p>{c.message}</p>
      <p className="muted">
        Dataset: <strong>{dataset}</strong> · {c.operation}
      </p>
      <details>
        <summary>Review exact operation</summary>
        <pre>{JSON.stringify(JSON.parse(c.arguments), null, 2)}</pre>
      </details>
      {Object.entries(schema.properties).map(([name, p]) => (
        <label className="field" key={name}>
          {p.title ?? name}
          {p.description && <span className="muted">{p.description}</span>}
          {p.type === "boolean" ? (
            <input
              type="checkbox"
              checked={content[name] === true}
              onChange={(e) =>
                setContent({ ...content, [name]: e.target.checked })
              }
              disabled={disabled}
            />
          ) : p.enum ? (
            <select
              required={schema.required?.includes(name)}
              value={String(content[name] ?? "")}
              onChange={(e) =>
                setContent({ ...content, [name]: e.target.value })
              }
              disabled={disabled}
            >
              <option value="">Choose…</option>
              {p.enum.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          ) : (
            <input
              autoComplete="off"
              required={schema.required?.includes(name)}
              type={
                p.type === "number" || p.type === "integer" ? "number" : "text"
              }
              value={String(content[name] ?? "")}
              onChange={(e) =>
                setContent({
                  ...content,
                  [name]:
                    p.type === "number" || p.type === "integer"
                      ? Number(e.target.value)
                      : e.target.value,
                })
              }
              disabled={disabled}
            />
          )}
        </label>
      ))}
      <div className="button-row">
        <button className="primary" type="submit" disabled={disabled}>
          Confirm operation
        </button>
        <button
          type="button"
          onClick={() => onAnswer("cancel", {})}
          disabled={disabled}
        >
          Cancel
        </button>
      </div>
      <p className="muted">
        {expired
          ? "This confirmation expired. Request the operation again."
          : c.decision
            ? "Your decision has been recorded."
            : "Only confirm after reviewing the target and consequences."}
      </p>
    </form>
  );
}
