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

// A funnel, the same sign as the sort button on the Campaign Archive site.
const FUNNEL = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 3.5h11L9.25 8.4v4.1l-2.5-1.3V8.4Z"/></svg>`;

/** A funnel button at the end of the campaign chips; it opens the three orders. */
export function renderLibrarySort() {
  const label = `Sort: ${OPTIONS.find(([id]) => id === current)?.[1]}`;
  return `<div class="library-sort">
    <button class="sort-button" data-sort-toggle aria-haspopup="menu" aria-expanded="false" aria-label="${label}" title="${label}">${FUNNEL}</button>
    <div class="sort-menu" role="menu" hidden>${OPTIONS.map(([id, name]) =>
      `<button role="menuitemradio" aria-checked="${id === current}" data-library-sort="${id}">${name}</button>`).join("")}</div>
  </div>`;
}

const menu = () => document.querySelector<HTMLElement>(".sort-menu");

function showMenu(open: boolean) {
  const list = menu();
  if (!list) return;
  list.hidden = !open;
  const toggle = document.querySelector<HTMLButtonElement>("[data-sort-toggle]");
  toggle?.setAttribute("aria-expanded", String(open));
  if (open) list.querySelector<HTMLButtonElement>("[aria-checked='true']")?.focus();
}

let closesOnOutside = false;

export function bindLibrarySort(render: () => void) {
  document.querySelector<HTMLButtonElement>("[data-sort-toggle]")?.addEventListener("click", () => showMenu(menu()?.hidden ?? false));
  document.querySelectorAll<HTMLButtonElement>("[data-library-sort]").forEach((option) => option.addEventListener("click", () => {
    current = option.dataset.librarySort as LibrarySort;
    try {
      localStorage.setItem(KEY, current);
    } catch {
      // Without storage the Library opens in the default order next time.
    }
    render();
  }));
  // The menu is rebuilt with the page, so these listen once on the document.
  if (closesOnOutside) return;
  closesOnOutside = true;
  document.addEventListener("click", (event) => {
    if (!(event.target as Element).closest?.(".library-sort")) showMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu()?.hidden !== false) return;
    showMenu(false);
    document.querySelector<HTMLButtonElement>("[data-sort-toggle]")?.focus();
  });
}
