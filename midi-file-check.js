/* MIDI file sanity checks (no playback)
   - Public API: checkMidiFile(arrayBuffer) → list of human-readable issues (empty when nothing is suspicious)
   - Heuristics for files that play badly on a General MIDI synth: damaged data, long silent ending,
     DAW-style exports (many tracks on one channel, no instrument selection), unreleased notes,
     sample-library keyswitches
*/
import { parseSmf, TempoMap, usesSmpteTiming } from './midi-file.js';

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------
const SILENT_ENDING_MAX_SEC = 10;    // Flag files that keep running longer than this after their last note
const MAX_TRACKS_PER_CHANNEL = 2;    // More note tracks than this on one melodic channel looks like a DAW export
const LOWEST_PIANO_NOTE = 21;        // A0: lower notes on melodic channels are likely keyswitches
const DRUM_CHANNEL = 9;              // MIDI channel 10 (0-based), excluded from melodic checks
const CHANNEL_COUNT = 16;

// ---------------------------------------------------------------------------
// Channel event statistics
// ---------------------------------------------------------------------------
/** Collected facts about the whole file, filled from its channel events while parsing. */
function createStats() {
  return {
    lastNoteTick: null,           // latest note-on/off across tracks
    programChanges: 0,
    hasMelodicNotes: false,
    openNotes: new Map(),         // channel * 128 + note → note-ons still waiting for a note-off
    noteTracksByChannel: Array.from({ length: CHANNEL_COUNT }, () => new Set()),
    lowNotesByChannel: new Map(), // channel → count of notes below LOWEST_PIANO_NOTE
  };
}

/** Record one channel voice message (note-on/off, program change); other messages are ignored. */
function recordChannelEvent(stats, trackIndex, tick, status, data1, data2) {
  const command = status & 0xf0;
  const channel = status & 0x0f;
  const key = channel * 128 + data1;
  if (command === 0xc0) {
    stats.programChanges++;
  } else if (command === 0x90 && data2 > 0) {
    stats.lastNoteTick = Math.max(stats.lastNoteTick ?? 0, tick);
    stats.openNotes.set(key, (stats.openNotes.get(key) ?? 0) + 1);
    stats.noteTracksByChannel[channel].add(trackIndex);
    if (channel !== DRUM_CHANNEL) {
      stats.hasMelodicNotes = true;
      if (data1 < LOWEST_PIANO_NOTE) {
        stats.lowNotesByChannel.set(channel, (stats.lowNotesByChannel.get(channel) ?? 0) + 1);
      }
    }
  } else if (command === 0x80 || command === 0x90) {
    stats.lastNoteTick = Math.max(stats.lastNoteTick ?? 0, tick);
    const open = stats.openNotes.get(key) ?? 0;
    if (open > 0) stats.openNotes.set(key, open - 1);
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
/** @returns {string} m:ss */
function formatTime(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** @returns {string} e.g. "1 note", "3 notes" */
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** @param {Iterable<number>} channels 0-based @returns {string} e.g. "channel 3", "channels 2, 4" */
function formatChannels(channels) {
  const numbers = [...channels].sort((a, b) => a - b).map((c) => c + 1);
  return `${numbers.length === 1 ? 'channel' : 'channels'} ${numbers.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Check a Standard MIDI File for issues that make it sound wrong on a General MIDI synth.
 * @param {ArrayBuffer} arrayBuffer SMF contents
 * @returns {string[]} human-readable issues, empty when nothing suspicious was found
 */
export function checkMidiFile(arrayBuffer) {
  const stats = createStats();
  const { damage, timing } = parseSmf(new Uint8Array(arrayBuffer), (...event) => recordChannelEvent(stats, ...event));
  if (!timing) return damage;
  // Nothing plays at all, so the other checks are moot
  if (usesSmpteTiming(timing.division)) {
    return [...damage, 'Uses SMPTE timing, which FluidSynth cannot play: nothing will be heard'];
  }
  const issues = [...damage];

  // Long silent ending (e.g. excerpt whose tempo track still spans the full song)
  if (stats.lastNoteTick !== null) {
    const tempoMap = new TempoMap(timing.division, timing.tempoChanges);
    const lastNoteSec = tempoMap.ticksToSeconds(stats.lastNoteTick);
    const endSec = tempoMap.ticksToSeconds(timing.endTick);
    if (endSec - lastNoteSec > SILENT_ENDING_MAX_SEC) {
      issues.push(`Long silence at the end: last note at ${formatTime(lastNoteSec)}, `
        + `but the file lasts ${formatTime(endSec)}`);
    }
  }

  // Many instrument tracks squeezed on one melodic channel (DAW export for sample libraries)
  const crowded = stats.noteTracksByChannel
    .map((tracks, channel) => ({ channel, count: tracks.size }))
    .filter(({ channel, count }) => channel !== DRUM_CHANNEL && count > MAX_TRACKS_PER_CHANNEL);
  if (crowded.length > 0) {
    const details = crowded.map(({ channel, count }) => `${count} tracks on channel ${channel + 1}`).join(', ');
    issues.push(`Several instrument tracks share one channel (${details}): they merge into one sound`);
  }

  // Notes but no instrument selection anywhere
  if (stats.hasMelodicNotes && stats.programChanges === 0) {
    issues.push('No instrument is selected anywhere in the file: every part plays as piano');
  }

  // Note-ons never matched by a note-off
  const unreleased = [...stats.openNotes].filter(([, count]) => count > 0);
  if (unreleased.length > 0) {
    const count = unreleased.reduce((sum, [, n]) => sum + n, 0);
    const channels = new Set(unreleased.map(([key]) => Math.floor(key / 128)));
    issues.push(`${plural(count, 'note')} never released (${formatChannels(channels)}): may ring until the end`);
  }

  // Notes below the piano range on melodic channels (sample-library keyswitches)
  if (stats.lowNotesByChannel.size > 0) {
    const count = [...stats.lowNotesByChannel.values()].reduce((sum, n) => sum + n, 0);
    const channels = formatChannels(stats.lowNotesByChannel.keys());
    issues.push(`${plural(count, 'note')} below A0 (${channels}): `
      + 'likely sample-library keyswitches, heard as stray notes');
  }

  return issues;
}
