import { describe, it, expect } from "vitest";
import { toDatasourceRow, dbTenantCandidates } from "@/lib/metrics-db";

describe("dbTenantCandidates", () => {
  it("tries the RAW slug first (exact, unambiguous) then the env-stripped form", () => {
    expect(dbTenantCandidates("bcgprod")).toEqual(["bcgprod", "bcg"]); // raw first, then bcg
  });
  it("dedupes when the slug is already normalized", () => {
    expect(dbTenantCandidates("tempus")).toEqual(["tempus"]);
  });
  it("only ever returns SQL-safe candidates (injection chars stripped by normalization)", () => {
    const cands = dbTenantCandidates("bad'; DROP TABLE datasources;--");
    // the raw slug (with quotes/semicolons/spaces) is excluded by isSafeIdentifier;
    // the normalized form is alnum-only, so whatever reaches SQL can't break the quotes.
    expect(cands.every((c) => /^[a-zA-Z0-9_-]+$/.test(c))).toBe(true);
    expect(cands.some((c) => c.includes("'") || c.includes(";") || c.includes(" "))).toBe(false);
  });
});

describe("toDatasourceRow", () => {
  const nowSec = 1_800_000_000;
  it("shapes a raw row, coerces numeric epochs, and computes sync age", () => {
    const r = toDatasourceRow(
      {
        name: "Azure Blob (sub 1)",
        datasource_type: "extractor",
        agent_type: "azure_blob",
        sync_status: "PERMISSION_DENIED",
        parse_status: "SUCCESS",
        sync_error_reason: "UNKNOWN",
        synced_at_success: (nowSec - 3600) * 1000, // 1h ago, in ms
        outdated: true,
      },
      nowSec,
    );
    expect(r.agentType).toBe("azure_blob");
    expect(r.syncStatus).toBe("PERMISSION_DENIED");
    expect(r.syncError).toBe("UNKNOWN");
    expect(r.lastSyncAgeSec).toBe(3600);
    expect(r.outdated).toBe(true);
  });
  it("treats 0/null sync timestamps as 'never' (null age) and missing fields as empty/unknown", () => {
    const r = toDatasourceRow({ name: "x", synced_at_success: 0, sync_error_reason: null }, nowSec);
    expect(r.lastSyncAgeSec).toBeNull();
    expect(r.syncError).toBeNull();
    expect(r.syncStatus).toBe("UNKNOWN");
    expect(r.outdated).toBe(false);
  });
  it("accepts string-encoded bigints from the postgres proxy", () => {
    const r = toDatasourceRow({ name: "y", synced_at_success: String((nowSec - 60) * 1000) }, nowSec);
    expect(r.lastSyncAgeSec).toBe(60);
  });
});
