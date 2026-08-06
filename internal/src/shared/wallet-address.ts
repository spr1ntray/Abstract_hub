const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function normalizeWalletAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

export function preserveWalletAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) return undefined;
  return value;
}
