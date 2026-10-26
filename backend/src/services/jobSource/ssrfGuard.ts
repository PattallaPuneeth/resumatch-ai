import dns from 'dns';
import { isDenylisted } from './denylist.js';

export interface SsrfValidationResult {
  safe: boolean;
  reason?: string;
  resolvedIp?: string;
}

/**
 * Checks whether an IPv4 address falls into private, loopback, link-local, or reserved ranges.
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IP treated as unsafe
  }

  const [b0, b1] = parts;

  // 0.0.0.0/8 (Current network)
  if (b0 === 0) return true;

  // 10.0.0.0/8 (RFC 1918 Private)
  if (b0 === 10) return true;

  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;

  // 169.254.0.0/16 (Link-local / Cloud metadata, e.g. 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 172.16.0.0/12 (RFC 1918 Private: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.168.0.0/16 (RFC 1918 Private)
  if (b0 === 192 && b1 === 168) return true;

  // 100.64.0.0/10 (Carrier-Grade NAT: 100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 198.18.0.0/15 (Benchmark testing)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;

  // 224.0.0.0/4 (Multicast)
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 (Reserved / Future use)
  if (b0 >= 240) return true;

  return false;
}

/**
 * Checks whether an IPv6 address falls into loopback, unspecified, link-local, ULA, or mapped ranges.
 */
export function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Loopback & Unspecified
  if (normalized === '::1' || normalized === '::' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:192.0.2.128 or ::ffff:c000:0280)
  if (normalized.startsWith('::ffff:') || normalized.includes(':ffff:')) {
    const lastPart = normalized.split(':').pop() || '';
    if (lastPart.includes('.')) {
      return isPrivateOrReservedIpv4(lastPart);
    }
    return true;
  }

  // Link-local (fe80::/10 -> fe80 to febf)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  // Unique Local Address (fc00::/7 -> fc00 to fdff)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  // IPv4/IPv6 translation (64:ff9b::/96)
  if (normalized.startsWith('64:ff9b:')) {
    return true;
  }

  return false;
}

/**
 * Validates an outbound or returned URL against SSRF vulnerabilities.
 *
 * NOTE ON HTTP REDIRECTS:
 * In ResuMatch AI, our backend does NOT crawl or fetch arbitrary HTML directly from the open web;
 * Firecrawl (or another swappable external search service) executes searches and page crawls remotely.
 * Because Firecrawl performs crawl-side fetches and redirect follows remotely, our application never
 * directly follows external HTTP redirects. Instead, EVERY URL returned from external search or scraping
 * (initial or redirected canonical target) is strictly validated on arrival by validateUrlForSsrf before
 * the content is parsed, cached in PostgreSQL, or returned to clients.
 *
 * Checks performed:
 * - Restricts protocol to http: and https:
 * - Rejects embedded credentials in URL
 * - Restricts ports to standard 80 and 443
 * - Checks permanent denylist (e.g. linkedin.com, indeed.com)
 * - Checks configurable domain allowlist
 * - Resolves DNS and blocks private/loopback/link-local/metadata IPs on all returned IPs
 */
export async function validateUrlForSsrf(
  urlString: string,
  allowlist?: string[]
): Promise<SsrfValidationResult> {
  if (!urlString || typeof urlString !== 'string') {
    return { safe: false, reason: 'Empty or invalid URL' };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Malformed URL' };
  }

  // 1. Protocol check
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
  }

  // 2. Reject credentials in URL
  if (parsed.username || parsed.password) {
    return { safe: false, reason: 'URL credentials not allowed' };
  }

  // 3. Port check
  const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) {
    return { safe: false, reason: `Disallowed non-standard port: ${port}` };
  }

  const hostname = parsed.hostname.toLowerCase().trim();

  // 4. Permanent Denylist check
  if (isDenylisted(hostname)) {
    return { safe: false, reason: `Domain "${hostname}" is prohibited on permanent scraping denylist` };
  }

  // 5. Configurable Allowlist check (if allowlist provided and non-empty)
  if (allowlist && allowlist.length > 0) {
    const cleanAllowlist = allowlist.map((d) => d.toLowerCase().trim().replace(/^www\./, ''));
    const matched = cleanAllowlist.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`)
    );
    if (!matched) {
      return { safe: false, reason: `Domain "${hostname}" is not in the configured domain allowlist` };
    }
  }

  // 6. Direct IP literal checks
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    if (isPrivateOrReservedIpv4(hostname)) {
      return { safe: false, reason: `Direct access to private or reserved IP "${hostname}" is blocked`, resolvedIp: hostname };
    }
    return { safe: true, resolvedIp: hostname };
  }

  if (hostname.includes(':') || hostname.startsWith('[') || hostname.endsWith(']')) {
    const rawIpv6 = hostname.replace(/^\[|\]$/g, '');
    if (isPrivateOrReservedIpv6(rawIpv6)) {
      return { safe: false, reason: `Direct access to private or reserved IPv6 "${rawIpv6}" is blocked`, resolvedIp: rawIpv6 };
    }
    return { safe: true, resolvedIp: rawIpv6 };
  }

  // 7. DNS Resolution check
  try {
    const lookupResults = await dns.promises.lookup(hostname, { all: true });
    if (!lookupResults || lookupResults.length === 0) {
      return { safe: false, reason: `Could not resolve hostname "${hostname}"` };
    }

    for (const record of lookupResults) {
      const { address, family } = record;
      if (family === 4 && isPrivateOrReservedIpv4(address)) {
        return {
          safe: false,
          reason: `Hostname "${hostname}" resolved to private IPv4 address "${address}"`,
          resolvedIp: address,
        };
      }
      if (family === 6 && isPrivateOrReservedIpv6(address)) {
        return {
          safe: false,
          reason: `Hostname "${hostname}" resolved to private IPv6 address "${address}"`,
          resolvedIp: address,
        };
      }
    }

    return { safe: true, resolvedIp: lookupResults[0].address };
  } catch (dnsErr: any) {
    return { safe: false, reason: `DNS resolution failed for "${hostname}": ${dnsErr.message || dnsErr}` };
  }
}
