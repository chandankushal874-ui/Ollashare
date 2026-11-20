import { readFile } from "node:fs/promises";
import path from "node:path";
import { headers } from "next/headers";

export default async function LandingPage() {
  const landingPath = path.join(process.cwd(), "public", "ollashare-landing.html");
  const nonce = (await headers()).get("x-nonce") ?? "";
  const landingHtml = (await readFile(landingPath, "utf8")).replaceAll(
    "<script>",
    `<script nonce="${nonce}">`,
  );

  return (
    <iframe
      title="Ollashare"
      srcDoc={landingHtml}
      className="fixed inset-0 h-[100dvh] w-full border-0 bg-white"
      sandbox="allow-scripts allow-same-origin allow-top-navigation-by-user-activation"
    />
  );
}
