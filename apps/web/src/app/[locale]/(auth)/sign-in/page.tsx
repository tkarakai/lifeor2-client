import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@repo/design-patterns";
import { AuthForm } from "@/components/auth/auth-form";
import { LocaleSwitcher } from "@/components/ui/locale-switcher";

export default async function SignInPage() {
  const t = await getTranslations("auth.signIn");


  return (
    <main
      className="flex min-h-[calc(100dvh-var(--env-banner-h,0px))] flex-col"
      style={{ background: "var(--background)" }}
    >
      <SiteHeader appName="LifeOR2" homeHref="/" actions={<LocaleSwitcher />} />
      <div className="mx-auto grid flex-1 max-w-6xl items-start justify-items-center gap-12 px-6 pb-16 pt-[calc(6rem+var(--announcement-banner-h,0px))] lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:justify-items-stretch">
        <section className="w-full max-w-md space-y-6 lg:max-w-none">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
            LifeOR2
          </p>
          <h1 className="text-4xl font-semibold leading-tight">
            {t("pageHeading")}
          </h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            Sign in to your private workspace, connect LifeOR2, and work with your records through conversation.
          </p>
        </section>
        <AuthForm mode="sign-in" />
      </div>
    </main>
  );
}
