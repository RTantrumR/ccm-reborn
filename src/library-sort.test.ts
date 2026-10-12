import { describe, expect, it } from "vitest";
import { postedAt, sortLibrary } from "./library-sort";
import type { Campaign } from "./types";

const mod = (id: string, title: string, updatedAt?: string, post?: string): Campaign => ({
  id, title, author: "A", version: "1", description: "", tags: [],
  requirements: { campaign: "Heart of the Swarm" },
  package: { source: "", sha256: "", size: 0 },
  link: { download: "https://example.invalid", docs: null, post: post ?? null },
  updatedAt,
});

describe("library sort", () => {
  it("reads a post's time from its Discord id", () => {
    // Discord's documented example: 175928847299117063 was made at 2016-04-30T11:18:25.796Z.
    expect(postedAt("https://discord.com/channels/1/2/175928847299117063")).toBe(Date.parse("2016-04-30T11:18:25.796Z"));
    expect(postedAt(null)).toBeNull();
    expect(postedAt("https://discord.com/channels/1/2/not-an-id")).toBeNull();
  });

  it("orders by update, post date and name, missing dates last", () => {
    const old = mod("old", "beta", "2026-10-01T00:00:00Z", "https://discord.com/channels/1/2/175928847299117063");
    const recent = mod("recent", "Alpha", "2026-10-12T00:00:00Z", "https://discord.com/channels/1/2/1100000000000000000");
    const bare = mod("bare", "Gamma");
    expect(sortLibrary([bare, old, recent], "updated").map((item) => item.id)).toEqual(["recent", "old", "bare"]);
    expect(sortLibrary([bare, old, recent], "posted").map((item) => item.id)).toEqual(["recent", "old", "bare"]);
    expect(sortLibrary([bare, old, recent], "name").map((item) => item.id)).toEqual(["recent", "old", "bare"]);
    expect(sortLibrary([old, bare, recent], "name").map((item) => item.title)).toEqual(["Alpha", "beta", "Gamma"]);
  });
});
