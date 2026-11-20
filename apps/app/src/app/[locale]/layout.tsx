import "@v1/ui/globals.css";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { TooltipProvider } from "@v1/ui/tooltip";
import { cn } from "@v1/ui/utils";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import { headers } from 'next/headers';
import { ConvexClientProvider } from "../convex-client-provider";

export const metadata: Metadata = {
  title: "Ollashare",
  description: "Collaborative screen sharing and a host-controlled Shared Browser.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)" },
    { media: "(prefers-color-scheme: dark)" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <ConvexAuthNextjsServerProvider storage="inMemory">
      <html lang="en" suppressHydrationWarning>
        <body
          className={cn(
            `${GeistSans.variable} ${GeistMono.variable}`,
            "antialiased",
          )}
        >
          <ThemeProvider
            nonce={nonce}
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <TooltipProvider delayDuration={0}>
              <ConvexClientProvider>{children}</ConvexClientProvider>
            </TooltipProvider>
          </ThemeProvider>
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
