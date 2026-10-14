import { describe, expect, it } from "vitest";
import { authorsIn, levenshtein, searchLibrary, withAuthor } from "./library-search";
import type { Campaign } from "./types";

const mod = (id: string, title: string, author: string, description = ""): Campaign => ({
  id, title, author, version: "1", description, tags: [],
  requirements: { campaign: "Wings of Liberty" },
  package: { source: "", sha256: "", size: 0 },
});

const rogue = mod("rogue", "StarcraftRogue", "Kit", "A roguelike run through the Koprulu sector.");
const lotv = mod("lotv", "LOTV Rogue", "Aldaris Fan", "Protoss missions, remade.");
const contracts = mod("contracts", "Contingency Contracts", "Raynor Kit", "Mercenary jobs.");
const kerrigan = mod("kerrigan", "Kerrigan Reborn", "Zerus", "The Queen of Blades returns. Uses StarcraftRogue tech.");
const all = [rogue, lotv, contracts, kerrigan];
const ids = (text: string) => searchLibrary(all, text).hits.map((item) => item.id);

describe("library search", () => {
  it("counts edits", () => {
    expect(levenshtein("kerigan", "kerrigan")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("rouge", "rogue")).toBe(2);
  });

  it("keeps every mod, in order, for an empty query", () => {
    expect(ids("")).toEqual(["rogue", "lotv", "contracts", "kerrigan"]);
    expect(ids("  ,. ")).toEqual(["rogue", "lotv", "contracts", "kerrigan"]);
  });

  it("ignores case and punctuation, takes words in any order and by their start", () => {
    expect(ids("starcraft rogue")[0]).toBe("rogue");
    expect(ids("rog lotv")).toEqual(["lotv"]);
    expect(ids("CONTINGENCY-contracts")).toEqual(["contracts"]);
  });

  it("puts an exact title first, then starts-with, word starts and anywhere", () => {
    // Exact beats starts-with: "starcraftrogue" is all of one title.
    expect(ids("StarcraftRogue")).toEqual(["rogue", "kerrigan"]);
    // "rogue" starts a word of LOTV Rogue and is inside StarcraftRogue. Kerrigan Reborn's
    // description says "StarcraftRogue", which isn't the whole word.
    expect(ids("rogue")).toEqual(["lotv", "rogue"]);
  });

  it("ranks a title over an author over a description", () => {
    const named = mod("named", "Kit's Campaign", "Someone");
    const byKit = mod("by-kit", "Untitled", "Kit");
    const mentions = mod("mentions", "Other", "Nobody", "Thanks to Kit for the tools.");
    expect(searchLibrary([mentions, byKit, named], "kit").hits.map((item) => item.id)).toEqual(["named", "by-kit", "mentions"]);
  });

  it("matches a description only by whole words, without typos", () => {
    expect(ids("koprulu")).toEqual(["rogue"]);
    expect(ids("kopru")).toEqual([]);
    expect(ids("koprulo")).toEqual([]);
  });

  it("finds words spread over the title, author and description", () => {
    expect(ids("contracts raynor")).toEqual(["contracts"]);
    expect(ids("rogue kit")).toEqual(["rogue"]);
  });

  it("allows length/3 typos in words of 4+ letters, after every direct match", () => {
    expect(ids("kerigan")).toEqual(["kerrigan"]);
    expect(searchLibrary(all, "kerigan").typo).toBe(true);
    expect(ids("contingancy")).toEqual(["contracts"]);
    // 3 letters: no typos allowed.
    expect(ids("kot")).toEqual([]);
    // "rouge" is 2 edits from "rogue", over the limit of 1 for five letters.
    expect(ids("rouge")).toEqual([]);
    // The exact title comes before the one a letter off.
    const typo = mod("typo", "Kerrigam", "Zed");
    const direct = mod("direct", "Kerrigan", "Zed");
    expect(searchLibrary([typo, direct], "kerrigan").hits.map((item) => item.id)).toEqual(["direct", "typo"]);
  });

  it("keeps the Library's order between equal ranks", () => {
    const first = mod("first", "Alpha", "Kit");
    const second = mod("second", "Beta", "Kit");
    expect(searchLibrary([second, first], "kit").hits.map((item) => item.id)).toEqual(["second", "first"]);
  });

  it("adds an author's name once", () => {
    expect(withAuthor("", "Kit")).toBe("Kit");
    expect(withAuthor("rogue ", "Kit")).toBe("rogue Kit");
    expect(withAuthor("rogue kit", "Kit")).toBe("rogue kit");
    expect(withAuthor("kitten", "Kit")).toBe("kitten Kit");
    expect(withAuthor("Matt  Dixon", "Matt Dixon")).toBe("Matt  Dixon");
  });

  it("names the authors whose whole name is in the query", () => {
    expect(authorsIn("rogue kit", all)).toEqual(["Kit"]);
    expect(authorsIn("raynor kit", all)).toEqual(["Kit", "Raynor Kit"]);
    expect(authorsIn("kitten", all)).toEqual([]);
  });
});
