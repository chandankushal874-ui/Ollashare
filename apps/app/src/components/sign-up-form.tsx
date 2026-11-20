"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmailOtpSignin } from "./email-otp-signin";

const inputClass =
  "h-12 w-full rounded-xl border-0 bg-[#f0f1f5] px-4 text-[15px] text-[#111116] outline-none transition placeholder:text-[#878b96] focus:bg-white focus:ring-2 focus:ring-[#7659ef]";

export function SignUpForm() {
  const { signIn } = useAuthActions();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReady(true); }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError("Password must be at least 12 characters long.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const result = await signIn("password", {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        flow: "signUp",
      });
      if (result.signingIn) {
        window.location.href = "/screenshare";
        return;
      }
      setError("Check your email for the verification code, then sign in to complete setup.");
      setPending(false);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Registration failed. Please check details and try again.");
      setPending(false);
    }
  };

  return (
    <div className="w-full">
      <form method="post" onSubmit={handleSubmit} className="w-full">
        <fieldset disabled={!ready || pending} className="grid min-w-0 gap-4 disabled:opacity-70">
          <label className="grid gap-2 text-left text-sm font-semibold text-[#30323a]">
            Full name
            <input className={inputClass} type="text" placeholder="Alex Mercer" required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="grid gap-2 text-left text-sm font-semibold text-[#30323a]">
            Work email
            <input className={inputClass} type="email" placeholder="you@company.com" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
            <label className="grid gap-2 text-left text-sm font-semibold text-[#30323a]">
              Password
              <input className={inputClass} type="password" placeholder="12+ characters" required minLength={12} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label className="grid gap-2 text-left text-sm font-semibold text-[#30323a]">
              Confirm password
              <input className={inputClass} type="password" placeholder="Repeat password" required autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            </label>
          </div>
          <p className="m-0 text-left text-[13px] leading-5 text-[#6b707c]">Your account becomes mailbox-verified only after you complete the verification code step below.</p>
            <EmailOtpSignin passwordVerification initialEmail={email.trim().toLowerCase()} />
          {error && <div className="rounded-xl bg-[#ffe6e6] px-4 py-3 text-left text-sm font-medium text-[#a32828]">{error}</div>}
          <button type="submit" disabled={pending} className="mt-1 flex h-12 w-full items-center justify-center rounded-xl border-0 bg-[#0a0a0d] px-5 font-bold text-white transition hover:-translate-y-0.5 hover:bg-[#292931] disabled:cursor-wait disabled:opacity-70">
            {pending ? "Creating account…" : "Create account and open studio"}
            <ArrowRight className="ml-2 h-4 w-4" />
          </button>
        </fieldset>
      </form>
      <p className="mb-0 mt-5 text-center text-sm text-[#666b77]">
        Already have an account? <Link href="/login" className="font-bold text-[#5d42d6] underline-offset-4 hover:underline">Log in</Link>
      </p>
    </div>
  );
}
