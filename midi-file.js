/* Standard MIDI File (SMF) reading, no playback
   - parseSmf(data, onChannelEvent): header division, tempo changes, end tick and structural damage
   - usesSmpteTiming(division): whether a file counts time in video frames (FluidSynth refuses those)
   - TempoMap: ticks ↔ seconds following every tempo change of a file
   - readTempoMap(arrayBuffer): TempoMap of a file (player timeline)
   Format references:
   https://web.archive.org/web/20250302231448/https://midimusic.github.io/tech/midispec.html
   https://web.archive.org/web/20250417220139/https://wiki.fourthwoods.com/standard_midi_file_format
*/
import { DEFAULT_TEMPO_US_PER_QUARTER } from './playback-defaults.js';

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
/**
 * Parse one track chunk until its End-of-Track meta event, adding its tempo changes and end tick to `timing`.
 * Running status is kept across meta/sysex events, as lenient players (FluidSynth included) do.
 * @returns {boolean} whether an End-of-Track marker was found
 */
function parseTrack(reader, trackIndex, timing, onChannelEvent) {
  let tick = 0;
  let runningStatus = null;
  while (!reader.atEnd()) {
    tick += reader.varLen();
    timing.endTick = Math.max(timing.endTick, tick);
    let status = reader.peek();
    if (status & 0x80) reader.skip(1);
    else if (runningStatus === null) throw new InvalidDataError();
    else status = runningStatus;

    if (status === 0xff) {
      const type = reader.byte();
      const body = reader.bytes(reader.varLen());
      if (type === 0x51 && body.length === 3) {
        const usPerQuarter = (body[0] << 16) | (body[1] << 8) | body[2];
        if (usPerQuarter > 0) timing.tempoChanges.push({ tick, usPerQuarter });
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
      onChannelEvent(trackIndex, tick, status, data1, data2);
    }
  }
  return false;
}

/**
 * Parse header and track chunks, collecting structural damage and the file's timing.
 * @param {Uint8Array} data
 * @param {(trackIndex: number, tick: number, status: number, data1: number, data2: number) => void}
 *   [onChannelEvent] called for every channel voice message (note-on/off, program change, ...)
 * @returns {{ damage: string[],
 *   timing: { division: number, tempoChanges: { tick: number, usPerQuarter: number }[], endTick: number } | null }}
 *   `timing` is null when the header cannot be read
 */
export function parseSmf(data, onChannelEvent = () => {}) {
  const damage = [];
  const reader = new ByteReader(data, 0, data.length);
  try {
    if (reader.chunkId() !== 'MThd') {
      return { damage: ['Not a Standard MIDI File (missing MThd header)'], timing: null };
    }
    const headerLength = reader.uint32();
    if (headerLength < 6) return { damage: ['Invalid MIDI header (too short)'], timing: null };
    reader.uint16(); // format: not needed here
    const declaredTracks = reader.uint16();
    const division = reader.uint16();
    reader.skip(headerLength - 6);
    if (division === 0) return { damage: ['Invalid timing division (0) in the header'], timing: null };

    const timing = { division, tempoChanges: [], endTick: 0 };
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
        if (!parseTrack(new ByteReader(data, start, end), trackIndex, timing, onChannelEvent)) {
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
    timing.tempoChanges.sort((a, b) => a.tick - b.tick);
    return { damage, timing };
  } catch (error) {
    if (error instanceof TruncatedError) {
      return { damage: ['File is too short to contain a valid MIDI header'], timing: null };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tempo map
// ---------------------------------------------------------------------------
/**
 * SMPTE timing (top bit of the header division set) counts ticks per video frame instead of per quarter note.
 * FluidSynth does not play such files (fluid_midi_file_read_mthd: "SMPTE timing -- Not implemented yet").
 */
export function usesSmpteTiming(division) {
  return (division & 0x8000) !== 0;
}

/** Ticks ↔ seconds following every tempo change of a file. */
export class TempoMap {
  /**
   * @param {number} division SMF header division: ticks per quarter note (SMPTE timing is not supported)
   * @param {{ tick: number, usPerQuarter: number }[]} tempoChanges sorted by tick
   */
  constructor(division, tempoChanges) {
    /** Tempo at tick 0 (120 BPM if the file sets none) */
    this.initialUsPerQuarter = tempoChanges.findLast((change) => change.tick === 0)?.usPerQuarter
      ?? DEFAULT_TEMPO_US_PER_QUARTER;

    // Segments: each tempo applies from `tick` on, which is `seconds` into the file
    const toSecPerTick = (usPerQuarter) => usPerQuarter / 1e6 / division;
    this.segments = [{ tick: 0, seconds: 0, secPerTick: toSecPerTick(DEFAULT_TEMPO_US_PER_QUARTER) }];
    for (const { tick, usPerQuarter } of tempoChanges) {
      const last = this.segments.at(-1);
      if (tick === last.tick) {
        last.secPerTick = toSecPerTick(usPerQuarter); // Several changes on one tick: the last one wins
      } else {
        const seconds = last.seconds + (tick - last.tick) * last.secPerTick;
        this.segments.push({ tick, seconds, secPerTick: toSecPerTick(usPerQuarter) });
      }
    }
  }

  /** @returns {number} seconds from the start of the file at `tick` (at the file's own tempo) */
  ticksToSeconds(tick) {
    const segment = this.segments[this._segmentIndex('tick', tick)];
    return segment.seconds + (tick - segment.tick) * segment.secPerTick;
  }

  /** @returns {number} tick (fractional) at `seconds` from the start of the file (at the file's own tempo) */
  secondsToTicks(seconds) {
    const segment = this.segments[this._segmentIndex('seconds', seconds)];
    return segment.tick + (seconds - segment.seconds) / segment.secPerTick;
  }

  /** Binary search: index of the last segment whose `key` ('tick' or 'seconds') is ≤ value (0 if none). */
  _segmentIndex(key, value) {
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.segments[mid][key] <= value) low = mid;
      else high = mid - 1;
    }
    return low;
  }
}

/**
 * @param {ArrayBuffer} arrayBuffer SMF contents
 * @returns {TempoMap | null} null when the header cannot be read or uses SMPTE timing
 */
export function readTempoMap(arrayBuffer) {
  const { timing } = parseSmf(new Uint8Array(arrayBuffer));
  if (!timing || usesSmpteTiming(timing.division)) return null;
  return new TempoMap(timing.division, timing.tempoChanges);
}
