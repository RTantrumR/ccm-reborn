import type { Campaign } from "./types";

/* A mod's pictures in the Library detail: one at a time, ‹ › to step through (wrapping
   round), a click opens it over the whole window. Steps update the page in place: a full
   render() would reset the detail panel's scroll. The full-window view lives outside the
   render root, so a render while it's open leaves it alone. */

// Which picture each mod shows, kept across renders and selections.
const positions = new Map<string, number>();
// The pictures of the gallery on screen, by mod id.
const shown = new Map<string, string[]>();
let zoomed: string | null = null;
// The full-window view's magnification: scale 1 is the picture fitted to the window.
const MAX_SCALE = 5;
const ZOOM_STEP = 1.25;
let view = { scale: 1, x: 0, y: 0 };

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

const position = (id: string, count: number) => Math.min(positions.get(id) ?? 0, count - 1);

const arrows = (count: number) => count > 1
  ? `<button class="gallery-nav prev" data-gallery-step="-1" aria-label="Previous picture">‹</button>
     <button class="gallery-nav next" data-gallery-step="1" aria-label="Next picture">›</button>`
  : "";

export function renderGallery(campaign: Campaign) {
  const images = campaign.images ?? [];
  if (!images.length) return "";
  shown.set(campaign.id, images);
  const at = position(campaign.id, images.length);
  return `<div class="gallery" data-gallery="${escapeHtml(campaign.id)}">
    <button class="gallery-frame" data-gallery-zoom aria-label="Enlarge the picture"><img src="${escapeHtml(images[at])}" alt=""></button>
    ${arrows(images.length)}
    ${images.length > 1 ? `<div class="gallery-dots" aria-hidden="true">${images.map((_, index) => `<i class="${index === at ? "on" : ""}"></i>`).join("")}</div>` : ""}
  </div>`;
}

function slide(image: HTMLImageElement | null, src: string, direction: number) {
  if (!image) return;
  image.src = src;
  image.classList.remove("slide-next", "slide-prev");
  void image.offsetWidth; // restarts the animation
  if (direction) image.classList.add(direction > 0 ? "slide-next" : "slide-prev");
}

// The picture can't be dragged away from the area it fills at 100%.
function applyView(image: HTMLImageElement) {
  view.x = Math.min(0, Math.max(image.offsetWidth * (1 - view.scale), view.x));
  view.y = Math.min(0, Math.max(image.offsetHeight * (1 - view.scale), view.y));
  image.style.transform = view.scale === 1 ? "" : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  image.classList.toggle("magnified", view.scale > 1);
}

function resetView(image: HTMLImageElement | null) {
  view = { scale: 1, x: 0, y: 0 };
  if (image) applyView(image);
}

// Wheel up zooms in toward the cursor, wheel down zooms back out to 100%.
function onWheel(event: WheelEvent, image: HTMLImageElement) {
  event.preventDefault();
  const scale = event.deltaY < 0 ? Math.min(MAX_SCALE, view.scale * ZOOM_STEP) : Math.max(1, view.scale / ZOOM_STEP);
  if (scale === view.scale) return;
  // With the transform origin at the top left, the box's untransformed corner is rect - translate.
  const rect = image.getBoundingClientRect();
  const left = rect.left - view.x;
  const top = rect.top - view.y;
  // The point of the picture under the cursor stays under it.
  const pointX = (event.clientX - left - view.x) / view.scale;
  const pointY = (event.clientY - top - view.y) / view.scale;
  view = { scale, x: event.clientX - left - pointX * scale, y: event.clientY - top - pointY * scale };
  applyView(image);
}

// While zoomed in, dragging moves the picture.
function onPointerDown(event: PointerEvent, image: HTMLImageElement) {
  if (view.scale === 1) return;
  image.setPointerCapture(event.pointerId);
  const start = { x: event.clientX - view.x, y: event.clientY - view.y };
  const move = (moved: PointerEvent) => {
    view.x = moved.clientX - start.x;
    view.y = moved.clientY - start.y;
    applyView(image);
  };
  image.addEventListener("pointermove", move);
  image.addEventListener("lostpointercapture", () => image.removeEventListener("pointermove", move), { once: true });
}

function show(id: string, index: number, direction: number) {
  const images = shown.get(id) ?? [];
  if (!images.length) return;
  const at = (index + images.length) % images.length;
  positions.set(id, at);
  const gallery = document.querySelector<HTMLElement>(`[data-gallery="${CSS.escape(id)}"]`);
  slide(gallery?.querySelector("img") ?? null, images[at], direction);
  gallery?.querySelectorAll(".gallery-dots i").forEach((dot, dotIndex) => dot.classList.toggle("on", dotIndex === at));
  const box = document.querySelector<HTMLElement>(".lightbox");
  if (zoomed === id && box) {
    resetView(box.querySelector("img"));
    slide(box.querySelector("img"), images[at], direction);
    const counter = box.querySelector(".lightbox-count");
    if (counter) counter.textContent = `${at + 1} / ${images.length}`;
  }
}

const step = (id: string, direction: number) =>
  show(id, position(id, shown.get(id)?.length ?? 1) + direction, direction);

function closeZoom() {
  document.querySelector(".lightbox")?.remove();
  const id = zoomed;
  zoomed = null;
  if (id) document.querySelector<HTMLElement>(`[data-gallery="${CSS.escape(id)}"] [data-gallery-zoom]`)?.focus();
}

function openZoom(id: string) {
  const count = shown.get(id)?.length ?? 0;
  if (!count) return;
  zoomed = id;
  const box = document.createElement("div");
  box.className = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Pictures");
  box.innerHTML = `<img alt="" draggable="false">${arrows(count)}${count > 1 ? '<div class="lightbox-count"></div>' : ""}
    <button class="lightbox-close" aria-label="Close">✕</button>`;
  // A click on the dark backdrop closes it; one on the picture or a button doesn't.
  box.addEventListener("click", (event) => { if (event.target === box) closeZoom(); });
  box.querySelector(".lightbox-close")?.addEventListener("click", closeZoom);
  box.querySelectorAll<HTMLButtonElement>("[data-gallery-step]").forEach((button) =>
    button.addEventListener("click", () => step(id, Number(button.dataset.galleryStep))));
  const image = box.querySelector("img")!;
  box.addEventListener("wheel", (event) => onWheel(event, image), { passive: false });
  image.addEventListener("pointerdown", (event) => onPointerDown(event, image));
  document.body.append(box);
  show(id, position(id, count), 0);
  box.querySelector<HTMLButtonElement>(".lightbox-close")?.focus();
}

document.addEventListener("keydown", (event) => {
  if (!zoomed) return;
  if (event.key === "Escape") closeZoom();
  else if (event.key === "ArrowLeft") step(zoomed, -1);
  else if (event.key === "ArrowRight") step(zoomed, 1);
  else return;
  event.preventDefault();
});

export function bindGallery() {
  const gallery = document.querySelector<HTMLElement>("[data-gallery]");
  const id = gallery?.dataset.gallery;
  if (!gallery || !id) return;
  // The next pictures are already loaded when the player steps to them.
  for (const src of shown.get(id) ?? []) new Image().src = src;
  gallery.querySelectorAll<HTMLButtonElement>("[data-gallery-step]").forEach((button) =>
    button.addEventListener("click", () => step(id, Number(button.dataset.galleryStep))));
  gallery.querySelector("[data-gallery-zoom]")?.addEventListener("click", () => openZoom(id));
}
