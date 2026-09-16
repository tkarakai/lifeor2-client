"use client";

import * as React from "react";
import { useMutation, useQuery } from "convex/react";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";

import { api } from "@repo/backend";
import type { AuditStatus } from "@repo/backend";
import { authClient } from "@repo/auth/client";
import {
  Badge,
  Button,
  Input,
  Label,
  PasskeyUnsupportedAlert,
  Separator,
  toast,
  usePasskeySupport,
} from "@repo/design-system";

type PasskeyPolicy = "disabled" | "optional" | "required";

type PasskeyRecord = {
  id?: string;
  credentialID?: string;
  name?: string | null;
  deviceType?: string | null;
  backedUp?: boolean | null;
  createdAt?: number | null;
};

function toPasskeyPolicy(value: unknown): PasskeyPolicy {
  return value === "disabled" || value === "required" ? value : "optional";
}

function getRecordId(record: PasskeyRecord, index: number): string {
  return record.id ?? record.credentialID ?? `record-${index}`;
}

export function PasskeySection() {
  const { supported: passkeySupported } = usePasskeySupport();
  const postAuditEvent = useMutation(api.auditTrail.postEvent);
  const userPasskeyPolicy = useQuery(api.appSettings.getPublic, {
    key: "userPasskeyPolicy",
  });
  const adminPasskeyPolicy = useQuery(api.appSettings.getPublic, {
    key: "adminPasskeyPolicy",
  });
  const [policy, setPolicy] = React.useState<PasskeyPolicy>("optional");
  const [passkeys, setPasskeys] = React.useState<PasskeyRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [adding, setAdding] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [newName, setNewName] = React.useState("");

  const refreshPasskeys = React.useCallback(async () => {
    setLoading(true);
    try {
      const [sessionResult, listResult] = await Promise.all([
        authClient.getSession(),
        (authClient as unknown as {
          passkey?: {
            listUserPasskeys?: () => Promise<{
              data?: PasskeyRecord[];
              error?: { message?: string };
            }>;
          };
        }).passkey?.listUserPasskeys?.(),
      ]);

      if (listResult?.error) {
        toast.error(listResult.error.message ?? "Failed to load passkeys");
      }
      setPasskeys(listResult?.data ?? []);

      const role = (sessionResult.data?.user as Record<string, unknown> | undefined)?.role;
      const selected = role === "admin" ? adminPasskeyPolicy : userPasskeyPolicy;
      setPolicy(toPasskeyPolicy(selected));
    } catch {
      toast.error("Failed to load passkeys");
    } finally {
      setLoading(false);
    }
  }, [adminPasskeyPolicy, userPasskeyPolicy]);

  React.useEffect(() => {
    refreshPasskeys();
  }, [refreshPasskeys]);

  const addPasskey = async () => {
    setAdding(true);
    const happenedAt = Date.now();
    let status: AuditStatus = "succeeded";

    try {
      const result = await (authClient as unknown as {
        passkey?: {
          addPasskey?: (args: { name?: string }) => Promise<{
            error?: { message?: string };
          }>;
        };
      }).passkey?.addPasskey?.({
        name: newName.trim() || undefined,
      });

      if (!result || result.error) {
        status = "failed.unknown";
        toast.error(result?.error?.message ?? "Failed to add passkey");
        return;
      }

      setNewName("");
      toast.success("Passkey added");
      await refreshPasskeys();
    } catch {
      status = "failed.unknown";
      toast.error("Failed to add passkey");
    } finally {
      setAdding(false);
      postAuditEvent({
        happenedAt,
        sourceDetail: "settings",
        action: "auth.passkey.added",
        resource: "passkey:self",
        status,
      }).catch(() => {});
    }
  };

  const renamePasskey = async (id: string) => {
    if (!editName.trim()) return;
    const happenedAt = Date.now();
    let status: AuditStatus = "succeeded";
    try {
      const result = await (authClient as unknown as {
        passkey?: {
          updatePasskey?: (args: { id: string; name: string }) => Promise<{
            error?: { message?: string };
          }>;
        };
      }).passkey?.updatePasskey?.({
        id,
        name: editName.trim(),
      });

      if (!result || result.error) {
        status = "failed.unknown";
        toast.error(result?.error?.message ?? "Failed to rename passkey");
        return;
      }

      setEditingId(null);
      setEditName("");
      toast.success("Passkey updated");
      await refreshPasskeys();
    } catch {
      status = "failed.unknown";
      toast.error("Failed to rename passkey");
    } finally {
      postAuditEvent({
        happenedAt,
        sourceDetail: "settings",
        action: "auth.passkey.renamed",
        resource: `passkey:${id}`,
        status,
      }).catch(() => {});
    }
  };

  const deletePasskey = async (id: string) => {
    const happenedAt = Date.now();
    let status: AuditStatus = "succeeded";
    try {
      const result = await (authClient as unknown as {
        passkey?: {
          deletePasskey?: (args: { id: string }) => Promise<{
            error?: { message?: string };
          }>;
        };
      }).passkey?.deletePasskey?.({ id });

      if (!result || result.error) {
        status = "failed.unknown";
        toast.error(result?.error?.message ?? "Failed to delete passkey");
        return;
      }

      toast.success("Passkey removed");
      await refreshPasskeys();
    } catch {
      status = "failed.unknown";
      toast.error("Failed to delete passkey");
    } finally {
      postAuditEvent({
        happenedAt,
        sourceDetail: "settings",
        action: "auth.passkey.deleted",
        resource: `passkey:${id}`,
        status,
      }).catch(() => {});
    }
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading passkeys...</p>;
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Add and manage passkeys for faster, phishing-resistant sign-in.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Badge variant={policy === "required" ? "default" : "outline"}>
          Policy: {policy}
        </Badge>
        {policy === "disabled" ? (
          <span className="text-xs text-muted-foreground">
            Admin policy currently disables passkey usage.
          </span>
        ) : null}
      </div>

      {policy !== "disabled" ? (
        passkeySupported === false ? (
          <PasskeyUnsupportedAlert />
        ) : (
          <div className="space-y-2">
            <Label htmlFor="new-passkey-name">New passkey label (optional)</Label>
            <div className="flex gap-2">
              <Input
                id="new-passkey-name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="My Laptop"
                className="max-w-sm"
              />
              <Button type="button" onClick={addPasskey} disabled={adding}>
                <Plus className="h-4 w-4" />
                {adding ? "Adding..." : "Add passkey"}
              </Button>
            </div>
          </div>
        )
      ) : null}

      <Separator />

      {passkeys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No passkeys enrolled yet.
        </p>
      ) : (
        <div className="space-y-3">
          {passkeys.map((record, index) => {
            const id = getRecordId(record, index);
            const label = record.name || "Unnamed passkey";
            const isEditing = editingId === id;
            return (
              <div
                key={id}
                className="rounded-md border border-border/60 p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{label}</p>
                    <p className="text-xs text-muted-foreground">
                      {record.deviceType ?? "Unknown device"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Rename passkey ${record.name ?? ""}`.trim()}
                      onClick={() => {
                        setEditingId(id);
                        setEditName(record.name ?? "");
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      aria-label={`Delete passkey ${record.name ?? ""}`.trim()}
                      onClick={() => deletePasskey(id)}
                      disabled={policy === "required" && passkeys.length <= 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      className="max-w-sm"
                      aria-label="Passkey name"
                      autoFocus
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => renamePasskey(id)}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingId(null);
                        setEditName("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
