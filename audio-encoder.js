/* Audio file encoding with libav.js (FFmpeg's libraries compiled to WebAssembly), loaded on first use
   - EXPORT_FORMATS: formats offered by the export, with their options (qualities, bit depths, sample rates)
   - AudioFileEncoder: feed planar Float32 blocks, get the encoded file's bytes at the end
*/

import { LIBAV_DIR, LIBAV_BUILD_DIR } from './build-constants.js';

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------
// libav.js "obsolete" variant: FFmpeg's Opus, FLAC and PCM codecs plus LAME (MP3) and libvorbis
const LIBAV_ENTRY = 'libav-obsolete.mjs';

const SAMPLE_RATES = [22050, 32000, 44100, 48000, 96000]; // FluidSynth renders up to 96 kHz
const MP3_SAMPLE_RATES = [22050, 32000, 44100, 48000];     // MPEG audio stops at 48 kHz
const OPUS_SAMPLE_RATES = [48000];                         // Opus files always decode at 48 kHz
const FLAC_COMPRESSION_LEVEL = '8';  // Highest level within the FLAC subset that every player supports
const OPUS_COMPLEXITY = '10';        // libopus best quality
const FF_QP2LAMBDA = 118;            // FFmpeg's unit for quality-based (VBR) encoding: global_quality = q × this
const PCM_FRAME_SIZE = 4096;         // Block size for encoders that accept any frame length
const CHANNEL_LAYOUTS = { 1: 0x4, 2: 0x3 }; // FFmpeg channel masks: front center | front left + right
const INT16_MAX = 32767;
const INT24_MAX = 8388607;
const INT24_TO_INT32 = 256;          // 24-bit samples are passed left-aligned in 32-bit integers

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------
/** Encoder options for quality-based (VBR) encoding at FFmpeg quality `q` (like `ffmpeg -q:a q`). */
function qscale(q) {
  return { flags: '+qscale', global_quality: String(q * FF_QP2LAMBDA) };
}

/** Constant-bitrate qualities, highest first. */
function bitrates(kbpsList) {
  return kbpsList.map((kbps) => ({ label: `${kbps} kbps`, kbps, ctx: { bit_rate: kbps * 1000 } }));
}

/**
 * Export formats, in dropdown order. Each format lists:
 * - label, extension
 * - qualities: bitrate or VBR quality choices, highest first, with their (typical) kbps (null: lossless, no choice)
 * - bitDepths: 16 | 24 | 32 (32 = float) for lossless formats (null: not applicable)
 * - sampleRates: supported rates in Hz
 * - encoder(bitDepth): FFmpeg codec name and the sample format it takes
 */
export const EXPORT_FORMATS = {
  mp3: {
    label: 'MP3 (CBR)',
    extension: 'mp3',
    qualities: bitrates([320, 256, 192, 160, 128, 96]),
    bitDepths: null,
    sampleRates: MP3_SAMPLE_RATES,
    encoder: () => ({ codec: 'libmp3lame', sampleFormat: 'FLTP' }),
  },
  mp3vbr: {
    label: 'MP3 (VBR)',
    extension: 'mp3',
    // LAME presets with their average bitrates, from LAME 3.100's documentation (doc/html/usage.html):
    // https://sources.debian.org/data/main/l/lame/3.100-6/doc/html/usage.html
    // Measured averages vary by up to ~15 kbps from source to source (e.g. V0: 228–248 kbps), see also:
    // https://hydrogenaudio.org/index.php/topic,67523.0.html, https://www.lamemp3.co.uk/lame-quality-vbr/
    qualities: [[0, 245], [2, 190], [4, 160], [6, 115]]
      .map(([preset, kbps]) => ({ label: `V${preset} (~${kbps} kbps)`, kbps, options: qscale(preset) })),
    bitDepths: null,
    sampleRates: MP3_SAMPLE_RATES,
    encoder: () => ({ codec: 'libmp3lame', sampleFormat: 'FLTP' }),
  },
  opus: {
    label: 'Ogg Opus',
    extension: 'opus',
    qualities: bitrates([256, 192, 128, 96, 64, 48, 32])
      .map((quality) => ({ ...quality, options: { compression_level: OPUS_COMPLEXITY } })),
    bitDepths: null,
    sampleRates: OPUS_SAMPLE_RATES,
    encoder: () => ({ codec: 'libopus', sampleFormat: 'FLT' }),
  },
  vorbis: {
    label: 'Ogg Vorbis',
    extension: 'ogg',
    // libvorbis quality levels with their nominal bitrates for 44.1 kHz stereo
    // (https://en.wikipedia.org/wiki/Vorbis, table "Vorbis nominal bitrate at quality levels")
    qualities: [[10, 500], [8, 256], [6, 192], [5, 160], [4, 128], [3, 112]]
      .map(([q, kbps]) => ({ label: `q${q} (~${kbps} kbps)`, kbps, options: qscale(q) })),
    bitDepths: null,
    sampleRates: SAMPLE_RATES,
    encoder: () => ({ codec: 'libvorbis', sampleFormat: 'FLTP' }),
  },
  flac: {
    label: 'FLAC',
    extension: 'flac',
    qualities: null,
    bitDepths: [16, 24],
    sampleRates: SAMPLE_RATES,
    encoder: (bitDepth) => ({
      codec: 'flac',
      sampleFormat: bitDepth === 16 ? 'S16' : 'S32',
      options: { compression_level: FLAC_COMPRESSION_LEVEL },
    }),
  },
  wav: {
    label: 'WAV',
    extension: 'wav',
    qualities: null,
    bitDepths: [16, 24, 32],
    sampleRates: SAMPLE_RATES,
    encoder: (bitDepth) => ({
      16: { codec: 'pcm_s16le', sampleFormat: 'S16' },
      24: { codec: 'pcm_s24le', sampleFormat: 'S32' },
      32: { codec: 'pcm_f32le', sampleFormat: 'FLT' },
    })[bitDepth],
  },
};

// ---------------------------------------------------------------------------
// libav.js loading
// ---------------------------------------------------------------------------
let libavPromise = null;

/** Load libav.js once (≈1 MB, only when exporting); a failed load is retried on the next call. */
function loadLibav() {
  libavPromise ??= (async () => {
    const base = new URL(import.meta.env.DEV ? LIBAV_DIR : LIBAV_BUILD_DIR, document.baseURI).href;
    const { default: LibAV } = await import(/* @vite-ignore */ `${base}/${LIBAV_ENTRY}`);
    const libav = await LibAV.LibAV({ base });
    // FFmpeg errors still reach the console; its warnings (e.g. "encoding as 24 bits-per-sample") would only be noise
    await libav.av_log_set_level(libav.AV_LOG_ERROR);
    return libav;
  })().catch((error) => {
    libavPromise = null;
    throw error;
  });
  return libavPromise;
}

// ---------------------------------------------------------------------------
// Sample conversion
// ---------------------------------------------------------------------------
/** Interleaved sample formats: array type and conversion of a sample in [−1, 1]. */
const INTERLEAVED_FORMATS = {
  FLT: { ArrayType: Float32Array, convert: (x) => x },
  S16: { ArrayType: Int16Array, convert: (x) => Math.round(x * INT16_MAX) },
  S32: { ArrayType: Int32Array, convert: (x) => Math.round(x * INT24_MAX) * INT24_TO_INT32 },
};

/** Planar Float32 channels (copied) → the layout libav.js expects for `sampleFormat`. */
function toFrameData(planes, sampleFormat) {
  if (sampleFormat === 'FLTP') return planes.map((plane) => plane.slice());
  const { ArrayType, convert } = INTERLEAVED_FORMATS[sampleFormat];
  const channels = planes.length;
  const out = new ArrayType(planes[0].length * channels);
  for (let c = 0; c < channels; c++) {
    const plane = planes[c];
    for (let i = 0; i < plane.length; i++) {
      out[i * channels + c] = convert(Math.max(-1, Math.min(1, plane[i])));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------
let nextFileId = 0;

/** Encodes one audio file in libav.js's in-memory file system. */
export class AudioFileEncoder {
  /**
   * @param {object} options
   * @param {string} options.format key of EXPORT_FORMATS
   * @param {number} options.qualityIndex index in the format's qualities (ignored for lossless formats)
   * @param {number} options.bitDepth 16 | 24 | 32 (lossless formats only)
   * @param {number} options.sampleRate
   * @param {number} options.channels 1 | 2
   * @param {string} options.title written to the file's title tag
   * @returns {Promise<AudioFileEncoder>}
   */
  static async create({ format, qualityIndex, bitDepth, sampleRate, channels, title }) {
    const libav = await loadLibav();
    const spec = EXPORT_FORMATS[format];
    const { codec, sampleFormat, options } = spec.encoder(bitDepth);
    const quality = spec.qualities?.[qualityIndex] ?? {};
    const fileName = `export-${nextFileId++}.${spec.extension}`;
    const encoder = new AudioFileEncoder(libav, sampleFormat, sampleRate, channels, fileName);
    [, encoder.context, encoder.frame, encoder.packet, encoder.frameSize] = await libav.ff_init_encoder(codec, {
      ctx: {
        sample_rate: sampleRate,
        channel_layout: CHANNEL_LAYOUTS[channels],
        sample_fmt: libav[`AV_SAMPLE_FMT_${sampleFormat}`],
        ...quality.ctx,
      },
      options: { ...options, ...quality.options },
      time_base: [1, sampleRate],
    });
    encoder.frameSize ||= PCM_FRAME_SIZE;
    [encoder.muxer, , encoder.io] = await libav.ff_init_muxer({ filename: encoder.fileName, open: true },
      [[encoder.context, 1, sampleRate]]);
    await libav.AVFormatContext_metadata_s(encoder.muxer, await libav.av_dict_set_js(0, 'title', title, 0));
    await libav.avformat_write_header(encoder.muxer, 0);
    return encoder;
  }

  constructor(libav, sampleFormat, sampleRate, channels, fileName) {
    this.libav = libav;
    this.sampleFormat = sampleFormat;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.fileName = fileName;
    this.pending = Array.from({ length: channels }, () => new Float32Array(0)); // samples not yet a full frame
    this.samplesSent = 0;
    this.context = this.frame = this.packet = this.muxer = this.io = null;
  }

  /**
   * Encode planar samples (one Float32Array per channel, any length).
   * @param {Float32Array[]} planes
   */
  async encode(planes) {
    const joined = this.pending.map((pending, c) => {
      const samples = new Float32Array(pending.length + planes[c].length);
      samples.set(pending);
      samples.set(planes[c], pending.length);
      return samples;
    });
    const frames = [];
    let start = 0;
    for (; joined[0].length - start >= this.frameSize; start += this.frameSize) {
      frames.push(this._frame(joined.map((samples) => samples.subarray(start, start + this.frameSize))));
    }
    this.pending = joined.map((samples) => samples.slice(start));
    await this._write(frames, false);
  }

  /** Encode what is left, close the file and return its bytes. */
  async finish() {
    const frames = this.pending[0].length > 0 ? [this._frame(this.pending)] : [];
    await this._write(frames, true);
    await this.libav.av_write_trailer(this.muxer);
    const bytes = await this.libav.readFile(this.fileName);
    await this.dispose();
    return bytes;
  }

  /** Free the encoder and delete its file (safe to call more than once, e.g. after cancelling). */
  async dispose() {
    if (this.context === null) return;
    const { libav } = this;
    await libav.ff_free_muxer(this.muxer, this.io);
    await libav.ff_free_encoder(this.context, this.frame, this.packet);
    await libav.unlink(this.fileName);
    this.context = this.frame = this.packet = this.muxer = this.io = null;
  }

  /** libav.js frame from planar samples (one Float32Array per channel). */
  _frame(planes) {
    const length = planes[0].length;
    const frame = {
      data: toFrameData(planes, this.sampleFormat),
      format: this.libav[`AV_SAMPLE_FMT_${this.sampleFormat}`],
      channel_layout: CHANNEL_LAYOUTS[this.channels],
      sample_rate: this.sampleRate,
      nb_samples: length,
      pts: this.samplesSent,
    };
    this.samplesSent += length;
    return frame;
  }

  async _write(frames, isLast) {
    const packets = await this.libav.ff_encode_multi(this.context, this.frame, this.packet, frames, isLast);
    if (packets.length > 0) await this.libav.ff_write_multi(this.muxer, this.packet, packets);
  }
}
