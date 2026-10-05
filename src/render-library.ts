import type { Campaign, Catalog, CurrentCampaign, Inspection } from "./types";
import { byline, campaignSlot, formatBytes, installAction, isCommunityCampaign, versionTag } from "./domain";
import { renderGallery } from "./gallery";

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
  [/(^|.)mega.(nz|io|co.nz)$/i, "MEGA"], [/^drive.google.com$|^docs.google.com$/i, "Google Drive"],
  [/(^|.)dropbox.com$/i, "Dropbox"], [/(^|.)mediafire.com$/i, "MediaFire"], [/(^|.)moddb.com$/i, "ModDB"],
  [/^1drv.ms$|^onedrive.live.com$/i, "OneDrive"],
];

function hostName(url: string) {
  try {
    const host = new URL(url).hostname;
    return HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? host.replace(/^www./, "");
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

// An archive mod is downloaded from its author’s page in the browser.
function renderLinkRow(link: NonNullable<Campaign["link"]>) {
  const host = hostName(link.download);
  return `<div class="install-row">
    <button class="primary install" data-action="open-link" data-url="${escapeHtml(link.download)}">${host ? `Download from ${escapeHtml(host)}` : "Download"}</button>
    ${link.docs ? `<button class="ghost" data-action="open-link" data-url="${escapeHtml(link.docs)}">Patch notes</button>` : ""}
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
  const docs = campaign.link?.docs ? `<button class="ghost" data-action="open-link" data-url="${escapeHtml(campaign.link.docs)}">Patch notes</button>` : "";
  return `<div class="install-row">${button}${docs}</div>`;
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
      <p class="byline">${escapeHtml(campaign.author)}</p>
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

function renderCard(campaign: Campaign, selected: Campaign | null, context: LibraryContext) {
  const classes = ["campaign-card", `faction-${campaignSlot(campaign.requirements.campaign)}`, campaign.id === selected?.id ? "selected" : ""].join(" ").trim();
  return `<button class="${classes}" data-library-campaign="${escapeHtml(campaign.id)}">
    <div class="campaign-copy"><h2>${escapeHtml(campaign.title)}</h2><p>${escapeHtml(byline(campaign.author, versionTag(campaign.version)))}</p></div>
    ${context.isCurrentCatalogCampaign(campaign) ? '<span class="installed">CURRENT</span>' : ""}
  </button>`;
}

function renderFilters(active: string) {
  return `<div class="library-filters" role="toolbar" aria-label="Campaign">${FILTERS.map((filter) =>
    `<button class="filter-chip${filter.id ? ` faction-${filter.id}` : ""}${filter.id === active ? " active" : ""}" data-page="library" data-library-filter="${filter.id}" aria-pressed="${filter.id === active}" title="${filter.name}">${filter.label}</button>`).join("")}</div>`;
}

export function renderLibrary(context: LibraryContext) {
  const campaigns = [...(context.catalog?.campaigns ?? []), ...context.archive].filter((campaign) => isCommunityCampaign(campaign)
    && (!context.filter || campaignSlot(campaign.requirements.campaign) === context.filter));
  // The selection follows the filter: a pick outside it falls back to the first visible one.
  const selected = campaigns.find((campaign) => campaign.id === context.selectedId) ?? campaigns[0] ?? null;
  const list = campaigns.length
    ? campaigns.map((campaign) => renderCard(campaign, selected, context)).join("")
    : '<div class="empty-list">No campaigns in this catalog yet.</div>';
  const detail = selected
    ? `<article class="campaign-detail faction-${campaignSlot(selected.requirements.campaign)}">${renderLibraryDetail(selected, context)}</article>`
    : '<article class="campaign-detail"><div class="empty-detail"><div class="empty-orb">◇</div><h2>Library is empty.</h2></div></article>';
  return `<section class="workspace library-workspace"><div class="library-column">${renderFilters(context.filter)}<div class="campaign-list">${list}</div></div>${detail}</section>`;
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
