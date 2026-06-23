import { fetchCustomerFieldOptions } from "@/lib/jira";

/**
 * Maps Grafana tenant slugs (e.g. "bcgprod") to JIRA Customer-field display
 * names (e.g. "BCG"), so metrics/alerts join to the right tickets and show a
 * human name. The authoritative name list comes from the Customer field's
 * allowed values; matching is normalization-based with a manual override escape
 * hatch. Pure matchers are unit-tested; the fetch is cached.
 */

/** Manual overrides for slugs that don't match by normalization. Override wins. */
export const TENANT_NAME_OVERRIDES: Record<string, string> = {};

/** Env/region tokens stripped from the tail of a slug before matching. */
const ENV_SUFFIXES = ["production", "prod", "staging", "stg", "sandbox", "sbx", "dev", "test", "cp"];

/** Normalize a display name to a comparable key: lowercase, alphanumerics only. */
export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Normalize a tenant slug for matching: alnum-only, then strip trailing env tokens. */
export function normalizeSlugForMatch(slug: string): string {
  let k = normalizeKey(slug);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of ENV_SUFFIXES) {
      if (k.length > suf.length && k.endsWith(suf)) {
        k = k.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  return k;
}

/** Title-case fallback display name when no customer match is found. */
export function prettifySlug(slug: string): string {
  const base = slug.replace(/[-_](prod|production|staging|stg|dev|test|sandbox|sbx|cp)$/i, "");
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * PURE. Match a tenant slug to one of the customer display names, or null.
 * Strategy (precision-first): exact normalized equality, then a guarded unique
 * containment match (target length >= 5 and exactly one candidate) to catch
 * env-suffixed/partial slugs without risking a wrong join.
 */
export function matchCustomerName(slug: string, customers: string[]): string | null {
  const target = normalizeSlugForMatch(slug);
  if (!target) return null;
  const normed = customers.map((c) => [c, normalizeKey(c)] as const).filter(([, n]) => n.length > 0);

  const exact = normed.filter(([, n]) => n === target);
  if (exact.length === 1) return exact[0][0];
  if (exact.length > 1) return null; // ambiguous — don't guess

  if (target.length >= 5) {
    const contained = normed.filter(
      ([, n]) => n.length >= 5 && (n.startsWith(target) || target.startsWith(n)),
    );
    if (contained.length === 1) return contained[0][0];
  }
  return null;
}

/**
 * PURE. Resolve a tenant slug to its display name: manual override, else a
 * customer-list match, else a prettified slug.
 */
export function resolveDisplayName(
  slug: string,
  customers: string[] = [],
  overrides: Record<string, string> = TENANT_NAME_OVERRIDES,
): string {
  if (overrides[slug]) return overrides[slug];
  return matchCustomerName(slug, customers) ?? prettifySlug(slug);
}

/** A bound resolver over a fixed customer list (for the fleet, which resolves many slugs). */
export function makeNameResolver(
  customers: string[],
  overrides: Record<string, string> = TENANT_NAME_OVERRIDES,
): (slug: string) => string {
  return (slug: string) => resolveDisplayName(slug, customers, overrides);
}

// --- cached customer-name list -------------------------------------------------

let _cache: { names: string[]; at: number } | null = null;
const TTL_MS = 60 * 60 * 1000; // 1h

/** Customer display names from JIRA, cached in-memory for an hour. [] on failure. */
export async function fetchCustomerNames(now: number = Date.now()): Promise<string[]> {
  if (_cache && now - _cache.at < TTL_MS) return _cache.names;
  try {
    const names = await fetchCustomerFieldOptions();
    _cache = { names, at: now };
    return names;
  } catch (e) {
    console.warn("[tenant-mapping] customer options fetch failed:", e instanceof Error ? e.message : e);
    return _cache?.names ?? [];
  }
}
