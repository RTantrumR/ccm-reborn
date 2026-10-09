import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Campaign } from "./types";

// The Tauri bridge and the feed don't exist under vitest; the flow's own decisions are what's tested.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const recheckArchiveMod = vi.fn();
vi.mock("./archive", () => ({ recheckArchiveMod: (id: string) => recheckArchiveMod(id) }));

const { withCurrentPackage } = await import("./install-flow");

const MISMATCH = "The downloaded archive does not match the catalog SHA-256. Installation stopped.";

const mod = (id: string, sha256: string): Campaign => ({
  id, title: "The Creeping Swarm", author: "A", version: "1.0", description: "", tags: [],
  requirements: { campaign: "Heart of the Swarm" },
  package: { source: "https://drive.google.com/file/d/x/view", sha256, size: 10 },
});

const flow = { setActivity: vi.fn(), setMessage: vi.fn(), render: vi.fn() } as never;

describe("withCurrentPackage", () => {
  beforeEach(() => recheckArchiveMod.mockReset());

  it("runs the work once when the download matches", async () => {
    const work = vi.fn().mockResolvedValue("installed");
    expect(await withCurrentPackage(flow, mod("archive-swarm", "aaa"), work)).toBe("installed");
    expect(work).toHaveBeenCalledTimes(1);
    expect(recheckArchiveMod).not.toHaveBeenCalled();
  });

  it("asks the feed to look again and retries with the new file", async () => {
    recheckArchiveMod.mockResolvedValue({ campaign: mod("archive-swarm", "bbb"), problem: null });
    const work = vi.fn().mockRejectedValueOnce(new Error(MISMATCH)).mockResolvedValueOnce("installed");
    expect(await withCurrentPackage(flow, mod("archive-swarm", "aaa"), work)).toBe("installed");
    expect(recheckArchiveMod).toHaveBeenCalledWith("archive-swarm");
    expect(work).toHaveBeenLastCalledWith(expect.objectContaining({ package: expect.objectContaining({ sha256: "bbb" }) }));
  });

  it("keeps the download's own error when the entry hasn't changed", async () => {
    recheckArchiveMod.mockResolvedValue({ campaign: mod("archive-swarm", "aaa"), problem: null });
    const work = vi.fn().mockRejectedValue(new Error(MISMATCH));
    await expect(withCurrentPackage(flow, mod("archive-swarm", "aaa"), work)).rejects.toThrow(MISMATCH);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("says why when the new file can't be installed", async () => {
    recheckArchiveMod.mockResolvedValue({ campaign: mod("archive-swarm", ""), problem: "the download can't be installed: it has no metadata.txt" });
    const work = vi.fn().mockRejectedValue(new Error(MISMATCH));
    await expect(withCurrentPackage(flow, mod("archive-swarm", "aaa"), work)).rejects.toThrow("can't be installed any more: the download can't be installed: it has no metadata.txt");
  });

  it("leaves catalog mods and other errors alone", async () => {
    const work = vi.fn().mockRejectedValue(new Error(MISMATCH));
    await expect(withCurrentPackage(flow, mod("catalog-mod", "aaa"), work)).rejects.toThrow(MISMATCH);
    const other = vi.fn().mockRejectedValue(new Error("StarCraft II is running."));
    await expect(withCurrentPackage(flow, mod("archive-swarm", "aaa"), other)).rejects.toThrow("running");
    expect(recheckArchiveMod).not.toHaveBeenCalled();
  });
});
