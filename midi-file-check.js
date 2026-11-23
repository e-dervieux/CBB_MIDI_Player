/* MIDI file sanity checks (Standard MIDI File parsing only, no playback)
   - Public API: checkMidiFile(arrayBuffer) → list of human-readable issues (empty when nothing is suspicious)
   - Heuristics for files that play badly on a General MIDI synth: damaged data, long silent ending,
     DAW-style exports (many tracks on one channel, no instrument selection), unreleased notes,
     sample-library keyswitches
*/
import { DEFAULT_TEMPO_US_PER_QUARTER } from './playback-defaults.js';

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------
const SILENT_ENDING_MAX_SEC = 10;    // Flag files that keep running longer than this after their last note
const MAX_TRACKS_PER_CHANNEL = 2;    // More note tracks than this on one melodic channel looks like a DAW export
const LOWEST_PIANO_NOTE = 21;        // A0: lower notes on melodic channels are likely keyswitches
const DRUM_CHANNEL = 9;              // MIDI channel 10 (0-based), excluded from melodic checks
const CHANNEL_COUNT = 16;

// ---------------------------------------------------------------------------
// Byte reader
// ---------------------------------------------------------------------------
/** Thrown when an event runs past the end of its track chunk. */
class TruncatedError extends Error {}
/** Thrown on bytes that cannot be a valid MIDI event. */
class InvalidDataError extends Error {}

/** Sequential reader over a byte range, throwing TruncatedError instead of reading past its end. */
class ByteReader {
  constructor(data, start, end) {
    this.data = data;
    this.pos = start;
    this.end = end;
  }

  atEnd() { return this.pos >= this.end; }

  peek() {
    if (this.atEnd()) throw new TruncatedError();
    return this.data[this.pos];
  }

  byte() {
    const value = this.peek();
    this.pos++;
    return value;
  }

  skip(length) {
    if (this.pos + length > this.end) throw new TruncatedError();
    this.pos += length;
  }

  bytes(length) {
    const start = this.pos;
    this.skip(length);
    return this.data.subarray(start, this.pos);
  }

  /** Variable-length quantity (at most 4 bytes in a valid file). */
  varLen() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
    throw new InvalidDataError();
  }

  chunkId() { return String.fromCharCode(...this.bytes(4)); }

  uint16() { return (this.byte() << 8) | this.byte(); }

  uint32() { return ((this.uint16() << 16) | this.uint16()) >>> 0; }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
/** Collected facts about the whole file, filled while parsing the tracks. */
function createStats() {
  return {
    tempoChanges: [],             // { tick, usPerQuarter }
    endTick: 0,                   // latest End-of-Track (or last event) across tracks
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

/**
 * Parse one track chunk until its End-of-Track meta event.
 * Running status is kept across meta/sysex events, as lenient players (FluidSynth included) do.
 * @returns {boolean} whether an End-of-Track marker was found
 */
function parseTrack(reader, trackIndex, stats) {
  let tick = 0;
  let runningStatus = null;
  while (!reader.atEnd()) {
    tick += reader.varLen();
    stats.endTick = Math.max(stats.endTick, tick);
    let status = reader.peek();
    if (status & 0x80) reader.skip(1);
    else if (runningStatus === null) throw new InvalidDataError();
    else status = runningStatus;

    if (status === 0xff) {
      const type = reader.byte();
      const body = reader.bytes(reader.varLen());
      if (type === 0x51 && body.length === 3) {
        stats.tempoChanges.push({ tick, usPerQuarter: (body[0] << 16) | (body[1] << 8) | body[2] });
      }
      if (type === 0x2f) return true;
    } else if (status === 0xf0 || status === 0xf7) {
      reader.skip(reader.varLen());
    } else if (status > 0xf0) {
      throw new InvalidDataError(); // System common/real-time messages are not allowed in files
    } else {
      runningStatus = status;
      const command = status & 0xf0;
      const data1 = reader.byte();
      const data2 = (command === 0xc0 || command === 0xd0) ? 0 : reader.byte();
      recordChannelEvent(stats, trackIndex, tick, status, data1, data2);
    }
  }
  return false;
}

/**
 * Parse header and track chunks, collecting structural damage and file-wide stats.
 * @param {Uint8Array} data
 * @returns {{ damage: string[], division: number, stats: object } | { damage: string[] }}
 */
function parseSmf(data) {
  const damage = [];
  const reader = new ByteReader(data, 0, data.length);
  try {
    if (reader.chunkId() !== 'MThd') return { damage: ['Not a Standard MIDI File (missing MThd header)'] };
    const headerLength = reader.uint32();
    if (headerLength < 6) return { damage: ['Invalid MIDI header (too short)'] };
    reader.uint16(); // format: not needed by the checks
    const declaredTracks = reader.uint16();
    const division = reader.uint16();
    reader.skip(headerLength - 6);
    if (division === 0) return { damage: ['Invalid timing division (0) in the header'] };

    const stats = createStats();
    let trackIndex = 0;
    while (reader.end - reader.pos >= 8) {
      const id = reader.chunkId();
      const declaredLength = reader.uint32();
      const start = reader.pos;
      const end = Math.min(start + declaredLength, data.length);
      reader.skip(end - start);
      if (id !== 'MTrk') continue; // Unknown chunks are allowed and ignored

      trackIndex++;
      // At most one problem per track; a chunk running past the end of the file explains the rest.
      let problem = (start + declaredLength > data.length)
        ? `Track ${trackIndex} is truncated (the file ends before the track does)`
        : null;
      try {
        if (!parseTrack(new ByteReader(data, start, end), trackIndex, stats)) {
          problem ??= `Track ${trackIndex} has no End-of-Track marker`;
        }
      } catch (error) {
        if (error instanceof TruncatedError) problem ??= `Track ${trackIndex} is cut off in the middle of an event`;
        else if (error instanceof InvalidDataError) problem ??= `Track ${trackIndex} contains invalid event data`;
        else throw error;
      }
      if (problem) damage.push(problem);
    }
    if (trackIndex !== declaredTracks) {
      damage.push(`Header announces ${declaredTracks} tracks, but ${trackIndex} were found`);
    }
    stats.tempoChanges.sort((a, b) => a.tick - b.tick);
    return { damage, division, stats };
  } catch (error) {
    if (error instanceof TruncatedError) return { damage: ['File is too short to contain a valid MIDI header'] };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Timing and formatting helpers
// ---------------------------------------------------------------------------
/** Convert an absolute tick to seconds using the tempo map (or SMPTE timing when division is negative). */
function ticksToSeconds(tick, division, tempoChanges) {
  if (division & 0x8000) {
    const framesPerSecond = 256 - (division >> 8);
    return tick / (framesPerSecond * (division & 0xff));
  }
  let seconds = 0;
  let prevTick = 0;
  let usPerQuarter = DEFAULT_TEMPO_US_PER_QUARTER;
  for (const change of tempoChanges) {
    if (change.tick >= tick) break;
    seconds += ((change.tick - prevTick) * usPerQuarter) / division / 1e6;
    prevTick = change.tick;
    usPerQuarter = change.usPerQuarter;
  }
  return seconds + ((tick - prevTick) * usPerQuarter) / division / 1e6;
}

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
  const { damage, division, stats } = parseSmf(new Uint8Array(arrayBuffer));
  if (!stats) return damage;
  const issues = [...damage];

  // Long silent ending (e.g. excerpt whose tempo track still spans the full song)
  if (stats.lastNoteTick !== null) {
    const lastNoteSec = ticksToSeconds(stats.lastNoteTick, division, stats.tempoChanges);
    const endSec = ticksToSeconds(stats.endTick, division, stats.tempoChanges);
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
