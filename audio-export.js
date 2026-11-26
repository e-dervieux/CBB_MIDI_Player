/* Audio export: renders MIDI files offline with FluidSynth (set up like playback) and encodes them
   - estimateExportBytes(tracks, settings): rough output size, to warn before large in-memory exports
   - exportTracks(tracks, settings, { onProgress, signal }): encoded files and a report (clipping, skipped files)
   - zipFiles(files, format): ZIP archive of exported files
   Each track is rendered twice (FluidSynth renders identically every time): the first pass measures the
   track's peak and where its ending dies out, the second applies the gain and encodes.
*/
import { parseSmf, TempoMap, usesSmpteTiming } from './midi-file.js';
import { softClip, PEAK_CEILING, clampTempoMultiplier } from './synthesizer-player.js';
import { AudioFileEncoder, EXPORT_FORMATS } from './audio-encoder.js';

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------
const RING_OUT_DROP = 1e-3;         // After the music ends, fade once the sound is 60 dB below the track's peak…
const RING_OUT_MAX_SEC = 5;         // …or after this long (stuck notes, endless reverb)
const FADE_OUT_SEC = 0.5;           // Linear fading
const RENDER_BLOCK_FRAMES = 4096;
const BLOCKS_PER_YIELD = 8;         // Let the page repaint (progress, Cancel button) every few blocks
const US_PER_MINUTE = 60e6;
const FLAC_SIZE_RATIO = 0.6;        // FLAC vs WAV size, on the high side (size estimates must not be too low)
const WAV_ZIP_LEVEL = 1;            // Fastest deflate level: compresses WAV as well as the strongest ones
const STORED = 0;                   // Compressed formats are stored as-is in the ZIP

// ---------------------------------------------------------------------------
// Track preparation
// ---------------------------------------------------------------------------
/**
 * Read a track's timing: tempo multiplier and where its music ends (file end, or last note when trimming).
 * Files FluidSynth cannot play get a skipReason instead.
 * @param {{ name: string, arrayBuffer: ArrayBuffer }} track
 * @param {ExportSettings} settings
 */
function prepareTrack(track, settings) {
  let lastNoteTick = null;
  const { timing } = parseSmf(new Uint8Array(track.arrayBuffer), (trackIndex, tick, status) => {
    const command = status & 0xf0;
    if (command === 0x80 || command === 0x90) lastNoteTick = Math.max(lastNoteTick ?? 0, tick);
  });
  if (!timing) return { ...track, skipReason: 'not a readable MIDI file' };
  if (usesSmpteTiming(timing.division)) return { ...track, skipReason: 'SMPTE timing' };

  const tempoMap = new TempoMap(timing.division, timing.tempoChanges);
  const tempoMultiplier = clampTempoMultiplier(
    settings.tempoMultiplierFor(US_PER_MINUTE / tempoMap.initialUsPerQuarter));
  const musicEndTick = settings.trimSilence ? (lastNoteTick ?? 0) : timing.endTick;
  return { ...track, tempoMultiplier, musicEndSec: tempoMap.ticksToSeconds(musicEndTick) / tempoMultiplier };
}

/** "Song.mid" → "Song.mp3", with " (2)", " (3)"… for names already used in this export. */
function outputFileName(name, extension, usedNames) {
  const base = name.replace(/\.[^.]*$/, '');
  let fileName = `${base}.${extension}`;
  for (let n = 2; usedNames.has(fileName); n++) fileName = `${base} (${n}).${extension}`;
  usedNames.add(fileName);
  return fileName;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

function peakOf(planes) {
  let peak = 0;
  for (const plane of planes) {
    for (const x of plane) peak = Math.max(peak, Math.abs(x));
  }
  return peak;
}

/** Linear fade to silence over `fadeFrames`, starting at `fadeStart` (frames are absolute, `offset` = block start).
 * The fading shape does not matter much since we fade from -60 dB below the track's peak level.
 */
function applyFade(planes, offset, fadeStart, fadeFrames) {
  for (const plane of planes) {
    for (let i = Math.max(0, fadeStart - offset); i < plane.length; i++) {
      plane[i] *= Math.max(0, 1 - (offset + i - fadeStart) / fadeFrames);
    }
  }
}

/**
 * Render a track block by block, on a fresh synth borrowing `settings.soundfont` (a SharedSoundfont).
 * `onBlock(planes, offset)` gets one Float32Array per output channel (mono is the average of left and right)
 * and may modify it; rendering stops after `frameCount` frames or when it returns false.
 */
async function renderTrack(track, settings, frameCount, onBlock, signal) {
  const { soundfont } = settings;
  const synth = await soundfont.createSynth(settings.sampleRate, track.arrayBuffer, track.tempoMultiplier);
  try {
    const left = new Float32Array(RENDER_BLOCK_FRAMES);
    const right = new Float32Array(RENDER_BLOCK_FRAMES);
    for (let offset = 0, block = 1; offset < frameCount; offset += RENDER_BLOCK_FRAMES, block++) {
      signal.throwIfAborted();
      synth.render([left, right]);
      const length = Math.min(RENDER_BLOCK_FRAMES, frameCount - offset);
      const planes = settings.channels === 1
        ? [Float32Array.from({ length }, (_, i) => (left[i] + right[i]) / 2)]
        : [left.subarray(0, length), right.subarray(0, length)];
      if (await onBlock(planes, offset) === false) break;
      if (block % BLOCKS_PER_YIELD === 0) await yieldToBrowser();
    }
  } finally {
    soundfont.releaseSynth(synth);
  }
}

/**
 * First pass: the track's peak (FluidSynth output, before any gain) and its length, the ending fading out
 * once the sound has died out after the music (or RING_OUT_MAX_SEC at most).
 * @returns {Promise<{ peak: number, fadeStart: number, frameCount: number }>}
 */
async function analyseTrack(track, settings, onFrames, signal) {
  const { sampleRate } = settings;
  const musicEnd = Math.round(track.musicEndSec * sampleRate);
  const fadeFrames = Math.round(FADE_OUT_SEC * sampleRate);
  const ringOutEnd = musicEnd + Math.round(RING_OUT_MAX_SEC * sampleRate);
  let peak = 0;
  let fadeStart = null;
  // Blocks are shorter than the fade, so a block always starts within [ringOutEnd, ringOutEnd + fadeFrames)
  await renderTrack(track, settings, ringOutEnd + fadeFrames, (planes, offset) => {
    if (fadeStart === null && offset >= musicEnd
      && (peakOf(planes) <= peak * RING_OUT_DROP || offset >= ringOutEnd)) {
      fadeStart = offset;
    }
    if (fadeStart !== null) applyFade(planes, offset, fadeStart, fadeFrames);
    peak = Math.max(peak, peakOf(planes));
    onFrames(planes[0].length);
    return fadeStart === null || offset + planes[0].length < fadeStart + fadeFrames;
  }, signal);
  return { peak, fadeStart, frameCount: fadeStart + fadeFrames };
}

/** Second pass: gain, soft limiter when needed (as in playback), fade-out, then encoding. */
async function encodeTrack(track, analysis, gain, useLimiter, settings, encoder, onFrames, signal) {
  const fadeFrames = analysis.frameCount - analysis.fadeStart;
  await renderTrack(track, settings, analysis.frameCount, async (planes, offset) => {
    for (const plane of planes) {
      for (let i = 0; i < plane.length; i++) {
        const x = gain * plane[i];
        plane[i] = useLimiter ? softClip(x) : x;
      }
    }
    applyFade(planes, offset, analysis.fadeStart, fadeFrames);
    await encoder.encode(planes);
    onFrames(planes[0].length);
  }, signal);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * @typedef {object} ExportSettings
 * @property {string} format key of EXPORT_FORMATS
 * @property {number} qualityIndex index in the format's qualities (lossy formats)
 * @property {number} bitDepth 16 | 24 | 32 (lossless formats)
 * @property {number} sampleRate
 * @property {number} channels 1 | 2
 * @property {number} volume gain applied to FluidSynth's output (1 = FluidSynth's default level)
 * @property {null|'track'|'playlist'} normalize peak normalization (replaces volume)
 * @property {boolean} trimSilence end after the last note instead of at the end of the file
 * @property {(initialBpm: number) => number} tempoMultiplierFor speed multiplier for a file starting at this tempo
 * @property {import('./synthesizer-player.js').SharedSoundfont} soundfont held by the caller until the export ends
 */

/**
 * Rough output size, for warning before large exports (everything is built in memory).
 * @param {{ name: string, arrayBuffer: ArrayBuffer }[]} tracks
 * @param {ExportSettings} settings
 * @returns {number} bytes
 */
export function estimateExportBytes(tracks, settings) {
  const spec = EXPORT_FORMATS[settings.format];
  const bytesPerSecond = spec.qualities
    ? spec.qualities[settings.qualityIndex].kbps * 1000 / 8
    : settings.sampleRate * settings.channels * Math.ceil(settings.bitDepth / 8)
      * (settings.format === 'flac' ? FLAC_SIZE_RATIO : 1);
  return tracks
    .map((track) => prepareTrack(track, settings))
    .filter((track) => !track.skipReason)
    .reduce((total, track) => total + (track.musicEndSec + FADE_OUT_SEC) * bytesPerSecond, 0);
}

/**
 * Render and encode tracks.
 * @param {{ name: string, arrayBuffer: ArrayBuffer }[]} tracks
 * @param {ExportSettings} settings
 * @param {object} callbacks
 * @param {(progress: { phase: 'analysing'|'encoding', trackNumber: number, trackCount: number,
 *   fraction: number }) => void} callbacks.onProgress fraction: overall progress, 0…1
 * @param {AbortSignal} callbacks.signal cancels the export (the promise then rejects with an AbortError)
 * @returns {Promise<{ files: { name: string, bytes: Uint8Array }[], skipped: { name: string, reason: string }[],
 *   clippedTracks: string[], recommendedVolume: number|null }>} recommendedVolume: highest volume that would
 *   have kept every track below PEAK_CEILING without the limiter (null when nothing clipped)
 */
export async function exportTracks(tracks, settings, { onProgress, signal }) {
  const prepared = tracks.map((track) => prepareTrack(track, settings));
  const playable = prepared.filter((track) => !track.skipReason);
  const skipped = prepared.filter((track) => track.skipReason)
    .map(({ name, skipReason }) => ({ name, reason: skipReason }));

  // Progress: 2 steps per track (analysis, encoding), each advancing with its rendered frames
  const stepCount = 2 * playable.length;
  let step = 0;
  const trackProgress = (phase, index, expectedFrames) => {
    let frames = 0;
    return (newFrames) => {
      frames += newFrames;
      const fraction = (step + Math.min(1, frames / expectedFrames)) / stepCount;
      onProgress({ phase, trackNumber: index + 1, trackCount: playable.length, fraction });
    };
  };

  const analyses = [];
  for (const [index, track] of playable.entries()) {
    const expectedFrames = (track.musicEndSec + FADE_OUT_SEC) * settings.sampleRate;
    const onFrames = trackProgress('analysing', index, expectedFrames);
    analyses.push(await analyseTrack(track, settings, onFrames, signal));
    step++;
  }

  // Normalization target and limiter threshold: PEAK_CEILING (−0.5 dBFS). The margin below full scale absorbs
  // the peak overshoot of lossy encoders, which would otherwise clip when the file is played:
  // - EBU R 128 sets −1 dBTP for broadcast production, adding that "Permitted Maximum True Peak Levels may be lower for
  //   different distribution systems and data reduction rates" (https://tech.ebu.ch/docs/r/r128v4_0.pdf)
  // - EBU Tech 3344: "relatively low bitrates [...] in general cause a rise of overshoots. On high bitrates, a
  //   higher limiter level might be possible" (https://tech.ebu.ch/docs/tech/tech3344.pdf)
  // Measured on renders from this app (demo and two other files) normalized to −0.1 dB, then encoded and
  // decoded: peaks rose by at most 0.2 dB (MP3 128–320 kbps, Opus 32–256 kbps, Vorbis q3–q10), so −0.5 dB is
  // enough where −1 dB would cost loudness for nothing.
  const maxPeak = Math.max(0, ...analyses.map((analysis) => analysis.peak));
  const gainFor = (peak) => {
    if (settings.normalize === null) return settings.volume;
    const reference = settings.normalize === 'playlist' ? maxPeak : peak;
    return reference > 0 ? PEAK_CEILING / reference : 1;
  };

  const spec = EXPORT_FORMATS[settings.format];
  const usedNames = new Set();
  const files = [];
  const clippedTracks = [];
  for (const [index, track] of playable.entries()) {
    const analysis = analyses[index];
    const gain = gainFor(analysis.peak);
    const useLimiter = analysis.peak * gain > PEAK_CEILING;
    if (useLimiter) clippedTracks.push(track.name);
    const encoder = await AudioFileEncoder.create({ ...settings, title: track.name.replace(/\.[^.]*$/, '') });
    try {
      await encodeTrack(track, analysis, gain, useLimiter, settings, encoder,
        trackProgress('encoding', index, analysis.frameCount), signal);
      files.push({ name: outputFileName(track.name, spec.extension, usedNames), bytes: await encoder.finish() });
    } finally {
      await encoder.dispose();
    }
    step++;
  }

  const recommendedVolume = clippedTracks.length > 0 ? PEAK_CEILING / maxPeak : null;
  return { files, skipped, clippedTracks, recommendedVolume };
}

/**
 * ZIP archive of exported files: WAV is deflated (it shrinks a lot), other formats are already compressed.
 * @param {{ name: string, bytes: Uint8Array }[]} files
 * @param {string} format key of EXPORT_FORMATS
 * @returns {Promise<Uint8Array>}
 */
export async function zipFiles(files, format) {
  const { zip } = await import('fflate');
  const level = format === 'wav' ? WAV_ZIP_LEVEL : STORED;
  const entries = Object.fromEntries(files.map(({ name, bytes }) => [name, [bytes, { level }]]));
  return new Promise((resolve, reject) => {
    zip(entries, (error, archive) => (error ? reject(error) : resolve(archive)));
  });
}
