import type { Campaign, Catalog, CurrentCampaign, Inspection } from "./types";
import { renderLibrarySort, sortLibrary } from "./library-sort";
import { byline, campaignSlot, formatBytes, installAction, isCommunityCampaign, versionTag } from "./domain";
import { renderGallery } from "./gallery";
import { authorsIn, libraryQuery, searchLibrary, setLibraryQuery, withAuthor } from "./library-search";

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

// Catalog tags are only [base campaign, "CCM package"] today, which repeats the
// Campaign cell. Hidden until the catalog carries tags worth showing.
const SHOW_TAGS = false;

// Short labels fit above the list column; the full name is the tooltip.
const FILTERS = [
  { id: "", label: "All", name: "All campaigns" },
  { id: "wings-of-liberty", label: "WoL", name: "Wings of Liberty" },
  { id: "heart-of-the-swarm", label: "HotS", name: "Heart of the Swarm" },
  { id: "legacy-of-the-void", label: "LotV", name: "Legacy of the Void" },
  { id: "nova-covert-ops", label: "NCO", name: "Nova Covert Ops" },
];

export type LibraryContext = {
  catalog: Catalog | null;
  // Campaign Archive mods, listed after the catalog.
  archive: Campaign[];
  inspection: Inspection | null;
  selectedId: string;
  filter: string; // campaignSlot() id, or "" for every campaign
  busy: boolean;
  gameDir: string;
  profileDir: string;
  installingCampaignId: string;
  isCurrentCatalogCampaign: (campaign: Campaign) => boolean;
};

const HOSTS: [RegExp, string][] = [
  [/(^|\.)mega\.(nz|io|co\.nz)$/i, "MEGA"], [/^drive\.google\.com$|^docs\.google\.com$/i, "Google Drive"],
  [/(^|\.)dropbox\.com$/i, "Dropbox"], [/(^|\.)mediafire\.com$/i, "MediaFire"], [/(^|\.)moddb\.com$/i, "ModDB"],
  [/^1drv\.ms$|^onedrive\.live\.com$/i, "OneDrive"],
];

function hostName(url: string) {
  try {
    const host = new URL(url).hostname;
    return HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Links in a description open in the browser. Only https ones: the same rule as open_web_link.
const LINK = /https:\/\/[^\s<>()\]]+/g;

function linkedText(text: string) {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    // A sentence's closing punctuation isn't part of the link.
    const url = match[0].replace(/[.,;:!?'"]+$/, "");
    html += `${escapeHtml(text.slice(last, match.index))}<button class="text-link" data-action="open-link" data-url="${escapeHtml(url)}">${escapeHtml(url)}</button>`;
    last = match.index + url.length;
  }
  return html + escapeHtml(text.slice(last));
}

// Discord's logo (Simple Icons, CC0).
const DISCORD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>`;

// The mod's patch notes and the Discord post it was added from, opened in the browser.
function renderPageLinks(link: Campaign["link"]) {
  const button = (url: string | null | undefined, kind: string, label: string) =>
    url ? `<button class="${kind}" data-action="open-link" data-url="${escapeHtml(url)}">${label}</button>` : "";
  return `${button(link?.docs, "ghost", "Patch notes")}${button(link?.post, "discord", `${DISCORD_ICON}Discord thread`)}`;
}

// An archive mod is downloaded from its author’s page in the browser.
function renderLinkRow(link: NonNullable<Campaign["link"]>) {
  const host = hostName(link.download);
  return `<div class="install-row">
    <button class="primary install" data-action="open-link" data-url="${escapeHtml(link.download)}">${host ? `Download from ${escapeHtml(host)}` : "Download"}</button>
    ${renderPageLinks(link)}
  </div>`;
}

function renderInstallRow(campaign: Campaign, context: LibraryContext) {
  if (campaign.link && !campaign.package.sha256) return renderLinkRow(campaign.link);
  const working = context.busy && context.installingCampaignId === campaign.id;
  const disabled = !context.gameDir ? 'disabled title="Choose your StarCraft II folder first"'
    : !context.profileDir ? 'disabled title="Choose your StarCraft II account first"'
    : context.busy ? "disabled" : "";
  const action = installAction(campaign, context.inspection);
  const label = action === "reinstall" ? "Reinstall" : `${action === "update" ? "Update to" : "Install"} ${escapeHtml(versionTag(campaign.version))}`.trim();
  const button = `<button class="${action === "reinstall" ? "ghost" : "primary install"}" data-action="install" data-campaign="${escapeHtml(campaign.id)}" ${disabled}>${working ? "Working…" : label}</button>`;
  return `<div class="install-row">${button}${renderPageLinks(campaign.link)}</div>`;
}

function renderLibraryDetail(campaign: Campaign, context: LibraryContext) {
  const slot = campaignSlot(campaign.requirements.campaign);
  const current = context.inspection?.activeCampaigns.find((item: CurrentCampaign) => item.slot === slot);
  const tags = SHOW_TAGS ? `<div class="tags">${campaign.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : "";
  return `
    ${renderGallery(campaign)}
    <div class="detail-head">
      <p class="eyebrow">${escapeHtml(campaign.requirements.campaign)}</p>
      <div class="title-row"><h2>${escapeHtml(campaign.title)}</h2>${versionTag(campaign.version) ? `<span class="version">${escapeHtml(versionTag(campaign.version))}</span>` : ""}</div>
      <p class="byline">${authorLink(campaign.author)}</p>
      ${renderInstallRow(campaign, context)}
    </div>
    <div class="detail-body">
      <p class="description">${linkedText(campaign.description)}</p>
      <div class="metadata${campaign.package.size ? "" : " single"}">
        ${!campaign.package.size ? "" : `<div><small>SIZE</small><strong>${formatBytes(campaign.package.size)}</strong></div>`}
        <div><small>CAMPAIGN</small><strong>${escapeHtml(campaign.requirements.campaign)}</strong></div>
      </div>
      ${tags}
      ${current ? `<section class="current-campaign"><div><small>CURRENT ${escapeHtml(campaign.requirements.campaign.toUpperCase())}</small><strong>${escapeHtml(current.title)}</strong><span>${escapeHtml(byline(current.author, versionTag(current.version)))}</span></div></section>` : ""}
    </div>`;
}

// Clicking an author puts their name in the search box.
const authorLink = (author: string) => author.trim()
  ? `<button class="author-link" data-library-author="${escapeHtml(author)}" title="Find mods by ${escapeHtml(author)}">${escapeHtml(author)}</button>` : "";

// A focusable row rather than a button, so the author inside it can be a button of its own.
function renderCard(campaign: Campaign, selectedId: string, context: LibraryContext) {
  const classes = ["campaign-card", `faction-${campaignSlot(campaign.requirements.campaign)}`, campaign.id === selectedId ? "selected" : ""].join(" ").trim();
  return `<div class="${classes}" role="button" tabindex="0" data-library-campaign="${escapeHtml(campaign.id)}">
    <div class="campaign-copy"><h2>${escapeHtml(campaign.title)}</h2><p>${byline(authorLink(campaign.author), escapeHtml(versionTag(campaign.version)))}</p></div>
    ${context.isCurrentCatalogCampaign(campaign) ? '<span class="installed">CURRENT</span>' : ""}
  </div>`;
}

function renderFilters(active: string) {
  return `<div class="library-filters" role="toolbar" aria-label="Campaign">${FILTERS.map((filter) =>
    `<button class="filter-chip${filter.id ? ` faction-${filter.id}` : ""}${filter.id === active ? " active" : ""}" data-page="library" data-library-filter="${filter.id}" aria-pressed="${filter.id === active}" title="${filter.name}">${filter.label}</button>`).join("")}${renderLibrarySort()}</div>`;
}

const MAGNIFIER = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.1 3.1"/></svg>`;

function renderSearch() {
  const query = libraryQuery();
  return `<div class="library-search${query ? " has-query" : ""}">${MAGNIFIER}
    <input type="search" data-library-search value="${escapeHtml(query)}" placeholder="Search by name, author or description" aria-label="Search the Library" spellcheck="false" autocomplete="off">
    <button class="search-clear" data-action="clear-search" aria-label="Clear search" title="Clear search">×</button>
  </div>`;
}

// What the search found, without the box: typing redraws only this part.
function results(context: LibraryContext, shownId?: string) {
  const pool = sortLibrary([...(context.catalog?.campaigns ?? []), ...context.archive].filter((campaign) => isCommunityCampaign(campaign)
    && (!context.filter || campaignSlot(campaign.requirements.campaign) === context.filter)));
  const { hits, typo } = searchLibrary(pool);
  // The selection follows the campaign chip, not the search: the open mod stays open while
  // the player types. A pick outside the chip falls back to the first result.
  const selected = pool.find((campaign) => campaign.id === (shownId ?? context.selectedId)) ?? hits[0] ?? pool[0] ?? null;
  const query = libraryQuery().trim();
  const list = hits.length ? hits.map((campaign) => renderCard(campaign, selected?.id ?? "", context)).join("")
    : `<div class="empty-list">${pool.length ? `No mods match “${escapeHtml(query)}”.` : "No campaigns in this catalog yet."}</div>`;
  const pills = [...authorsIn(query, pool).map((author) => `<span class="search-pill author">by ${escapeHtml(author)}</span>`),
    typo ? '<span class="search-pill">similar names</span>' : ""].join("");
  return { selected, list, pills };
}

let lastContext: LibraryContext | null = null;

export function renderLibrary(context: LibraryContext) {
  lastContext = context;
  const { selected, list, pills } = results(context);
  const detail = selected
    ? `<article class="campaign-detail faction-${campaignSlot(selected.requirements.campaign)}" data-campaign="${escapeHtml(selected.id)}">${renderLibraryDetail(selected, context)}</article>`
    : '<article class="campaign-detail"><div class="empty-detail"><div class="empty-orb">◇</div><h2>Library is empty.</h2></div></article>';
  return `<section class="workspace library-workspace"><div class="library-column">${renderFilters(context.filter)}${renderSearch()}<div class="search-pills">${pills}</div><div class="campaign-list">${list}</div></div>${detail}</section>`;
}

/** Redraws the results and pills for the current search, leaving the box (and its focus)
    and the open mod alone. */
function refreshResults() {
  const listElement = document.querySelector<HTMLElement>(".campaign-list");
  if (!lastContext || !listElement) return;
  const shown = document.querySelector<HTMLElement>(".campaign-detail")?.dataset.campaign;
  const { list, pills } = results(lastContext, shown);
  listElement.innerHTML = list;
  const pillsElement = document.querySelector<HTMLElement>(".search-pills");
  if (pillsElement) pillsElement.innerHTML = pills;
  document.querySelector(".library-search")?.classList.toggle("has-query", !!libraryQuery());
}

function search(value: string, input: HTMLInputElement | null) {
  setLibraryQuery(value);
  if (input && input.value !== value) input.value = value;
  refreshResults();
}

/** Picking a mod (click, or Enter/Space on a focused card), clicking an author, and the search box. */
export function bindLibrary(select: (id: string) => void) {
  const workspace = document.querySelector<HTMLElement>(".library-workspace");
  const input = document.querySelector<HTMLInputElement>("[data-library-search]");
  if (!workspace) return;
  workspace.addEventListener("click", (event) => {
    const target = event.target as Element;
    const author = target.closest<HTMLElement>("[data-library-author]");
    if (author) return search(withAuthor(libraryQuery(), author.dataset.libraryAuthor ?? ""), input);
    const card = target.closest<HTMLElement>("[data-library-campaign]");
    if (card) select(card.dataset.libraryCampaign ?? "");
  });
  workspace.addEventListener("keydown", (event) => {
    const card = event.target as HTMLElement;
    if ((event.key !== "Enter" && event.key !== " ") || !card.matches("[data-library-campaign]")) return;
    event.preventDefault();
    select(card.dataset.libraryCampaign ?? "");
  });
  input?.addEventListener("input", () => search(input.value, null));
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !input.value) return;
    event.preventDefault();
    search("", input);
  });
  document.querySelector<HTMLButtonElement>("[data-action='clear-search']")?.addEventListener("click", () => {
    search("", input);
    input?.focus();
  });
}

/** The detail card ends inside the window from where it starts with the page at the top,
    so only the card scrolls: the page never has to scroll to reach the card's bottom. */
export function fitLibraryDetail() {
  const detail = document.querySelector<HTMLElement>(".campaign-detail");
  const workspace = detail?.parentElement;
  if (!detail || !workspace) return;
  // One column (a narrow window): the card sits under the list and the page scrolls as usual.
  if (detail.offsetTop > workspace.offsetTop + 8) return void (detail.style.maxHeight = "");
  const top = workspace.getBoundingClientRect().top + window.scrollY;
  // The page's own bottom padding stays below the card, or the page would scroll by that much.
  const padding = parseFloat(getComputedStyle(workspace.closest("main") ?? workspace).paddingBottom) || 0;
  detail.style.maxHeight = `${Math.max(240, window.innerHeight - top - padding)}px`;
}

window.addEventListener("resize", fitLibraryDetail);

/** render() rebuilds the page, which would put the card back at its top (on every install
    progress update, or on coming back from a link) and drop the search box's focus. Call
    before; run the result after fitLibraryDetail, once the card can scroll again. Another mod
    starts at the top. */
export function keepLibraryView() {
  const before = document.querySelector<HTMLElement>(".campaign-detail");
  const id = before?.dataset.campaign;
  const top = before?.scrollTop ?? 0;
  const input = document.querySelector<HTMLInputElement>("[data-library-search]");
  const typing = input && document.activeElement === input ? [input.selectionStart ?? 0, input.selectionEnd ?? 0] : null;
  return () => {
    const after = document.querySelector<HTMLElement>(".campaign-detail");
    if (after && id && after.dataset.campaign === id) after.scrollTop = top;
    const box = document.querySelector<HTMLInputElement>("[data-library-search]");
    if (!typing || !box) return;
    box.focus();
    box.setSelectionRange(typing[0], typing[1]);
  };
}
