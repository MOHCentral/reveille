// SPDX-License-Identifier: GPL-3.0-only

// What the pop-up window shows: the newest alerts first, one card per server, each leaving on its
// own after a few seconds unless the pointer is resting on the pop-up.

export const SHOWN = 3;
export const LIFETIME_MS = 8_000;

const serverOf = (card) => `${card.game}|${card.address}`;

/** A new alert. A second one for a server already on screen replaces its card and restarts it. */
export function addCard(stack, card, now) {
  const rest = stack.filter((shown) => serverOf(shown) !== serverOf(card));
  return [{ ...card, leavesAt: now + LIFETIME_MS }, ...rest];
}

export function removeCard(stack, eventId) {
  return stack.filter((card) => card.eventId !== eventId);
}

/** Cards past their time. Only shown cards age: one waiting behind "+N more" has not been seen. */
export function expired(stack, now) {
  return stack.slice(0, SHOWN).filter((card) => card.leavesAt <= now);
}

/** Give every card back the time the pointer spent resting on the pop-up. */
export function resume(stack, pausedFor) {
  return stack.map((card) => ({ ...card, leavesAt: card.leavesAt + pausedFor }));
}

/** A card moving up from behind "+N more" starts its full time now. */
export function revealed(stack, before, now) {
  const seen = new Set(before.slice(0, SHOWN).map((card) => card.eventId));
  return stack.map((card, index) =>
    index < SHOWN && !seen.has(card.eventId) ? { ...card, leavesAt: now + LIFETIME_MS }
      : card,
  );
}

export function hiddenCount(stack) {
  return Math.max(0, stack.length - SHOWN);
}

export function cardTitle(card) {
  return `${card.count} ${card.count === 1 ? "player" : "players"} on ${card.hostname}`;
}
