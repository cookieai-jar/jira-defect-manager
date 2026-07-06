import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the JIRA I/O so we can assert the route's guard behavior without any network.
vi.mock("@/lib/jira", () => ({ fetchRoadmapIssue: vi.fn(), addIssueComment: vi.fn() }));

import { POST } from "@/app/api/fr/roadmap/ping/route";
import { fetchRoadmapIssue, addIssueComment } from "@/lib/jira";
import type { RoadmapIssueInput } from "@/lib/fr-roadmap";

const req = (body: unknown) =>
  new Request("http://x/api/fr/roadmap/ping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const issue = (over: Partial<RoadmapIssueInput> = {}): RoadmapIssueInput => ({
  key: "EAC-1",
  summary: "s",
  status: "Backlog",
  statusCategory: "new",
  issueType: "Epic",
  parentKey: "FR-1",
  targetedMonth: null,
  dependencies: [],
  missingFields: ["Sprint"],
  assignee: { accountId: "acc-1", displayName: "Ada" },
  pingCount: 0,
  lastPingedAt: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("POST /api/fr/roadmap/ping", () => {
  it("rejects an invalid issueKey with 400 and never touches JIRA", async () => {
    const res = await POST(req({ issueKey: "not a key!" }));
    expect(res.status).toBe(400);
    expect(fetchRoadmapIssue).not.toHaveBeenCalled();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it("does NOT comment when the epic has no missing fields (the anti-spam guard)", async () => {
    vi.mocked(fetchRoadmapIssue).mockResolvedValue(issue({ missingFields: [] }));
    const res = await POST(req({ issueKey: "EAC-1" }));
    expect(await res.json()).toMatchObject({ ok: true, posted: false });
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it("posts exactly one ADF comment when fields are missing", async () => {
    vi.mocked(fetchRoadmapIssue).mockResolvedValue(issue());
    const res = await POST(req({ issueKey: "EAC-1" }));
    expect(await res.json()).toMatchObject({ ok: true, posted: true, assignee: "Ada" });
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    expect(addIssueComment).toHaveBeenCalledWith("EAC-1", expect.objectContaining({ type: "doc" }));
  });
});
