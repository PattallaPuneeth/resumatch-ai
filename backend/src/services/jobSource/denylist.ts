/**
 * Permanent hardcoded denylist for sites that prohibit automated scraping in their terms.
 * These domains and any subdomains are strictly blocked even if accidentally allowlisted.
 */
export const PERMANENT_DENYLIST: readonly string[] = [
  'linkedin.com',
  'indeed.com',
] as const;

/**
 * Checks whether a given hostname or domain matches any denylisted domain or subdomain.
 */
export function isDenylisted(hostname: string): boolean {
  if (!hostname) return true;
  const cleanHost = hostname.toLowerCase().trim().replace(/^www\./, '');

  for (const denied of PERMANENT_DENYLIST) {
    if (cleanHost === denied || cleanHost.endsWith(`.${denied}`)) {
      return true;
    }
  }

  return false;
}
