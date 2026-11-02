import { CodexServiceTier } from '../model/BridgeModels';

export function isFastServiceTier(value: string | undefined | null,
  options: CodexServiceTier[] | undefined | null): boolean {
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalizedValue.length === 0 || options === undefined || options === null) {
    return false;
  }
  if (normalizedValue !== 'priority' && normalizedValue !== 'fast' && normalizedValue !== 'ultrafast') {
    return false;
  }
  return options.some((option: CodexServiceTier) => option.id.trim().toLowerCase() === normalizedValue);
}
