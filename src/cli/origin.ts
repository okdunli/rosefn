
export function requestOrigin(req: any, fallbackPort: number | string): string {
  const rawProto = String(req.headers?.['x-forwarded-proto'] || '');
  // A chain of proxies appends: "https, http". The client-facing hop is first.
  const proto = rawProto.split(',')[0]!.trim();
  const scheme = proto === 'https' || proto === 'http' ? proto : 'http';
  const rawHost = String(req.headers?.['x-forwarded-host'] || '');
  const host = rawHost.split(',')[0]!.trim() || req.headers?.host || `localhost:${fallbackPort}`;
  return `${scheme}://${host}`;
}