"use client";

import { completePasswordSignIn, safeAuthDestination } from "@/lib/password-auth";
import { useAuthActions } from "@convex-dev/auth/react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

const inputClass =
  "h-12 w-full rounded-xl border-0 bg-[#f0f1f5] px-4 text-[15px] text-[#111116] outline-none transition placeholder:text-[#878b96] focus:bg-white focus:ring-2 focus:ring-[#7659ef]";

export function SignInForm() {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReady(true); }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await completePasswordSignIn(signIn, {
        email: email.trim().toLowerCase(),
        password,
        flow: "signIn",
      });
      const redirect = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("redirect") : null;
      window.location.href = safeAuthDestination(redirect);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Invalid email or password");
      setPending(false);
    }
  };

  return (
    <div className="w-full">
      <form method="post" onSubmit={handleSubmit} className="w-full">
        <fieldset disabled={!ready || pending} className="grid min-w-0 gap-4 disabled:opacity-70">
          <label className="grid gap-2 text-left text-sm font-semibold text-[#30323a]">
            Work email
            <input className={inputClass} type="email" placeholder="you@company.com" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="grid gap-2 text-left text-sm font-semibold text-[#30323a]">
            Password
            <input className={inputClass} type="password" placeholder="Enter your password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <div className="rounded-xl bg-[#ffe6e6] px-4 py-3 text-left text-sm font-medium text-[#a32828]">{error}</div>}
          <button type="submit" disabled={pending} className="mt-1 flex h-12 w-full items-center justify-center rounded-xl border-0 bg-[#0a0a0d] px-5 font-bold text-white transition hover:-translate-y-0.5 hover:bg-[#292931] disabled:cursor-wait disabled:opacity-70">
            {pending ? "Signing in…" : "Sign in and open studio"}
            <ArrowRight className="ml-2 h-4 w-4" />
          </button>
        </fieldset>
      </form>
      <p className="mb-0 mt-5 text-center text-sm text-[#666b77]">
        Need a host account? <Link href="/signup" className="font-bold text-[#5d42d6] underline-offset-4 hover:underline">Create one</Link>
      </p>
    </div>
  );
}
