'use client';
import { Component, type ReactNode } from 'react';
import { ConvexError } from 'convex/values';

export class ScreenshareSessionBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    const error = this.state.error;
    if (!(error instanceof ConvexError) || !['Not authenticated', 'Forbidden', 'You have been removed from this room by the host'].includes(String(error.data))) throw error;
    return (
      <section role="alert" className="flex min-h-full items-center justify-center bg-[#fafaff] p-6 text-[#08080b]">
        <div className="w-full max-w-md rounded-[22px] bg-white p-8 text-center shadow-[0_24px_65px_rgba(31,31,56,.14)]">
          <div className="mx-auto mb-5 grid w-fit grid-cols-2 gap-[2px]" aria-hidden="true">
            <i className="block h-4 w-4 rounded-[5px] bg-[#7659ef]" />
            <i className="block h-4 w-4 rounded-[5px] bg-[#a99dff]" />
            <i className="block h-4 w-4 rounded-[5px] bg-[#a99dff]" />
            <i className="block h-4 w-4 rounded-[5px] bg-[#7659ef]" />
          </div>
          <h1 className="text-2xl font-bold tracking-[-0.04em]">Session unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-[#666b77]">Your screen sharing has stopped. Return to the studio to create or join a fresh room.</p>
          <a href="/screenshare" className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-[#0a0a0d] px-5 text-sm font-semibold text-white no-underline transition hover:-translate-y-0.5 hover:bg-[#292931]">Return to screen sharing</a>
        </div>
      </section>
    );
  }
}
