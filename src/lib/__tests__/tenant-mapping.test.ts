import { describe, it, expect } from "vitest";
import {
  normalizeKey,
  normalizeSlugForMatch,
  prettifySlug,
  matchCustomerName,
  resolveDisplayName,
  makeNameResolver,
} from "@/lib/tenant-mapping";

// A realistic slice of the real 165-name Customer option list.
const CUSTOMERS = [
  "BCG",
  "Bain Capital",
  "Children's Health",
  "Customer's Bank",
  "Capital One",
  "American Express GBT",
  "Smurfit Westrock",
  "AON",
  "Home Partners Inc",
];

describe("normalizeKey", () => {
  it("lowercases and strips non-alphanumerics", () => {
    expect(normalizeKey("BCG")).toBe("bcg");
    expect(normalizeKey("Children's Health")).toBe("childrenshealth");
    expect(normalizeKey("Customer's Bank")).toBe("customersbank");
    expect(normalizeKey("American Express GBT")).toBe("americanexpressgbt");
  });
});

describe("normalizeSlugForMatch", () => {
  it("strips trailing env tokens (with or without separators)", () => {
    expect(normalizeSlugForMatch("bcgprod")).toBe("bcg");
    expect(normalizeSlugForMatch("customersbank-prod")).toBe("customersbank");
    expect(normalizeSlugForMatch("tenant-staging")).toBe("tenant");
    expect(normalizeSlugForMatch("foo-prod-cp")).toBe("foo"); // strips both cp then prod
    expect(normalizeSlugForMatch("wajax")).toBe("wajax"); // nothing to strip
  });
  it("does not empty a slug that is only an env word", () => {
    expect(normalizeSlugForMatch("prod")).toBe("prod");
  });
});

describe("matchCustomerName", () => {
  it("matches acronym/exact after env strip", () => {
    expect(matchCustomerName("bcgprod", CUSTOMERS)).toBe("BCG");
    expect(matchCustomerName("childrenshealth", CUSTOMERS)).toBe("Children's Health");
    expect(matchCustomerName("customersbank-prod", CUSTOMERS)).toBe("Customer's Bank");
    expect(matchCustomerName("smurfitwestrock", CUSTOMERS)).toBe("Smurfit Westrock");
    expect(matchCustomerName("capitalone", CUSTOMERS)).toBe("Capital One");
  });
  it("matches via guarded unique containment", () => {
    // slug normalizes to "homepartners"; customer "Home Partners Inc" -> "homepartnersinc" startsWith it
    expect(matchCustomerName("homepartners-prod", CUSTOMERS)).toBe("Home Partners Inc");
  });
  it("returns null when there is no confident match", () => {
    expect(matchCustomerName("live", CUSTOMERS)).toBeNull();
    expect(matchCustomerName("escalations-team", CUSTOMERS)).toBeNull();
    expect(matchCustomerName("aon", ["AON"])).toBe("AON"); // exact still works for short
  });
  it("refuses ambiguous exact matches (two customers normalize the same)", () => {
    expect(matchCustomerName("bcg", ["BCG", "B.C.G."])).toBeNull();
  });
  it("does not containment-match on short targets", () => {
    // "cap" (len 3) must NOT match "Capital One"
    expect(matchCustomerName("cap", CUSTOMERS)).toBeNull();
  });
  it("returns null for empty inputs", () => {
    expect(matchCustomerName("bcgprod", [])).toBeNull();
    expect(matchCustomerName("", CUSTOMERS)).toBeNull();
  });
});

describe("prettifySlug", () => {
  it("strips env suffix and title-cases", () => {
    expect(prettifySlug("home-partners-prod")).toBe("Home Partners");
    expect(prettifySlug("wajax")).toBe("Wajax");
  });
});

describe("resolveDisplayName", () => {
  it("override wins, then match, then prettified fallback", () => {
    expect(resolveDisplayName("anything", CUSTOMERS, { anything: "Override" })).toBe("Override");
    expect(resolveDisplayName("bcgprod", CUSTOMERS)).toBe("BCG");
    expect(resolveDisplayName("acme-corp-prod", CUSTOMERS)).toBe("Acme Corp"); // no match -> prettify
    expect(resolveDisplayName("bcgprod", [])).toBe("Bcgprod"); // no list, no override -> prettify
  });
});

describe("makeNameResolver", () => {
  it("binds a customer list into a reusable resolver", () => {
    const r = makeNameResolver(CUSTOMERS);
    expect(r("bcgprod")).toBe("BCG");
    expect(r("live")).toBe("Live");
  });
});
