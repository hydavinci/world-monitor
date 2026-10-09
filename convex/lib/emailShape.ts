export function extractDomain(email: string): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0 || trimmed.indexOf("@", at + 1) !== -1) return null;
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (domain.length === 0 || /\s/.test(domain)) return null;
  return domain;
}
