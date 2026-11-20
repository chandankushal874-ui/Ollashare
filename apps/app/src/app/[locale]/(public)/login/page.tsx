import { SignInForm } from "@/components/sign-in-form";
import { SignupMesh } from "@/components/signup-mesh";
import Link from "next/link";

export const metadata = {
  title: "Sign In - Ollashare",
};

export default function LoginPage() {
  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-[#fafaff] text-[#08080b]">
      <SignupMesh />
      <div className="pointer-events-none absolute -right-28 -top-24 h-80 w-[48vw] rounded-full bg-[#dcecff] opacity-65 blur-3xl" />

      <nav className="relative z-10 mx-auto flex h-[76px] w-[min(1380px,calc(100%-44px))] items-center justify-between border-b border-black/5 px-1">
        <Link href="/landing" className="flex items-center gap-2.5 no-underline">
          <span className="grid grid-cols-2 gap-[2px]" aria-hidden="true">
            <i className="block h-3.5 w-3.5 rounded-[5px] bg-[#7659ef]" />
            <i className="block h-3.5 w-3.5 rounded-[5px] bg-[#a99dff]" />
            <i className="block h-3.5 w-3.5 rounded-[5px] bg-[#a99dff]" />
            <i className="block h-3.5 w-3.5 rounded-[5px] bg-[#7659ef]" />
          </span>
          <span className="text-[27px] font-bold tracking-[-0.055em]">Ollashare</span>
        </Link>
        <div className="flex items-center gap-3 text-sm font-semibold">
          <span className="hidden text-[#5e6270] sm:inline">New to Ollashare?</span>
          <Link href="/signup" className="rounded-xl border-2 border-[#15151a] bg-white px-4 py-2.5 text-[#111116] no-underline transition hover:-translate-y-0.5">
            Create account
          </Link>
        </div>
      </nav>

      <div className="relative z-10 mx-auto grid min-h-[calc(100dvh-76px)] w-[min(1220px,calc(100%-40px))] grid-cols-[1.05fr_.95fr] items-center gap-16 py-10 max-[900px]:grid-cols-1 max-[900px]:gap-8 max-[900px]:py-8">
        <section className="max-w-[620px] max-[900px]:mx-auto max-[900px]:text-center">
          <p className="mb-4 inline-flex rounded-full bg-[#e3e0ff] px-4 py-2 text-[13px] font-bold text-[#5139c9]">
            Return to your governed rooms
          </p>
          <h1 className="m-0 text-[clamp(48px,5vw,74px)] font-bold leading-[.95] tracking-[-0.065em]">
            Pick up where<br />the room paused.
          </h1>
          <p className="mt-5 max-w-[570px] text-[18px] leading-[1.5] text-[#41434d] max-[900px]:mx-auto">
            Sign in to create support rooms, review activity and continue collaborative browser sessions with explicit host control.
          </p>

          <div className="mt-9 rounded-2xl bg-white p-5 text-left max-[900px]:mx-auto max-[900px]:max-w-[570px]">
            <div className="flex items-center justify-between gap-5">
              <div>
                <span className="block text-[13px] font-bold text-[#7659ef]">Room state</span>
                <b className="mt-1 block text-[20px] tracking-[-0.035em]">Your access returns. Old grants do not.</b>
              </div>
              <span className="rounded-lg bg-[#e8f6ed] px-2.5 py-1.5 text-xs font-bold text-[#23744a]">Protected</span>
            </div>
            <p className="mb-0 mt-4 text-[14px] leading-6 text-[#606572]">Each login restores your account session. Shared Browser viewer and controller grants remain room-scoped and short-lived.</p>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-3 text-sm font-semibold text-[#4e535f] max-[900px]:justify-center">
            <span className="flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-[#42ae73]" />Account service ready</span>
            <span>Host permissions</span>
            <span>Room history</span>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[510px] rounded-[22px] bg-white p-7 shadow-[0_24px_65px_rgba(31,31,56,.14)] sm:p-9">
          <div className="mb-7 flex items-start justify-between gap-5">
            <div>
              <p className="m-0 text-[13px] font-bold text-[#7659ef]">Host sign in</p>
              <h2 className="mb-0 mt-2 text-[30px] font-bold tracking-[-0.045em]">Return to the studio.</h2>
            </div>
            <span className="rounded-lg bg-[#e8f6ed] px-2.5 py-1.5 text-xs font-bold text-[#23744a]">Secure</span>
          </div>
          <SignInForm />
        </section>
      </div>
    </main>
  );
}
