type PasswordSignIn = (provider: string, params: Record<string, string>) => Promise<{ signingIn: boolean; redirect?: URL }>;

export async function completePasswordSignIn(signIn: PasswordSignIn, params: Record<string, string>) {
  try {
    const result = await signIn("password", params);
    if (!result?.signingIn || result.redirect) throw new Error("Incomplete authentication");
  } catch {
    throw new Error("Unable to sign in. Check your email and password and try again.");
  }
}

export function safeAuthDestination(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/screenshare";
  const path = (value.split(/[?#]/)[0] ?? "");
  if (/^\/(?:en\/|fr\/|es\/)?(?:login|signup)(?:\/|$)/.test(path)) return "/screenshare";
  return value;
}
