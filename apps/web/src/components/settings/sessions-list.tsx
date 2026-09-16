"use client";

import * as React from "react";
import {
  Globe,
  Laptop,
  LogOut,
  Monitor,
  Smartphone,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { useMutation } from "convex/react";
import { api } from "@repo/backend";
import type { AuditStatus } from "@repo/backend";
import { authClient } from "@repo/auth/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
} from "@repo/design-system";
import { parseUserAgent } from "@repo/design-system";

type Session = {
  id: string;
  token: string;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

function DeviceIcon({ device }: { device: string }) {
  switch (device) {
    case "mobile":
      return <Smartphone className="h-5 w-5" />;
    case "tablet":
      return <Monitor className="h-5 w-5" />;
    case "desktop":
      return <Laptop className="h-5 w-5" />;
    default:
      return <Globe className="h-5 w-5" />;
  }
}

function normalizeIp(ip: string): string {
  if (ip === "::1") return "127.0.0.1";
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  return ip;
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function SessionsList() {
  const ts = useTranslations("dashboard.sessions");
  const tc = useTranslations("common");

  const postAuditEvent = useMutation(api.auditTrail.postEvent);
  const [sessions, setSessions] = React.useState<Session[] | null>(null);
  const [currentSessionToken, setCurrentSessionToken] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [revokingAll, setRevokingAll] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchSessions = React.useCallback(async () => {
    try {
      const result = await authClient.listSessions();
      // listSessions resolves with { data, error } instead of throwing, so an
      // HTTP failure lands here with data undefined. Without this branch the
      // page sits in its loading skeleton forever and never tells the user why.
      if (result.error) {
        setError("Failed to load sessions.");
        return;
      }
      if (result.data) {
        setSessions(result.data as Session[]);
      }
      const sessionResult = await authClient.getSession();
      if (sessionResult.data?.session) {
        setCurrentSessionToken(sessionResult.data.session.token);
      }
    } catch {
      setError("Failed to load sessions.");
    }
  }, []);

  React.useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleRevoke = async (sessionToken: string) => {
    setRevoking(sessionToken);
    setError(null);
    const happenedAt = Date.now();
    let status: AuditStatus = "succeeded";

    try {
      await authClient.revokeSession({ token: sessionToken });
      setSessions((prev) => prev?.filter((s) => s.token !== sessionToken) ?? null);
    } catch {
      status = "failed.unknown";
      setError("Failed to revoke session.");
    } finally {
      setRevoking(null);
      postAuditEvent({
        happenedAt,
        sourceDetail: "settings",
        action: "auth.session.revoked",
        resource: `session:…${sessionToken.slice(-8)}`,
        status,
      }).catch(() => {});
    }
  };

  const handleRevokeAll = async () => {
    setRevokingAll(true);
    setError(null);
    const happenedAt = Date.now();
    let status: AuditStatus = "succeeded";

    try {
      // revokeSessions() kills EVERY session including this one, which signs the
      // user out of the device they are sitting at. The control is "sign out all
      // others" (and audits as session:all-others), so it must spare the current
      // session.
      await authClient.revokeOtherSessions();
      await fetchSessions();
    } catch {
      status = "failed.unknown";
      setError("Failed to revoke sessions.");
    } finally {
      setRevokingAll(false);
      postAuditEvent({
        happenedAt,
        sourceDetail: "settings",
        action: "auth.session.revoked_all",
        resource: "session:all-others",
        status,
      }).catch(() => {});
    }
  };

  const otherSessions = sessions?.filter((s) => s.token !== currentSessionToken) ?? [];
  const currentSession = sessions?.find((s) => s.token === currentSessionToken);

  if (error) {
    return (
      <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
        {error}
      </div>
    );
  }

  if (sessions === null) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="border-border/40">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Current session */}
      {currentSession ? (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            {ts("currentSession")}
          </h3>
          <SessionCard session={currentSession} isCurrent ts={ts} />
        </div>
      ) : null}

      {/* Other sessions */}
      {otherSessions.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-muted-foreground">
              {ts("otherSessions")}
            </h3>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={revokingAll}>
                  <LogOut className="h-3.5 w-3.5" />
                  {revokingAll ? tc("loading") : ts("revokeAll")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{ts("revokeAllTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{ts("revokeAllDescription")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleRevokeAll}>
                    {ts("revokeAllConfirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {otherSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                isCurrent={false}
                revoking={revoking === session.token}
                onRevoke={() => handleRevoke(session.token)}
                ts={ts}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* No other sessions */}
      {otherSessions.length === 0 && currentSession ? (
        <div className="rounded-lg border border-dashed border-border/60 p-8 text-center">
          <p className="text-sm text-muted-foreground">{ts("noOtherSessions")}</p>
        </div>
      ) : null}
    </div>
  );
}

function SessionCard({
  session,
  isCurrent,
  revoking,
  onRevoke,
  ts,
}: {
  session: Session;
  isCurrent: boolean;
  revoking?: boolean;
  onRevoke?: () => void;
  ts: ReturnType<typeof useTranslations>;
}) {
  const tc = useTranslations("common");
  const parsed = parseUserAgent(session.userAgent);
  const lastActive = formatRelativeTime(new Date(session.updatedAt));

  return (
    <Card
      className={
        isCurrent
          ? "border-primary/30 bg-primary/[0.02]"
          : "border-border/40"
      }
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
              isCurrent
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            <DeviceIcon device={parsed.device} />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">
                {parsed.browser} on {parsed.os}
              </span>
              {isCurrent ? (
                <Badge variant="outline" className="shrink-0 border-primary/30 text-primary text-[10px] px-1.5 py-0">
                  {ts("current")}
                </Badge>
              ) : null}
            </div>
            {session.ipAddress ? (
              <p className="text-xs text-muted-foreground truncate">
                {normalizeIp(session.ipAddress)}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {ts("lastActive", { time: lastActive })}
            </p>
          </div>
          {!isCurrent && onRevoke ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={revoking}
                >
                  <LogOut className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{ts("revokeTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {ts("revokeDescription", {
                      device: `${parsed.browser} on ${parsed.os}`,
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={onRevoke}>
                    {tc("signOut")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
