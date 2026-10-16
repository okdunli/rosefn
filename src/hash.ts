export function fnv1a32(input: Uint8Array | string): string {
  let h = 0x811c9dc5;
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
