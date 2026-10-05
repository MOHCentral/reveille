// SPDX-License-Identifier: GPL-3.0-only

// What the update dialog says about the offer and the download.

export function offerText(offer) {
  return `Version ${offer.version} is available. You have ${offer.current_version}.`;
}

/** The meter's width as a percentage, or null while the size is unknown or nothing is downloading. */
export function progressShare(progress) {
  if (progress?.phase !== "downloading" || !progress.total) return null;
  return Math.min(100, ((progress.received ?? 0) / progress.total) * 100);
}

export function progressText(progress) {
  if (!progress) return "";
  if (progress.phase === "verifying") return "Checking the downloaded update";
  if (progress.phase === "installing") return "Closing Reveille and installing the update";
  if (progress.phase === "cancelled") return "Download stopped";
  const total = progress.total ?? null;
  const received = progress.received ?? 0;
  return total ? `${Math.round((received / total) * 100)}% downloaded` : "Downloading update";
}
