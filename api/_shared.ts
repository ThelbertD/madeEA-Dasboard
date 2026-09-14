/* Small helpers shared by the API routes. */

/** Read the caller's IP from the proxy headers Vercel sets. */
export function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

/**
 * Best-effort per-IP rate limiter.
 *
 * Serverless instances are recycled, so this throttles bursts from one visitor
 * rather than acting as hard security. It exists to make guessing the dashboard
 * key slow, not to be a firewall.
 */
export function createRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return function isLimited(ip: string): boolean {
    const now = Date.now();
    const bucket = (hits.get(ip) ?? []).filter(t => now - t < windowMs);
    bucket.push(now);
    hits.set(ip, bucket);
    if (hits.size > 5000) hits.clear();
    return bucket.length > max;
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}
