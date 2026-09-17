import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Raleway } from "next/font/google";
import { Cairo, Heebo } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";

import { Toaster, OfflineBanner } from "@repo/design-system";
import { ConvexClientProvider } from "@repo/auth/provider";
import { getToken } from "@repo/auth/server";
import { getLocaleDirection, type Locale, locales, HreflangLinks } from "@repo/i18n";
import { AnnouncementBannerHost } from "@/components/announcement-banner-host";
import { ConvexErrorToast } from "@/components/convex-error-toast";

const raleway = Raleway({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const cairo = Cairo({
  subsets: ["arabic"],
  variable: "--font-sans",
  display: "swap",
});

const heebo = Heebo({
  subsets: ["hebrew"],
  variable: "--font-sans",
  display: "swap",
});

const fontsByLocale: Record<string, { variable: string }> = {
  ar: cairo,
  he: heebo,
};

if (!process.env.NEXT_PUBLIC_SITE_URL) {
  throw new Error("Missing required environment variable: NEXT_PUBLIC_SITE_URL");
}
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "metadata" });

  const canonicalUrl = `${SITE_URL}/${locale}`;

  return {
    title: {
      template: "%s | LifeOR2",
      default: "LifeOR2 — Your connected workspace",
    },
    description: "Work with your LifeOR2 records, plans, and finances through conversation.",
    metadataBase: new URL(SITE_URL),
    icons: {
      icon: [
        { url: "/icon.svg", type: "image/svg+xml" },
        { url: "/favicon.ico", sizes: "32x32" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    },
    alternates: {
      canonical: canonicalUrl,
      languages: Object.fromEntries(locales.map((loc) => [loc, `/${loc}`])),
    },
    openGraph: {
      type: "website",
      locale: locale,
      url: canonicalUrl,
      siteName: t("title"),
      title: t("title"),
      description: "Work with your LifeOR2 records, plans, and finances through conversation.",
    },
    twitter: {
      card: "summary_large_image",
      title: t("title"),
      description: "Work with your LifeOR2 records, plans, and finances through conversation.",
    },
  };
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!locales.includes(locale as Locale)) {
    notFound();
  }

  const [token, nonce, messages, headersList, tOffline] = await Promise.all([
    getToken(),
    headers().then((h) => h.get("x-nonce") ?? undefined),
    getMessages(),
    headers(),
    getTranslations({ locale, namespace: "offline" }),
  ]);

  const pathname = headersList.get("x-pathname") ?? "/";
  const dir = getLocaleDirection(locale);

  const font = fontsByLocale[locale] || raleway;

  return (
    <html lang={locale} dir={dir} className={font.variable} suppressHydrationWarning>
      <head>
        <HreflangLinks locale={locale} pathname={pathname} siteUrl={SITE_URL} />
      </head>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem nonce={nonce}>
          <OfflineBanner label={tOffline("message")} />
          <NextIntlClientProvider messages={messages}>
            <ConvexClientProvider initialToken={token}>
              <ConvexErrorToast />
              <AnnouncementBannerHost hideOnDashboard fixed />
              {children}
            </ConvexClientProvider>
            <Toaster richColors closeButton position="bottom-right" />
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
