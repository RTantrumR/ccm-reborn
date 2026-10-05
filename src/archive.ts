import { invoke } from "@tauri-apps/api/core";
import { bindGallery } from "./gallery";
import type { Campaign } from "./types";

// The Campaign Archive feed (bot/ in this repo): mods added from Discord posts, with their
// pictures. Local while it's being tried out; tauri.conf.json's img-src must list it.
export const ARCHIVE_FEED = "http://127.0.0.1:8791";

type ArchiveMod = {
  id: string; title: string; author: string; campaign: string; version: string | null;
  description: string; downloadUrl: string; docsUrl: string | null; images: string[];
  // Set when the bot downloaded the package and checked the app can install it.
  package: { sha256: string; size: number; fileName: string } | null;
};

const CAMPAIGN_NAMES: Record<string, string> = {
  WOL: "Wings of Liberty", HOTS: "Heart of the Swarm", LOTV: "Legacy of the Void",
  NCO: "Nova Covert Ops", ALL: "All campaigns",
};

let archive: Campaign[] = [];

export const archiveCampaigns = () => archive;

const toCampaign = (mod: ArchiveMod): Campaign => ({
  // The app's campaign ids allow only letters, digits, "-" and "_".
  id: `archive-${mod.id}`,
  title: mod.title,
  author: mod.author,
  version: mod.version ?? "",
  description: mod.description,
  tags: [],
  requirements: { campaign: CAMPAIGN_NAMES[mod.campaign] ?? mod.campaign },
  // A verified package installs from its link like a catalog download (MEGA links are decrypted on the way).
  package: mod.package ? { source: mod.downloadUrl, sha256: mod.package.sha256, size: mod.package.size } : { source: "", sha256: "", size: 0 },
  link: { download: mod.downloadUrl, docs: mod.docsUrl },
  images: mod.images.slice(0, 5).map((path) => `${ARCHIVE_FEED}${path}`),
});

/** Reloads the archive's mods. When the feed can't be reached the Library just shows
    the catalog, as before. */
export async function refreshArchive(): Promise<void> {
  try {
    const response = await fetch(`${ARCHIVE_FEED}/catalog.json`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`feed answered ${response.status}`);
    const feed = (await response.json()) as { mods: ArchiveMod[] };
    archive = feed.mods.map(toCampaign);
  } catch (error) {
    console.warn("[archive] feed unavailable:", error);
  }
}

export function bindArchive(onError: (message: string) => void) {
  bindGallery();
  document.querySelectorAll<HTMLButtonElement>("[data-action='open-link']").forEach((button) =>
    button.addEventListener("click", () => void invoke("open_web_link", { url: button.dataset.url ?? "" }).catch((error) => onError(String(error)))));
}
