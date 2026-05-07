/**
 * Shared playback tempo defaults for app.js and synthesizer-player.js.
 * Used when the Standard MIDI File has no Set Tempo meta event yet, or tempo cannot be read
 * (MIDI convention / SMF practice: 120 BPM ⇒ 500000 µs per quarter note).
 */
export const DEFAULT_BPM = 120;
export const DEFAULT_TEMPO_US_PER_QUARTER = Math.round(60_000_000 / DEFAULT_BPM);
