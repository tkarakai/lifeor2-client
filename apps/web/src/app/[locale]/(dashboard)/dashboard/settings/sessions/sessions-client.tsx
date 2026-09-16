"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Globe,
  Laptop,
  LogOut,
  Monitor,
  Shield,
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
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Card,
  CardContent,
  Separator,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  Skeleton,
} from "@repo/design-system";
import { useAuthUser } from "@/components/auth/auth-guard";
import { AppSidebar } from "@/components/projects/app-sidebar";
import { AnnouncementBannerHost } from "@/components/announcement-banner-host";
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

/** Normalize IPv6 loopback and IPv4-mapped IPv6 addresses for display. */
function normalizeIp(ip: string): string {
  if (ip === "::1") return "127.0.0.1";
  // Strip ::ffff: prefix from IPv4-mapped IPv6 addresses
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

export function SessionsClient() {
  const router = useRouter();
  const authUser = useAuthUser();
  const ts = useTranslations("dashboard.sessions");
  const tc = useTranslations("common");
  const td = useTranslations("dashboard");

  const postAuditEvent = useMutation(api.auditTrail.postEvent);
  const [sessions, setSessions] = React.useState<Session[] | null>(null);
  const [currentSessionToken, setCurrentSessionToken] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [revokingAll, setRevokingAll] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const displayName = authUser?.name ?? "Anonymous";
  const displayEmail = authUser?.email;

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
      // Also get current session to identify it
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

  return (
    <SidebarProvider>
      <AppSidebar
        displayName={displayName}
        displayEmail={displayEmail ?? undefined}
        selectedProjectId={null}
        onSelectProject={() => router.push("/dashboard")}
      />
      <SidebarInset className="flex flex-col h-dvh">
        <AnnouncementBannerHost className="shrink-0" />
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/40 bg-background px-4">
          <SidebarTrigger className="-ms-1" />
          <Separator
            orientation="vertical"
            className="me-2 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink
                  className="cursor-pointer"
                  onClick={() => router.push("/dashboard")}
                >
                  {td("projects")}
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{ts("title")}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>

        <div className="flex flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
            {/* Page header */}
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <Shield className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold">{ts("title")}</h1>
                  <p className="text-sm text-muted-foreground">
                    {ts("description")}
                  </p>
                </div>
              </div>
            </div>

            <Separator />

            {error ? (
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
                {error}
              </div>
            ) : null}

            {/* Loading state */}
            {sessions === null ? (
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
            ) : (
              <>
                {/* Current session */}
                {currentSession ? (
                  <div className="space-y-3">
                    <h2 className="text-sm font-medium text-muted-foreground">
                      {ts("currentSession")}
                    </h2>
                    <SessionCard
                      session={currentSession}
                      isCurrent
                      ts={ts}
                    />
                  </div>
                ) : null}

                {/* Other sessions */}
                {otherSessions.length > 0 ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-medium text-muted-foreground">
                        {ts("otherSessions")}
                      </h2>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={revokingAll}
                          >
                            <LogOut className="h-3.5 w-3.5" />
                            {revokingAll ? tc("loading") : ts("revokeAll")}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{ts("revokeAllTitle")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {ts("revokeAllDescription")}
                            </AlertDialogDescription>
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

                {/* No other sessions message */}
                {otherSessions.length === 0 && currentSession ? (
                  <div className="rounded-lg border border-dashed border-border/60 p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      {ts("noOtherSessions")}
                    </p>
                  </div>
                ) : null}
              </>
            )}

            {/* Back link */}
            <div className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push("/dashboard")}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {ts("backToDashboard")}
              </Button>
            </div>
          </div>
        </div>
        <footer className="sticky bottom-0 shrink-0 h-5 border-t border-border/40 bg-background" />
      </SidebarInset>
    </SidebarProvider>
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
