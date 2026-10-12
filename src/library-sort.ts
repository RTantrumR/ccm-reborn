import type { Campaign } from "./types";

// The Library's order, remembered between starts. "Newest post" reads the date of the mod's
// Discord post from its id (a Discord id holds the time it was made). Mods without the date a
// sort needs go after the rest, in the feed's order.

export type LibrarySort = "updated" | "posted" | "name";

const KEY = "ccm-library-sort";
const OPTIONS: [LibrarySort, string][] = [["updated", "Recently updated"], ["posted", "Newest post"], ["name", "Name A–Z"]];
const DISCORD_EPOCH = 1420070400000n;

let current: LibrarySort = (() => {
  try {
    const saved = localStorage.getItem(KEY);
    return OPTIONS.some(([id]) => id === saved) ? saved as LibrarySort : "updated";
  } catch {
    return "updated";
  }
})();

/** The time a Discord post was made, from the message id at the end of its link. */
export function postedAt(postUrl: string | null | undefined): number | null {
  const id = postUrl?.match(/\/(\d{17,20})$/)?.[1];
  return id ? Number((BigInt(id) >> 22n) + DISCORD_EPOCH) : null;
}

const updatedAt = (campaign: Campaign) => {
  const time = campaign.updatedAt ? Date.parse(campaign.updatedAt) : NaN;
  return Number.isNaN(time) ? null : time;
};

// Newest first; a missing date sorts last.
const byTime = (time: (campaign: Campaign) => number | null) => (left: Campaign, right: Campaign) =>
  (time(right) ?? -Infinity) - (time(left) ?? -Infinity) || 0;

export function sortLibrary(campaigns: Campaign[], sort: LibrarySort = current) {
  const compare = sort === "name"
    ? (left: Campaign, right: Campaign) => left.title.localeCompare(right.title, undefined, { sensitivity: "base" })
    : byTime(sort === "posted" ? (campaign) => postedAt(campaign.link?.post) : updatedAt);
  return [...campaigns].sort(compare);
}

export function renderLibrarySort() {
  return `<label class="library-sort">Sort <select data-library-sort>${OPTIONS.map(([id, label]) =>
    `<option value="${id}" ${id === current ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
}

export function bindLibrarySort(render: () => void) {
  document.querySelector<HTMLSelectElement>("[data-library-sort]")?.addEventListener("change", (event) => {
    current = (event.target as HTMLSelectElement).value as LibrarySort;
    try {
      localStorage.setItem(KEY, current);
    } catch {
      // Without storage the Library opens in the default order next time.
    }
    render();
  });
}
