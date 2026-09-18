"use client";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  ArrowUp,
  Square,
  Plus,
  Menu,
  Database,
  Link2,
  Sun,
  Moon,
  LogOut,
  Pencil,
  Trash2,
  MessageSquare,
  ArrowRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Sheet,
  SheetContent,
  SheetTitle,
} from "@repo/design-system";
import { authClient } from "@repo/auth/client";
import { useAuthUser } from "@/components/auth/auth-guard";
import { errors } from "@/lib/lifeor/config";
import { useWorkspace, request } from "./use-workspace";
import { Confirmation } from "./confirmation";
import { ContextMeter } from "./context-meter";
import { Messages } from "./messages";
import "./workspace.css";
export function Workspace() {
  const w = useWorkspace(),
    user = useAuthUser(),
    { resolvedTheme, setTheme } = useTheme();
  const [drawer, setDrawer] = useState(false),
    [connectionOpen, setConnectionOpen] = useState(false),
    [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [scopes, setScopes] = useState<string[]>([]),
    [dataset, setDataset] = useState(""),
    [draft, setDraft] = useState(""),
    [title, setTitle] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null),
    draftKey = `lifeor:draft:${user?.email ?? ""}:${w.selected ?? "new"}`;
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    pinned.current = true;
  }, [w.selected]);
  useEffect(() => {
    if (pinned.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [
    w.selected,
    w.state?.runs.length,
    w.live?.answer,
    w.active?.confirmation?.id,
  ]);
  const pending = useRef<{
    id: string;
    text: string;
    conversation: string;
  } | null>(null);
  const connection = w.state?.connection,
    connected = connection?.status === "connected";
  const conversation = w.state?.conversations.find((c) => c._id === w.selected),
    datasets = connection?.datasets ?? [];
  const selectedDataset = dataset || datasets[0]?.id || "",
    targetName =
      conversation?.datasetName ||
      datasets.find((d) => d.id === selectedDataset)?.name;
  const canContinue =
    connected &&
    (!conversation ||
      (conversation.connection === connection.identity &&
        datasets.some((d) => d.id === conversation.datasetId)));
  useEffect(() => {
    setDraft(sessionStorage.getItem(draftKey) ?? "");
  }, [draftKey]);
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("connection");
    if (code && code !== "connected")
      w.setError(errors[code] ?? "The connection could not be completed.");
    if (code === "connected") void w.action("datasets", {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function changeDraft(value: string) {
    setDraft(value);
    sessionStorage.setItem(draftKey, value);
  }
  async function send() {
    if (!draft.trim() || w.active || w.busy) return;
    let id = w.selected;
    if (!id) {
      const result = await w.action<{ id: string }>("conversations/create", {
        datasetId: selectedDataset,
      });
      if (!result) return;
      id = result.id;
      sessionStorage.setItem(`lifeor:draft:${user?.email ?? ""}:${id}`, draft);
      w.select(id);
    }
    if (
      !pending.current ||
      pending.current.text !== draft ||
      pending.current.conversation !== id
    )
      pending.current = {
        id: crypto.randomUUID(),
        text: draft,
        conversation: id,
      };
    const result = await w.action<{ id: string }>("runs/start", {
      conversationId: id,
      prompt: draft.trim(),
      requestId: pending.current.id,
    });
    if (result) {
      changeDraft("");
      sessionStorage.setItem(`lifeor:last-draft:${user?.email}:${id}`, draft);
      sessionStorage.removeItem(`lifeor:draft:${user?.email ?? ""}:${id}`);
      pending.current = null;
      await w.load();
    }
  }
  async function refreshDatasets() {
    await w.action("datasets", {});
  }
  const sidebar = (
    <>
      <a className="wordmark" href="/dashboard" aria-label="LifeOR2 home">
        <span className="brand-symbol">
          L<span>2</span>
        </span>
        <span>
          LifeOR2
          <span className="brand-subtitle">YOUR CONNECTED WORKSPACE</span>
        </span>
      </a>
      <button
        className="new-chat"
        onClick={() => {
          w.select(null);
          setDrawer(false);
          textarea.current?.focus();
        }}
      >
        <Plus size={17} /> New conversation
      </button>
      <div className="history-heading">
        CONVERSATIONS <span>{w.state?.conversations.length ?? "—"}</span>
      </div>
      <nav className="history" aria-label="Conversation history">
        {w.state?.conversations.map((c) => (
          <button
            key={c._id}
            className={w.selected === c._id ? "selected" : ""}
            onClick={() => {
              w.select(c._id);
              setDrawer(false);
            }}
          >
            <MessageSquare size={15} />
            <span>
              {c.title}
              <small>{c.datasetName}</small>
            </span>
          </button>
        ))}
        {w.state?.conversations.length === 0 && (
          <p className="history-empty">
            A little room for your next thought.
            <br />
            Your conversations will appear here.
          </p>
        )}
      </nav>
      <div className="sidebar-bottom">
        <button
          className="connection-button"
          onClick={() => {
            setConnectionOpen(true);
            setDrawer(false);
          }}
        >
          <Link2 size={16} />
          <span>
            LifeOR2 connection
            <small>
              {connected
                ? "Connected"
                : connection?.status === "reconnect_required"
                  ? "Reconnect required"
                  : "Not connected"}
            </small>
          </span>
          <span className={`status-dot ${connected ? "" : "offline"}`} />
        </button>
        <div className="account-row">
          <span className="avatar">
            {(user?.name ?? user?.email ?? "U")[0].toUpperCase()}
          </span>
          <span className="account-name">
            {user?.name ?? "Your account"}
            <a href="/dashboard/settings">Account settings</a>
          </span>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={() => {
              void request("signout", {})
                .catch(() => {})
                .then(() => authClient.signOut())
                .then(() => location.assign("/sign-in"));
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </>
  );
  return (
    <div className="lifeor-workspace">
      <aside className="desktop-sidebar">{sidebar}</aside>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" className="lifeor-workspace mobile-sidebar">
          <SheetTitle className="sr-only">Conversation history</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <main className="chat-main">
        <header className="chat-header">
          <button
            className="icon-button mobile-menu"
            aria-label="Open conversation history"
            onClick={() => setDrawer(true)}
          >
            <Menu size={20} />
          </button>
          <div className="dataset-label">
            <Database size={16} />
            <div>
              <span className="eyebrow">WORKING IN</span>
              <label className="sr-only" htmlFor="dataset">
                Dataset — changing starts a new conversation
              </label>
              <select
                id="dataset"
                aria-describedby="dataset-note"
                value={conversation?.datasetId ?? selectedDataset}
                disabled={!connected || !!w.active}
                onChange={(e) => {
                  setDataset(e.target.value);
                  w.select(null);
                }}
              >
                {!datasets.length && (
                  <option value="">No dataset selected</option>
                )}
                {conversation &&
                  !datasets.some((d) => d.id === conversation.datasetId) && (
                    <option value={conversation.datasetId}>
                      {conversation.datasetName} (unavailable)
                    </option>
                  )}
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <span id="dataset-note" className="sr-only">
            Changing dataset starts a new conversation.
          </span>
          <div className="header-actions">
            {conversation && (
              <>
                <button
                  className="icon-button"
                  aria-label="Rename conversation"
                  disabled={!!w.active}
                  onClick={() => {
                    setTitle(conversation.title);
                    setDialog("rename");
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Delete conversation"
                  disabled={!!w.active}
                  onClick={() => setDialog("delete")}
                >
                  <Trash2 size={16} />
                </button>
              </>
            )}
            <button
              className="icon-button"
              aria-label="Toggle light and dark theme"
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              {/* Keep server and client markup identical before theme resolution. */}
              <Sun size={18} className="theme-icon-sun" />
              <Moon size={18} className="theme-icon-moon" />
            </button>
            <button
              className="connection-pill"
              aria-label={
                connected ? "Manage LifeOR2 connection" : "Connect LifeOR2"
              }
              onClick={() => setConnectionOpen(true)}
            >
              <span className={`status-dot ${connected ? "" : "offline"}`} />
              <span>{connected ? "Connected" : "Connect LifeOR2"}</span>
            </button>
          </div>
        </header>
        <div
          className="conversation-scroll"
          ref={scroll}
          onScroll={(event) => {
            const element = event.currentTarget;
            pinned.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              80;
          }}
        >
          <div className="conversation-column">
            {!w.state && !w.error && (
              <p className="loading" role="status">
                Opening your workspace…
              </p>
            )}
            {w.state && !w.state.runs.length && (
              <section className="welcome">
                <span className="section-kicker">A CLEARER PICTURE</span>
                <h1>Your life, in context.</h1>
                <p>
                  {connected
                    ? "Ask a question. Find a record. Make a little progress."
                    : "Connect your LifeOR2 account to work with your records, plans, and finances in one conversation."}
                </p>
                {!connected ? (
                  <button
                    className="primary connect-cta"
                    onClick={() => setConnectionOpen(true)}
                  >
                    <Link2 size={17} />{" "}
                    {connection?.status === "reconnect_required"
                      ? "Reconnect LifeOR2"
                      : "Connect LifeOR2"}
                    <ArrowRight size={16} />
                  </button>
                ) : !datasets.length ? (
                  <button onClick={refreshDatasets} disabled={w.busy}>
                    Load authorized datasets
                  </button>
                ) : (
                  <div className="suggestions">
                    {[
                      "What’s coming up this month?",
                      "Help me find a record",
                      "Summarize my open obligations",
                    ].map((text, i) => (
                      <button
                        key={text}
                        onClick={() => {
                          changeDraft(text);
                          textarea.current?.focus();
                        }}
                      >
                        <span className="suggestion-number">0{i + 1}</span>
                        <span>{text}</span>
                        <ArrowRight size={15} />
                      </button>
                    ))}
                  </div>
                )}
                <div className="welcome-note">
                  <span className="small-rule" />
                  <p>
                    Your data stays under your control.
                    <br />
                    You choose the datasets. You approve permanent deletions.
                  </p>
                </div>
              </section>
            )}
            {w.state && <Messages runs={w.state.runs} live={w.live} />}
            {w.active?.confirmation && (
              <Confirmation
                key={w.active.confirmation.id}
                run={w.active}
                dataset={targetName ?? "Current dataset"}
                busy={w.busy}
                onAnswer={(action, content) => {
                  void w.action("runs/confirm", {
                    id: w.active!._id,
                    confirmationId: w.active!.confirmation!.id,
                    action,
                    content,
                  });
                }}
              />
            )}
            {w.state?.runs.at(-1) &&
              ["failed", "canceled", "interrupted"].includes(
                w.state.runs.at(-1)!.status,
              ) && (
                <button
                  className="restore-draft"
                  onClick={() => {
                    changeDraft(w.state!.runs.at(-1)!.prompt);
                    textarea.current?.focus();
                  }}
                >
                  Restore last message to composer
                </button>
              )}
          </div>
        </div>
        <footer className="composer-footer">
          <div className="composer-column">
            {w.error && (
              <div className="error-banner" role="alert">
                <p>{w.error}</p>
                <button
                  onClick={() => {
                    w.setError("");
                    void w.load();
                  }}
                >
                  Dismiss
                </button>
              </div>
            )}
            {conversation && !canContinue && (
              <p className="context-warning">
                This conversation’s original connection or dataset is
                unavailable. Connect LifeOR2 and start a new conversation to
                continue. Saved history is still available.
              </p>
            )}
            <div className="context-toolbar">
              <ContextMeter
                usage={
                  w.live?.context ??
                  w.state?.runs.findLast((r) => r.context)?.context
                }
                compacting={w.live?.stage === "Compacting conversation…"}
              />
              {conversation && !!w.state?.runs.length && (
                <button
                  className="compact-button"
                  disabled={!!w.active || w.busy || !canContinue}
                  onClick={() => {
                    void w.action("runs/compact", {
                      conversationId: conversation._id,
                      requestId: crypto.randomUUID(),
                    });
                  }}
                >
                  Compact now
                </button>
              )}
            </div>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="sr-only" htmlFor="message">
                Message LifeOR2
              </label>
              <textarea
                ref={textarea}
                id="message"
                rows={2}
                value={draft}
                maxLength={32000}
                placeholder={
                  connected
                    ? "What would you like to work on?"
                    : "Connect LifeOR2 to start a conversation"
                }
                disabled={!canContinue || !!w.active}
                onChange={(e) => changeDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-tools">
                <span>
                  {targetName ? (
                    <>
                      <Database size={12} />
                      {targetName}
                    </>
                  ) : (
                    "Your private workspace"
                  )}
                </span>
                {w.active ? (
                  <button
                    type="button"
                    className="send-button stop"
                    aria-label="Stop response"
                    onClick={() => {
                      void w.action("runs/stop", { id: w.active!._id });
                    }}
                  >
                    <Square size={16} />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="send-button"
                    aria-label="Send message"
                    disabled={
                      !draft.trim() ||
                      !canContinue ||
                      !selectedDataset ||
                      w.busy
                    }
                  >
                    <ArrowUp size={20} />
                  </button>
                )}
              </div>
            </form>
            <p className="composer-caption">
              Check important details. Stopping a response doesn’t undo
              completed changes.
            </p>
          </div>
        </footer>
      </main>
      <Dialog open={connectionOpen} onOpenChange={setConnectionOpen}>
        <DialogContent className="lifeor-dialog">
          <DialogHeader>
            <DialogTitle>Your LifeOR2 connection</DialogTitle>
            <DialogDescription>
              Authorize this client independently of your client account.
            </DialogDescription>
          </DialogHeader>
          <div className="connection-server">
            <Link2 size={18} />
            <div>
              <strong>{w.state?.server ?? "Loading…"}</strong>
              <p>
                {connected
                  ? "Connected"
                  : connection?.status === "reconnect_required"
                    ? "Authorization needs renewal"
                    : "Not connected"}
              </p>
            </div>
          </div>
          {connected && (
            <>
              <p>
                <strong>Authorized datasets</strong>
              </p>
              <ul>
                {datasets.map((d) => (
                  <li key={d.id}>{d.name}</li>
                ))}
              </ul>
              <button onClick={refreshDatasets} disabled={w.busy}>
                Refresh datasets
              </button>
              <p className="muted">
                Granted permissions: {connection.scopes.join(", ")}
              </p>
            </>
          )}
          <p>
            Read and edit ordinary records are requested by default. Choose any
            additional permissions you need:
          </p>
          <div className="permission-list">
            {[
              [
                "finance:write",
                "Manage finances",
                "Create and edit financial records.",
              ],
              [
                "data:delete",
                "Permanently delete records",
                "Each permanent deletion still requires your confirmation.",
              ],
              [
                "datasets:manage",
                "Manage datasets",
                "Authorize dataset operations supported by LifeOR2.",
              ],
            ].map(([scope, label, description]) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes(
                      e.target.checked
                        ? [...scopes, scope]
                        : scopes.filter((s) => s !== scope),
                    )
                  }
                />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="muted">
            Disconnecting stops further access. It does not erase saved
            conversations; you can delete those separately. Reconnecting starts
            a new connection and new conversations.
          </p>
          {w.error && (
            <p role="alert" className="run-error">
              {w.error}
            </p>
          )}
          <div className="button-row">
            <button
              className="primary"
              disabled={w.busy || !w.state?.configured}
              onClick={() => {
                void w
                  .action<{ url: string }>("oauth/start", { scopes })
                  .then((r) => {
                    if (r) location.assign(r.url);
                  });
              }}
            >
              {connected ? "Update authorization" : "Connect LifeOR2"}
            </button>
            {connected && (
              <button
                disabled={w.busy}
                onClick={() => {
                  void w.action("disconnect", {});
                }}
              >
                Disconnect
              </button>
            )}
          </div>
          {!w.state?.configured && (
            <p className="muted">
              Ask your operator to configure the LifeOR2 connection.
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="lifeor-dialog">
          <DialogHeader>
            <DialogTitle>
              {dialog === "rename"
                ? "Rename conversation"
                : "Delete conversation?"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "rename"
                ? "Give this conversation a useful name."
                : "This removes saved messages and activity from this client. It does not undo changes made in LifeOR2."}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void w
                .action(`conversations/${dialog}`, { id: w.selected, title })
                .then((r) => {
                  if (r) {
                    if (dialog === "delete") w.select(null);
                    setDialog(null);
                  }
                });
            }}
          >
            {dialog === "rename" && (
              <label className="field">
                Name
                <input
                  value={title}
                  maxLength={120}
                  required
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            )}
            <div className="button-row">
              <button className="primary" type="submit" disabled={w.busy}>
                {dialog === "rename" ? "Save name" : "Delete conversation"}
              </button>
              <button type="button" onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
