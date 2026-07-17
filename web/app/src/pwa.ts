// WOODIE-as-installable-app plumbing. The whole site is one PWA, but when the user is on the
// WOODIE page we swap the linked manifest + apple meta to the WOODIE identity — so "Add to Home
// Screen" installs an app called WOODIE, with the WOODIE icon, that launches straight into chat.
type BIPEvent = Event & { prompt: () => void; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: BIPEvent | null = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as BIPEvent;
  window.dispatchEvent(new Event("woodie-installable"));
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  window.dispatchEvent(new Event("woodie-installable"));
});

export const isStandalone = (): boolean =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
export const isIOS = (): boolean => /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as any).MSStream;
/** Launched as the installed WOODIE app (start_url carries ?app=woodie). */
export const isWoodieApp = (): boolean => new URLSearchParams(location.search).get("app") === "woodie" && isStandalone();
export const canPromptInstall = (): boolean => deferred !== null;

/** Fire the native install prompt. Returns 'unavailable' when the browser has no prompt
 *  (notably iOS Safari — the caller then shows the Add-to-Home-Screen hint). */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferred) return "unavailable";
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  window.dispatchEvent(new Event("woodie-installable"));
  return outcome;
}

// ---- manifest identity swap (Sherwood ⇄ WOODIE) ----
type Meta = { manifest: string; appleIcon: string; appleTitle: string };
const SHERWOOD: Meta = { manifest: "/manifest.webmanifest", appleIcon: "/apple-touch-icon.png", appleTitle: "Sherwood" };
const WOODIE: Meta = { manifest: "/woodie.webmanifest", appleIcon: "/woodie-apple-touch.png", appleTitle: "WOODIE" };

function apply(m: Meta) {
  const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
  if (link) link.href = m.manifest;
  const icon = document.querySelector('link[rel="apple-touch-icon"]') as HTMLLinkElement | null;
  if (icon) icon.href = m.appleIcon;
  const title = document.querySelector('meta[name="apple-mobile-web-app-title"]') as HTMLMetaElement | null;
  if (title) title.content = m.appleTitle;
}
/** Call on the WOODIE page to make an install target it; returns a restore fn for cleanup. */
export function useWoodieIdentity(): () => void {
  apply(WOODIE);
  return () => apply(SHERWOOD);
}
