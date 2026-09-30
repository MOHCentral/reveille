// SPDX-License-Identifier: GPL-3.0-only

// Reveille's alert sound: two soft rising notes, synthesised rather than shipped as a recording,
// so it sounds the same on every system and carries no licence of its own.

const NOTES = [
  { frequency: 659.25, at: 0 }, // E5
  { frequency: 880, at: 0.11 }, // A5
];
const LENGTH_S = 0.35;
const VOLUME = 0.18;

let context = null;

export async function playChime() {
  context ??= new AudioContext();
  // A context made without a click starts suspended in some webviews.
  if (context.state === "suspended") await context.resume();
  const start = context.currentTime + 0.01;
  for (const { frequency, at } of NOTES) {
    const tone = context.createOscillator();
    const level = context.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    level.gain.setValueAtTime(0.0001, start + at);
    level.gain.exponentialRampToValueAtTime(VOLUME, start + at + 0.012);
    level.gain.exponentialRampToValueAtTime(0.0001, start + at + LENGTH_S);
    tone.connect(level).connect(context.destination);
    tone.start(start + at);
    tone.stop(start + at + LENGTH_S + 0.02);
  }
}
