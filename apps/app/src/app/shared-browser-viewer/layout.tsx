import type { ReactNode } from "react";
import "@v1/ui/globals.css";

export default function SharedBrowserViewerLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="m-0 overflow-hidden bg-black">{children}</body>
    </html>
  );
}
