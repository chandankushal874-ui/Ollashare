"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "@v1/ui/button";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { useState } from "react";

type Mode = "signIn" | "signUp";

const inputClass =
  "w-full rounded-lg border border-border bg-background/80 px-3.5 py-2.5 text-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20";

export function AuthForm() {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signIn("password", {
        email,
        password,
        flow: mode === "signUp" ? "signUp" : "signIn",
      });
      // Return to the original destination (guest room links carry ?code).
      const redirect = new URLSearchParams(window.location.search).get(
        "redirect",
      );
      window.location.href = redirect?.startsWith("/")
        ? redirect
        : "/screenshare";
    } catch (err: any) {
      setError(err?.message ?? "Authentication failed");
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-sm">
      <div className="w-full rounded-xl border border-sky-500/30 bg-sky-500/10 p-3.5 text-left text-xs text-sky-300 flex items-start gap-2.5">
        <ShieldCheck className="h-4 w-4 shrink-0 text-sky-400 mt-0.5" />
        <div>
          <span className="font-semibold text-sky-200">Secure Sign In</span>
          <p className="mt-0.5 text-sky-300/80 leading-relaxed">
            {mode === "signIn"
              ? "Sign in with your email and password."
              : "Create an account to start hosting sessions."}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Email
          </label>
          <input
            className={inputClass}
            type="email"
            placeholder="you@company.com"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Password
          </label>
          <input
            className={inputClass}
            type="password"
            placeholder="••••••••••••"
            required
            autoComplete={
              mode === "signIn" ? "current-password" : "new-password"
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <Button
          type="submit"
          disabled={pending}
          className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 transition mt-1"
        >
          {pending
            ? "Authenticating…"
            : mode === "signIn"
              ? "Sign In & Launch Studio"
              : "Create Account"}
          <ArrowRight className="h-4 w-4 ml-1" />
        </Button>
      </form>

      <button
        type="button"
        onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
        className="text-xs text-muted-foreground hover:text-sky-400 transition"
      >
        {mode === "signIn"
          ? "No account? Create one"
          : "Already have an account? Sign in"}
      </button>
    </div>
  );
}
