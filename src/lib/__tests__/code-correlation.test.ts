import { describe, it, expect } from "vitest";
import type { FixCommit, TicketCodeLink } from "@/types/product-defects";
import {
  areaForPath,
  buildCorrelation,
  correlationByGroup,
  extractIssueKeys,
  isExcludedFromHotspots,
  isTestFile,
  isUnownedGap,
  ownerLookup,
  ownersForPath,
  parseCodeowners,
  staleHotspots,
  unownedHotspots,
} from "@/lib/code-correlation";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function commit(sha: string, files: string[], over: Partial<FixCommit> = {}): FixCommit {
  return {
    sha,
    subject: `${sha}: fix`,
    date: "2026-01-01",
    files,
    touchesTests: files.some(isTestFile),
    ...over,
  };
}

function link(issueKey: string, commits: FixCommit[], teams: string[] = []): TicketCodeLink {
  const files = Array.from(new Set(commits.flatMap((c) => c.files))).sort();
  return { issueKey, commits, teams, files };
}

// ---------------------------------------------------------------------------
// CODEOWNERS parsing
// ---------------------------------------------------------------------------

describe("parseCodeowners", () => {
  it("skips comments and blank lines, keeps pattern order", () => {
    const rules = parseCodeowners(
      [
        "# Broad ownership rules",
        "",
        "/agents/ @cookieai-jar/integrations",
        "   ",
        "# Platform Core",
        "/controlp/modules/auth/ @cookieai-jar/platform-core",
      ].join("\n"),
    );
    expect(rules).toEqual([
      { pattern: "/agents/", teams: ["@cookieai-jar/integrations"] },
      { pattern: "/controlp/modules/auth/", teams: ["@cookieai-jar/platform-core"] },
    ]);
  });

  it("parses multi-team lines", () => {
    const rules = parseCodeowners(
      "/agents/**/lifecycle_management @cookieai-jar/lcm-integration @cookieai-jar/lcm",
    );
    expect(rules[0].teams).toEqual(["@cookieai-jar/lcm-integration", "@cookieai-jar/lcm"]);
  });

  it("keeps owner-less lines with an empty team list", () => {
    const rules = parseCodeowners(
      ["/controlp/modules/apiexplorer/ @cookieai-jar/platform-core", "/controlp/modules/apiexplorer/public/openapi.yaml"].join("\n"),
    );
    expect(rules).toHaveLength(2);
    expect(rules[1]).toEqual({
      pattern: "/controlp/modules/apiexplorer/public/openapi.yaml",
      teams: [],
    });
  });

  it("strips trailing comments after a pattern", () => {
    const rules = parseCodeowners(
      "/terraform/modules/codegen_services.tf # Don't require explicit approval",
    );
    expect(rules).toEqual([{ pattern: "/terraform/modules/codegen_services.tf", teams: [] }]);
  });

  it("treats a leading @ token as the path, not an owner", () => {
    // The real repo has scoped-package directories: /frontend/src/@mds/.
    const rules = parseCodeowners("/frontend/src/@mds/ @cookieai-jar/mds-frontend");
    expect(rules[0].pattern).toBe("/frontend/src/@mds/");
    expect(rules[0].teams).toEqual(["@cookieai-jar/mds-frontend"]);
  });

  it("accepts email owners and ignores junk tokens", () => {
    const rules = parseCodeowners("/docs/ owner@example.com notanowner @team/x");
    expect(rules[0].teams).toEqual(["owner@example.com", "@team/x"]);
  });
});

// ---------------------------------------------------------------------------
// CODEOWNERS matching
// ---------------------------------------------------------------------------

describe("ownersForPath", () => {
  it("returns [] for an unmatched path", () => {
    const rules = parseCodeowners("/agents/ @cookieai-jar/integrations");
    expect(ownersForPath(rules, "controlp/main.go")).toEqual([]);
  });

  it("matches a directory pattern for everything beneath it", () => {
    const rules = parseCodeowners("/controlp/modules/auth/ @cookieai-jar/platform-core");
    expect(ownersForPath(rules, "controlp/modules/auth/login.go")).toEqual([
      "@cookieai-jar/platform-core",
    ]);
    expect(ownersForPath(rules, "controlp/modules/auth/deep/nested/x.go")).toEqual([
      "@cookieai-jar/platform-core",
    ]);
    // sibling directory with a shared prefix must not match
    expect(ownersForPath(rules, "controlp/modules/authz/login.go")).toEqual([]);
  });

  it("treats a slash-less directory pattern as covering its subtree", () => {
    const rules = parseCodeowners(
      "/controlp/pkg/api/handlers/users @cookieai-jar/platform-core",
    );
    expect(ownersForPath(rules, "controlp/pkg/api/handlers/users/handler.go")).toEqual([
      "@cookieai-jar/platform-core",
    ]);
  });

  it("anchors root-relative patterns written without a leading slash", () => {
    const rules = parseCodeowners("controlp/internal/cookiedb/awfdb @cookieai-jar/awf-backend");
    expect(ownersForPath(rules, "controlp/internal/cookiedb/awfdb/db.go")).toEqual([
      "@cookieai-jar/awf-backend",
    ]);
    expect(ownersForPath(rules, "vendor/controlp/internal/cookiedb/awfdb/db.go")).toEqual([]);
  });

  it("matches a slash-less glob at any depth", () => {
    const rules = parseCodeowners("*.pb.go");
    expect(ownersForPath(rules, "controlp/pkg/api/v1/service.pb.go")).toEqual([]);
    const owned = parseCodeowners("*.pb.go @cookieai-jar/platform-core");
    expect(ownersForPath(owned, "a/b/c/service.pb.go")).toEqual(["@cookieai-jar/platform-core"]);
    expect(ownersForPath(owned, "a/b/c/service.go")).toEqual([]);
  });

  it("supports * within a segment and ** across segments", () => {
    const rules = parseCodeowners(
      [
        "/.github/workflows/tf_* @cookieai-jar/platform-sre",
        "/clients/oaa/connectors/**/*_lifecycle_manager.go @cookieai-jar/lcm",
        "/agents/**/lifecycle_management @cookieai-jar/lcm-integration",
      ].join("\n"),
    );
    expect(ownersForPath(rules, ".github/workflows/tf_plan.yaml")).toEqual([
      "@cookieai-jar/platform-sre",
    ]);
    expect(ownersForPath(rules, ".github/workflows/release.yaml")).toEqual([]);
    // `*` does not cross a slash
    expect(ownersForPath(rules, ".github/workflows/tf/plan.yaml")).toEqual([]);
    expect(
      ownersForPath(rules, "clients/oaa/connectors/okta/deep/okta_lifecycle_manager.go"),
    ).toEqual(["@cookieai-jar/lcm"]);
    // `**` also matches zero directories
    expect(ownersForPath(rules, "agents/lifecycle_management/run.go")).toEqual([
      "@cookieai-jar/lcm-integration",
    ]);
    expect(ownersForPath(rules, "agents/azure/azure_key_vault/lifecycle_management/x.go")).toEqual([
      "@cookieai-jar/lcm-integration",
    ]);
  });

  it("is last-match-wins", () => {
    const rules = parseCodeowners(
      [
        "/controlp/ @cookieai-jar/platform-core",
        "/controlp/internal/graph/ @cookieai-jar/graph-backend",
      ].join("\n"),
    );
    expect(ownersForPath(rules, "controlp/internal/graph/plan.go")).toEqual([
      "@cookieai-jar/graph-backend",
    ]);
    expect(ownersForPath(rules, "controlp/internal/auth/token.go")).toEqual([
      "@cookieai-jar/platform-core",
    ]);
  });

  it("lets a later owner-less line clear an earlier owner", () => {
    const rules = parseCodeowners(
      [
        "/controlp/ @cookieai-jar/platform-core",
        "# generated OpenAPI spec",
        "/controlp/modules/apiexplorer/public/openapi.yaml",
      ].join("\n"),
    );
    expect(ownersForPath(rules, "controlp/modules/apiexplorer/public/openapi.yaml")).toEqual([]);
    // the un-owning line is narrow: siblings keep the broad owner
    expect(ownersForPath(rules, "controlp/modules/apiexplorer/public/index.html")).toEqual([
      "@cookieai-jar/platform-core",
    ]);
  });

  it("re-owns a path when an owning line comes after an un-owning one", () => {
    const rules = parseCodeowners(
      ["*.pb.go", "/controlp/internal/special/service.pb.go @cookieai-jar/graph-backend"].join(
        "\n",
      ),
    );
    expect(ownersForPath(rules, "controlp/internal/special/service.pb.go")).toEqual([
      "@cookieai-jar/graph-backend",
    ]);
    expect(ownersForPath(rules, "controlp/internal/other/service.pb.go")).toEqual([]);
  });

  it("normalises leading ./ and backslashes before matching", () => {
    const rules = parseCodeowners("/agents/ @cookieai-jar/integrations");
    expect(ownersForPath(rules, "./agents/okta/run.go")).toEqual(["@cookieai-jar/integrations"]);
  });
});

describe("ownerLookup", () => {
  it("memoises and returns the same answer as ownersForPath", () => {
    const rules = parseCodeowners("/agents/ @cookieai-jar/integrations");
    const owners = ownerLookup(rules);
    expect(owners("agents/okta/run.go")).toEqual(["@cookieai-jar/integrations"]);
    expect(owners("agents/okta/run.go")).toEqual(["@cookieai-jar/integrations"]);
    expect(owners("controlp/x.go")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Issue keys
// ---------------------------------------------------------------------------

describe("extractIssueKeys", () => {
  it("pulls keys from the subject", () => {
    expect(
      extractIssueKeys(
        "EAC-67972: carry the HTTP status when a response body cannot be parsed (#52277)",
      ),
    ).toEqual(["EAC-67972"]);
  });

  it("pulls keys from the body as well as the subject, deduped and in order", () => {
    const message = [
      "EAC-67972: carry the HTTP status (#52277)",
      "",
      "* EAC-67972, EAC-67797: exchange_online: type the HTTP error",
      "EAC-67974 classified the gzip case by substring.",
      "EAC-67797: drop the auth suffix.",
    ].join("\n");
    expect(extractIssueKeys(message)).toEqual(["EAC-67972", "EAC-67797", "EAC-67974"]);
  });

  it("uppercases lowercase keys", () => {
    expect(extractIssueKeys("branch eac-123 merged")).toEqual(["EAC-123"]);
  });

  it("does not match keys glued to other tokens", () => {
    expect(extractIssueKeys("XEAC-123 and EAC-45abc and EACC-9")).toEqual([]);
  });

  it("ignores PR numbers and other projects by default", () => {
    expect(extractIssueKeys("SEC-42: something (#52277)")).toEqual([]);
  });

  it("honours an explicit project", () => {
    expect(extractIssueKeys("SEC-42: something", "SEC")).toEqual(["SEC-42"]);
    expect(extractIssueKeys("sec-42: something", "sec")).toEqual(["SEC-42"]);
  });

  it("returns [] for empty input or a bogus project", () => {
    expect(extractIssueKeys("")).toEqual([]);
    expect(extractIssueKeys("EAC-1", "EA C")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

describe("isTestFile", () => {
  it("detects Go test files", () => {
    expect(isTestFile("controlp/internal/graph/plan_test.go")).toBe(true);
    expect(isTestFile("controlp/internal/graph/plan.go")).toBe(false);
  });

  it("detects TS/TSX test and spec files", () => {
    expect(isTestFile("frontend/src/foo.test.ts")).toBe(true);
    expect(isTestFile("frontend/src/foo.test.tsx")).toBe(true);
    expect(isTestFile("frontend/src/foo.spec.ts")).toBe(true);
    expect(isTestFile("frontend/src/foo.spec.tsx")).toBe(true);
    expect(isTestFile("frontend/src/foo.ts")).toBe(false);
  });

  it("detects Python test conventions", () => {
    expect(isTestFile("python/lib/client_test.py")).toBe(true);
    expect(isTestFile("python/lib/test_client.py")).toBe(true);
    expect(isTestFile("python/lib/client.py")).toBe(false);
  });

  it("detects test directories at any depth", () => {
    expect(isTestFile("frontend/src/__tests__/foo.ts")).toBe(true);
    expect(isTestFile("test/qa/login.py")).toBe(true);
    expect(isTestFile("controlp/tests/helpers.go")).toBe(true);
    expect(isTestFile("controlp/internal/graph/testdata/schema.json")).toBe(true);
    expect(isTestFile("controlp/internal/graph/schema.json")).toBe(false);
  });

  it("does not treat a directory merely containing 'test' as a test dir", () => {
    expect(isTestFile("controlp/internal/testing_helpers/x.go")).toBe(false);
    expect(isTestFile("controlp/internal/latest/x.go")).toBe(false);
  });
});

describe("isExcludedFromHotspots", () => {
  it("excludes lockfiles", () => {
    expect(isExcludedFromHotspots("package-lock.json")).toBe(true);
    expect(isExcludedFromHotspots("frontend/yarn.lock")).toBe(true);
    expect(isExcludedFromHotspots("go.sum")).toBe(true);
    expect(isExcludedFromHotspots("k8s/containers/wolfi/base/apko.lock.json")).toBe(true);
    expect(isExcludedFromHotspots("frontend/MODULE.bazel.lock")).toBe(true);
  });

  it("excludes generated protobuf output", () => {
    expect(isExcludedFromHotspots("controlp/pkg/api/v1/service.pb.go")).toBe(true);
    expect(isExcludedFromHotspots("controlp/pkg/api/v1/service.pb.gw.go")).toBe(true);
    expect(isExcludedFromHotspots("controlp/pkg/api/v1/service_grpc.pb.go")).toBe(true);
    expect(isExcludedFromHotspots("frontend/src/network/proto/service_pb.ts")).toBe(true);
    expect(isExcludedFromHotspots("python/protos/service_pb2.py")).toBe(true);
  });

  it("excludes generated OpenAPI specs and vendored trees", () => {
    expect(isExcludedFromHotspots("controlp/modules/apiexplorer/public/openapi.yaml")).toBe(true);
    expect(isExcludedFromHotspots("api/openapi-v2.json")).toBe(true);
    expect(isExcludedFromHotspots("vendor/github.com/foo/bar.go")).toBe(true);
    expect(isExcludedFromHotspots("frontend/node_modules/react/index.js")).toBe(true);
    expect(isExcludedFromHotspots("frontend/src/generated/api.ts")).toBe(true);
    expect(isExcludedFromHotspots("third_party/zlib/zlib.c")).toBe(true);
  });

  it("keeps real source and test files", () => {
    expect(isExcludedFromHotspots("agents/okta/client/okta_client.go")).toBe(false);
    expect(isExcludedFromHotspots("agents/okta/client/okta_client_test.go")).toBe(false);
    expect(isExcludedFromHotspots("frontend/src/@cookie-core/pages/QueryBuilder/index.tsx")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Area rollup
// ---------------------------------------------------------------------------

describe("areaForPath", () => {
  it("rolls a deep path up to three directories by default", () => {
    expect(areaForPath("controlp/internal/graph/graphplanner/plan.go")).toBe(
      "controlp/internal/graph",
    );
  });

  it("collapses shallow paths to what they have", () => {
    expect(areaForPath("agents/okta/client.go")).toBe("agents/okta");
    expect(areaForPath("agents/main.go")).toBe("agents");
    expect(areaForPath("README.md")).toBe("(root)");
    expect(areaForPath("")).toBe("(root)");
  });

  it("honours an explicit depth", () => {
    expect(areaForPath("controlp/internal/graph/graphplanner/plan.go", 2)).toBe(
      "controlp/internal",
    );
    expect(areaForPath("controlp/internal/graph/graphplanner/plan.go", 1)).toBe("controlp");
    // depth is clamped to at least one directory
    expect(areaForPath("controlp/internal/graph/plan.go", 0)).toBe("controlp");
  });
});

// ---------------------------------------------------------------------------
// buildCorrelation
// ---------------------------------------------------------------------------

describe("buildCorrelation", () => {
  it("computes link rate as a 0-100 percentage to one decimal", () => {
    const links = [
      link("EAC-1", [commit("a1", ["src/a.go"])]),
      link("EAC-2", [commit("a2", ["src/b.go"])]),
    ];
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: "deadbeef",
      allIssueKeys: ["EAC-1", "EAC-2", "EAC-3"],
      links,
    });
    expect(c.totalTickets).toBe(3);
    expect(c.linkedTickets).toBe(2);
    expect(c.linkRate).toBe(66.7);
    expect(c.repoHead).toBe("deadbeef");
  });

  it("handles an empty population without dividing by zero", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: [],
      links: [],
    });
    expect(c.totalTickets).toBe(0);
    expect(c.linkRate).toBe(0);
    expect(c.fileHotspots).toEqual([]);
  });

  it("drops links with no commits and links outside the population", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2"],
      links: [
        link("EAC-1", [commit("a1", ["src/a.go"])]),
        link("EAC-2", []),
        link("EAC-99", [commit("a3", ["src/a.go"])]),
      ],
    });
    expect(c.linkedTickets).toBe(1);
    expect(c.links.map((l) => l.issueKey)).toEqual(["EAC-1"]);
  });

  it("ranks hotspots by distinct defects, so one wide commit cannot dominate", () => {
    // EAC-1 is a single sweeping refactor across 40 files.
    const wide = Array.from({ length: 40 }, (_, i) => `src/sweep/file${i}.go`);
    const links = [
      link("EAC-1", [commit("wide", wide)]),
      // Five separate defects all land on the same one file.
      ...[2, 3, 4, 5, 6].map((n) =>
        link(`EAC-${n}`, [commit(`c${n}`, ["src/hot/parser.go"])]),
      ),
    ];
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2", "EAC-3", "EAC-4", "EAC-5", "EAC-6"],
      links,
    });
    expect(c.fileHotspots[0]).toMatchObject({
      path: "src/hot/parser.go",
      defectCount: 5,
      fileCount: 1,
    });
    expect(c.fileHotspots[0].issueKeys).toEqual([
      "EAC-2",
      "EAC-3",
      "EAC-4",
      "EAC-5",
      "EAC-6",
    ]);
    // Every sweep file is stuck at one distinct defect.
    for (const h of c.fileHotspots.slice(1)) expect(h.defectCount).toBe(1);
  });

  it("ranks areas by distinct defects and counts distinct files", () => {
    const links = [
      link("EAC-1", [commit("c1", ["agents/okta/a.go", "agents/okta/b.go"])]),
      link("EAC-2", [commit("c2", ["agents/okta/a.go"])]),
      link("EAC-3", [commit("c3", ["controlp/internal/graph/plan.go"])]),
    ];
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2", "EAC-3"],
      links,
    });
    expect(c.areaHotspots[0]).toMatchObject({
      path: "agents/okta",
      defectCount: 2,
      fileCount: 2,
    });
  });

  it("keeps generated files in links but out of the ranked hotspots", () => {
    const links = [
      link("EAC-1", [commit("c1", ["api/service.pb.go", "api/service.go"])]),
      link("EAC-2", [commit("c2", ["api/service.pb.go"])]),
      link("EAC-3", [commit("c3", ["api/service.pb.go"])]),
    ];
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2", "EAC-3"],
      links,
    });
    expect(c.links[0].files).toContain("api/service.pb.go");
    expect(c.fileHotspots.map((h) => h.path)).toEqual(["api/service.go"]);
  });

  it("honours topN on both hotspot lists", () => {
    const links = Array.from({ length: 10 }, (_, i) =>
      link(`EAC-${i}`, [commit(`c${i}`, [`area${i}/file${i}.go`])]),
    );
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: links.map((l) => l.issueKey),
      links,
      topN: 3,
    });
    expect(c.fileHotspots).toHaveLength(3);
    expect(c.areaHotspots).toHaveLength(3);
  });

  it("splits distinct fix commits into with/without tests", () => {
    const shared = commit("shared", ["src/a.go", "src/a_test.go"]);
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2", "EAC-3"],
      links: [
        // the same commit references two tickets — it must be counted once
        link("EAC-1", [shared]),
        link("EAC-2", [shared]),
        link("EAC-3", [commit("bare", ["src/b.go"])]),
      ],
    });
    expect(c.fixesWithTests).toBe(1);
    expect(c.fixesWithoutTests).toBe(1);
  });

  it("uses per-file CODEOWNERS attribution when an owner lookup is supplied", () => {
    const rules = parseCodeowners(
      [
        "/agents/ @cookieai-jar/integrations",
        "/frontend/ @cookieai-jar/cookieai-frontend",
      ].join("\n"),
    );
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1"],
      links: [link("EAC-1", [commit("c1", ["agents/okta/run.go", "frontend/src/app.tsx"])])],
      owners: ownerLookup(rules),
    });
    const hotspot = c.fileHotspots.find((h) => h.path === "agents/okta/run.go");
    expect(hotspot?.teams).toEqual(["@cookieai-jar/integrations"]);
    const teams = c.byTeam.map((t) => t.team).sort();
    expect(teams).toEqual(["@cookieai-jar/cookieai-frontend", "@cookieai-jar/integrations"]);
    for (const t of c.byTeam) expect(t.fileCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// testChangeRate
// ---------------------------------------------------------------------------

describe("TeamCodeStats.testChangeRate", () => {
  const rules = parseCodeowners(
    ["/agents/ @cookieai-jar/integrations", "/frontend/ @cookieai-jar/cookieai-frontend"].join(
      "\n",
    ),
  );

  it("is the share of the team's fix commits that touched a test file", () => {
    const links = [
      link("EAC-1", [commit("c1", ["agents/a.go", "agents/a_test.go"])]),
      link("EAC-2", [commit("c2", ["agents/b.go"])]),
      link("EAC-3", [commit("c3", ["agents/c.go"])]),
      link("EAC-4", [commit("c4", ["agents/d.go", "agents/__tests__/d.ts"])]),
    ];
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: links.map((l) => l.issueKey),
      links,
      owners: ownerLookup(rules),
    });
    const team = c.byTeam.find((t) => t.team === "@cookieai-jar/integrations");
    expect(team).toBeDefined();
    expect(team?.commitCount).toBe(4);
    expect(team?.defectCount).toBe(4);
    expect(team?.testChangeRate).toBe(50);
  });

  it("rounds to one decimal", () => {
    // 1 of 3 commits touches a test → 33.3%
    const links = [1, 2, 3].map((n) =>
      link(`EAC-${n}`, [commit(`c${n}`, n === 1 ? ["agents/a.go", "agents/a_test.go"] : [`agents/f${n}.go`])]),
    );
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: links.map((l) => l.issueKey),
      links,
      owners: ownerLookup(rules),
    });
    expect(c.byTeam[0].testChangeRate).toBe(33.3);
  });

  it("counts a commit spanning two tickets once", () => {
    const shared = commit("shared", ["agents/a.go", "agents/a_test.go"]);
    const other = commit("other", ["agents/b.go"]);
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2"],
      links: [link("EAC-1", [shared, other]), link("EAC-2", [shared])],
      owners: ownerLookup(rules),
    });
    const team = c.byTeam[0];
    expect(team.commitCount).toBe(2);
    expect(team.testChangeRate).toBe(50);
  });

  it("attributes a cross-team commit to both teams", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1"],
      links: [
        link("EAC-1", [
          commit("c1", ["agents/a.go", "agents/a_test.go", "frontend/src/app.tsx"]),
        ]),
      ],
      owners: ownerLookup(rules),
    });
    // touchesTests is a property of the commit, so both owning teams see 100%
    for (const t of c.byTeam) {
      expect(t.commitCount).toBe(1);
      expect(t.testChangeRate).toBe(100);
    }
  });

  it("is 0 when no commit touched a test", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1"],
      links: [link("EAC-1", [commit("c1", ["agents/a.go"])])],
      owners: ownerLookup(rules),
    });
    expect(c.byTeam[0].testChangeRate).toBe(0);
  });

  it("falls back to ticket-level team attribution without an owner lookup", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1"],
      links: [
        link("EAC-1", [commit("c1", ["agents/a.go", "agents/a_test.go"])], [
          "@cookieai-jar/integrations",
        ]),
      ],
    });
    expect(c.byTeam).toHaveLength(1);
    expect(c.byTeam[0]).toMatchObject({
      team: "@cookieai-jar/integrations",
      commitCount: 1,
      testChangeRate: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// correlationByGroup
// ---------------------------------------------------------------------------

describe("correlationByGroup", () => {
  const base = buildCorrelation({
    repoPath: "/repo",
    repoHead: null,
    allIssueKeys: ["EAC-1", "EAC-2", "EAC-3", "EAC-4"],
    links: [
      link("EAC-1", [commit("c1", ["agents/okta/run.go"])], ["@cookieai-jar/integrations"]),
      link("EAC-2", [commit("c2", ["agents/okta/run.go"])], ["@cookieai-jar/integrations"]),
      link(
        "EAC-3",
        [commit("c3", ["controlp/internal/graph/plan.go"])],
        ["@cookieai-jar/graph-backend"],
      ),
      link("EAC-4", [commit("c4", ["frontend/src/app.tsx"])], ["@cookieai-jar/cookieai-frontend"]),
    ],
  });

  it("restricts hotspots to the group's issue keys", () => {
    const [connector, graph] = correlationByGroup(base, [
      { key: "connector-auth", issueKeys: ["EAC-1", "EAC-2"] },
      { key: "graph-query", issueKeys: ["EAC-3"] },
    ]);

    expect(connector.groupKey).toBe("connector-auth");
    expect(connector.linkedTickets).toBe(2);
    expect(connector.fileHotspots).toHaveLength(1);
    expect(connector.fileHotspots[0]).toMatchObject({
      path: "agents/okta/run.go",
      defectCount: 2,
    });
    expect(connector.areaHotspots[0].path).toBe("agents/okta");
    expect(connector.teams).toEqual(["@cookieai-jar/integrations"]);

    expect(graph.linkedTickets).toBe(1);
    expect(graph.fileHotspots.map((h) => h.path)).toEqual(["controlp/internal/graph/plan.go"]);
    expect(graph.teams).toEqual(["@cookieai-jar/graph-backend"]);
  });

  it("ignores issue keys with no code link and unknown keys", () => {
    const [group] = correlationByGroup(base, [
      { key: "mixed", issueKeys: ["EAC-1", "EAC-9999", "eac-4"] },
    ]);
    expect(group.linkedTickets).toBe(2); // EAC-1 and (case-normalised) EAC-4
    expect(group.teams).toEqual([
      "@cookieai-jar/cookieai-frontend",
      "@cookieai-jar/integrations",
    ]);
  });

  it("returns an empty shape for a group with no linked tickets", () => {
    const [group] = correlationByGroup(base, [{ key: "empty", issueKeys: ["EAC-9999"] }]);
    expect(group).toEqual({
      groupKey: "empty",
      teams: [],
      areaHotspots: [],
      fileHotspots: [],
      linkedTickets: 0,
    });
  });

  it("honours topN", () => {
    const [group] = correlationByGroup(
      base,
      [{ key: "all", issueKeys: ["EAC-1", "EAC-2", "EAC-3", "EAC-4"] }],
      1,
    );
    expect(group.fileHotspots).toHaveLength(1);
    expect(group.fileHotspots[0].path).toBe("agents/okta/run.go");
  });

  it("accepts richer group objects (DefectGroup structurally satisfies the shape)", () => {
    const groups = [
      { key: "connector-auth", name: "Connector auth", issueKeys: ["EAC-1"], ticketCount: 1 },
    ];
    expect(correlationByGroup(base, groups)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// existsAtHead — hotspots come from history, so hot paths may since be gone
// ---------------------------------------------------------------------------

describe("existsAtHead marking", () => {
  const links = [
    link("EAC-1", [commit("c1", ["live/kept.go", "gone/deleted.go"])]),
    link("EAC-2", [commit("c2", ["live/kept.go"])]),
  ];
  const present = new Set(["live/kept.go", "live"]);
  const existsAtHead = (p: string) => present.has(p);

  it("stamps existsAtHead on every ranked file and area hotspot", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: "abc",
      allIssueKeys: ["EAC-1", "EAC-2"],
      links,
      existsAtHead,
    });
    const kept = c.fileHotspots.find((h) => h.path === "live/kept.go");
    const gone = c.fileHotspots.find((h) => h.path === "gone/deleted.go");
    expect(kept?.existsAtHead).toBe(true);
    expect(gone?.existsAtHead).toBe(false);

    expect(c.areaHotspots.find((h) => h.path === "live")?.existsAtHead).toBe(true);
    expect(c.areaHotspots.find((h) => h.path === "gone")?.existsAtHead).toBe(false);
  });

  it("leaves existsAtHead undefined when no predicate is supplied", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2"],
      links,
    });
    for (const h of [...c.fileHotspots, ...c.areaHotspots]) {
      expect(h.existsAtHead).toBeUndefined();
    }
  });

  it("leaves existsAtHead undefined when the predicate cannot tell", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1"],
      links,
      existsAtHead: () => undefined,
    });
    expect(c.fileHotspots[0].existsAtHead).toBeUndefined();
  });

  it("never marks the synthetic (root) area as deleted", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1"],
      links: [link("EAC-1", [commit("c1", [".gitattributes"])])],
      // the HEAD snapshot has no entry called "(root)" — it is not a real path
      existsAtHead: (p) => p === ".gitattributes",
    });
    const root = c.areaHotspots.find((h) => h.path === "(root)");
    expect(root?.existsAtHead).toBe(true);
    expect(staleHotspots(c.areaHotspots)).toEqual([]);
  });

  it("does not change hotspot ranking", () => {
    const withMark = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2"],
      links,
      existsAtHead,
    });
    const without = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2"],
      links,
    });
    expect(withMark.fileHotspots.map((h) => h.path)).toEqual(
      without.fileHotspots.map((h) => h.path),
    );
    // a deleted path still ranks — it is history, and the flag is the caveat
    expect(withMark.fileHotspots.map((h) => h.path)).toContain("gone/deleted.go");
  });

  it("propagates existence to group hotspots via the parent correlation", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2"],
      links,
      existsAtHead,
    });
    const [group] = correlationByGroup(c, [{ key: "g", issueKeys: ["EAC-1", "EAC-2"] }]);
    expect(group.fileHotspots.find((h) => h.path === "live/kept.go")?.existsAtHead).toBe(true);
    expect(group.fileHotspots.find((h) => h.path === "gone/deleted.go")?.existsAtHead).toBe(false);
  });

  it("recovers existence from stamped hotspots after a JSON round-trip", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2"],
      links,
      existsAtHead,
    });
    // A correlation reloaded from the DB loses object identity, so the
    // registry misses and only the stamped hotspots remain as evidence.
    const reloaded = JSON.parse(JSON.stringify(c)) as typeof c;
    const [group] = correlationByGroup(reloaded, [{ key: "g", issueKeys: ["EAC-1", "EAC-2"] }]);
    expect(group.fileHotspots.find((h) => h.path === "live/kept.go")?.existsAtHead).toBe(true);
    expect(group.fileHotspots.find((h) => h.path === "gone/deleted.go")?.existsAtHead).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unowned-code eligibility
// ---------------------------------------------------------------------------

describe("isUnownedGap", () => {
  const hotspot = (over: Partial<import("@/types/product-defects").CodeHotspot> = {}) => ({
    path: "some/path.go",
    defectCount: 3,
    issueKeys: ["EAC-1"],
    teams: [] as string[],
    fileCount: 1,
    ...over,
  });

  it("counts a path that still exists and has no owner", () => {
    expect(isUnownedGap(hotspot({ existsAtHead: true, teams: [] }))).toBe(true);
  });

  it("does NOT count a deleted path with no owner", () => {
    // The motivating bug: controlp/internal/lifecycle_management is unowned
    // only because it no longer exists. Nobody can adopt a deleted directory.
    expect(isUnownedGap(hotspot({ existsAtHead: false, teams: [] }))).toBe(false);
  });

  it("does NOT count a path whose existence is unknown", () => {
    expect(isUnownedGap(hotspot({ teams: [] }))).toBe(false);
    expect(isUnownedGap(hotspot({ existsAtHead: undefined, teams: [] }))).toBe(false);
  });

  it("does NOT count an owned path, present or not", () => {
    expect(isUnownedGap(hotspot({ existsAtHead: true, teams: ["@org/team"] }))).toBe(false);
    expect(isUnownedGap(hotspot({ existsAtHead: false, teams: ["@org/team"] }))).toBe(false);
  });
});

describe("unownedHotspots / staleHotspots", () => {
  const hotspots = [
    { path: "a.go", defectCount: 5, issueKeys: [], teams: [], fileCount: 1, existsAtHead: true },
    { path: "b.go", defectCount: 4, issueKeys: [], teams: [], fileCount: 1, existsAtHead: false },
    {
      path: "c.go",
      defectCount: 3,
      issueKeys: [],
      teams: ["@org/team"],
      fileCount: 1,
      existsAtHead: true,
    },
    { path: "d.go", defectCount: 2, issueKeys: [], teams: [], fileCount: 1 },
    {
      path: "e.go",
      defectCount: 1,
      issueKeys: [],
      teams: ["@org/team"],
      fileCount: 1,
      existsAtHead: false,
    },
  ];

  it("reports only live, unowned paths as ownership gaps", () => {
    expect(unownedHotspots(hotspots).map((h) => h.path)).toEqual(["a.go"]);
  });

  it("reports every path that has since disappeared as stale", () => {
    expect(staleHotspots(hotspots).map((h) => h.path)).toEqual(["b.go", "e.go"]);
  });

  it("tolerates empty input", () => {
    expect(unownedHotspots([])).toEqual([]);
    expect(staleHotspots([])).toEqual([]);
  });

  it("end-to-end: a deleted unowned hotspot is excluded from the gap list", () => {
    const c = buildCorrelation({
      repoPath: "/repo",
      repoHead: null,
      allIssueKeys: ["EAC-1", "EAC-2", "EAC-3"],
      links: [
        // still present, genuinely unowned → a real gap
        link("EAC-1", [commit("c1", ["live/orphan.go"])]),
        link("EAC-2", [commit("c2", ["live/orphan.go"])]),
        // deleted, and unowned only because it is gone → not a gap
        link("EAC-3", [commit("c3", ["moved/old_package.go"])]),
      ],
      owners: () => [],
      existsAtHead: (p) => p === "live/orphan.go" || p === "live",
    });
    expect(unownedHotspots(c.fileHotspots).map((h) => h.path)).toEqual(["live/orphan.go"]);
    expect(staleHotspots(c.fileHotspots).map((h) => h.path)).toEqual(["moved/old_package.go"]);
  });
});
