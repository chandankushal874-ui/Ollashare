import { convexAuthNextjsToken } from '@convex-dev/auth/nextjs/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", Vary: 'Cookie' };
  try {
    const token = await convexAuthNextjsToken();
    if (!token) return new Response(null, { status: 401, headers });
    const origin = new URL(process.env.MIRA_CONVEX_HTTP_ORIGIN ?? '');
    if (origin.username || origin.password || (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Invalid storage origin');
    const upstream = await fetch(new URL(`/files/download/${encodeURIComponent(fileId)}`, origin), {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) return new Response(null, { status: 404, headers });
    return new Response(upstream.body, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Disposition': upstream.headers.get('content-disposition') ?? 'attachment' } });
  } catch { return new Response(null, { status: 404, headers }); }
}
