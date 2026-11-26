/* Export section: options, running an export (progress, Cancel) and its result log
   - initExportPanel(app): `app` gives access to the tracks, volume, tempo, soundfont and playback (see app.js)
*/
import { EXPORT_FORMATS } from './audio-encoder.js';
import { estimateExportBytes, exportTracks, zipFiles } from './audio-export.js';

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------
const DEFAULT_FORMAT = 'mp3vbr';
const DEFAULT_SAMPLE_RATE = 48000;
const SIZE_WARNING_BYTES = 500e6;    // Exports are built in memory: confirm above this estimated size
const PLAYLIST_ZIP_NAME = 'playlist.zip';
const UNAVAILABLE = '—';             // Sole entry of a dropdown that does not apply to the format
const CLIPPING_HELP = 'At this volume, some tracks were louder than the maximum level (−0.5 dB), so the soft '
  + 'limiter used during playback was applied to them: loud peaks are rounded off rather than cut, so the '
  + 'distortion is usually mild.\nTo avoid it, lower the volume to the recommended value (or below), '
  + 'or tick "Normalize volume".';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const exportTrackBtn = document.getElementById('exportTrackBtn');
const exportPlaylistBtn = document.getElementById('exportPlaylistBtn');
const optionsFieldset = document.getElementById('exportOptions');
const applyVolumeToggle = document.getElementById('exportApplyVolume');
const applySpeedToggle = document.getElementById('exportApplySpeed');
const trimSilenceToggle = document.getElementById('exportTrimSilence');
const normalizeToggle = document.getElementById('exportNormalize');
const normalizeScopeRadios = document.querySelectorAll('input[name="exportNormalizeScope"]');
const formatSelect = document.getElementById('exportFormat');
const qualitySelect = document.getElementById('exportQuality');
const sampleRateSelect = document.getElementById('exportSampleRate');
const bitDepthRadios = document.querySelectorAll('input[name="exportBitDepth"]');
const progressEl = document.getElementById('exportProgress');
const progressBar = document.getElementById('exportProgressBar');
const progressText = document.getElementById('exportProgressText');
const cancelBtn = document.getElementById('exportCancelBtn');
const logEl = document.getElementById('exportLog');

let exportController = null; // AbortController of the running export (Cancel button)

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
const checkedValue = (name) => document.querySelector(`input[name="${name}"]:checked`).value;

/**
 * Replace a dropdown's options, keeping `selected` when still offered (else the first option).
 * An empty list leaves the dropdown locked on UNAVAILABLE.
 * @param {HTMLSelectElement} select
 * @param {{ value: string, label: string }[]} options
 */
function setSelectOptions(select, options, selected) {
  select.replaceChildren(...(options.length > 0 ? options : [{ value: '', label: UNAVAILABLE }])
    .map(({ value, label }) => new Option(label, value)));
  select.disabled = options.length === 0;
  if (options.some((option) => option.value === selected)) select.value = selected;
}

/** Offer the qualities, sample rates and bit depths of the selected format. */
function updateFormatOptions() {
  const spec = EXPORT_FORMATS[formatSelect.value];
  setSelectOptions(qualitySelect,
    (spec.qualities ?? []).map(({ label }, index) => ({ value: String(index), label })), '0');
  setSelectOptions(sampleRateSelect,
    spec.sampleRates.map((rate) => ({ value: String(rate), label: `${rate / 1000} kHz` })),
    sampleRateSelect.value || String(DEFAULT_SAMPLE_RATE));
  for (const radio of bitDepthRadios) {
    radio.disabled = !spec.bitDepths?.includes(Number(radio.value));
  }
  if (spec.bitDepths && document.querySelector('input[name="exportBitDepth"]:checked').disabled) {
    bitDepthRadios[0].checked = true;
  }
}

/** Normalizing sets the level itself, so it replaces the volume; its scope only matters when ticked. */
function updateVolumeOptions() {
  applyVolumeToggle.disabled = normalizeToggle.checked;
  for (const radio of normalizeScopeRadios) radio.disabled = !normalizeToggle.checked;
}

/** @returns {import('./audio-export.js').ExportSettings} without the soundfont */
function readSettings(app) {
  const normalize = normalizeToggle.checked ? checkedValue('exportNormalizeScope') : null;
  return {
    format: formatSelect.value,
    qualityIndex: Number(qualitySelect.value),
    bitDepth: Number(checkedValue('exportBitDepth')),
    sampleRate: Number(sampleRateSelect.value),
    channels: Number(checkedValue('exportChannels')),
    volume: applyVolumeToggle.checked ? app.getVolume() : 1,
    normalize,
    trimSilence: trimSilenceToggle.checked,
    tempoMultiplierFor: applySpeedToggle.checked ? app.tempoMultiplierFor : () => 1,
  };
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
/** Add a line to the log; `className` styles it (export-ok, export-error). Returns the line. */
function logLine(text, className) {
  const line = document.createElement('div');
  if (className) {
    const strong = document.createElement('strong');
    strong.className = className;
    strong.textContent = text;
    line.append(strong);
  } else {
    line.textContent = text;
  }
  logEl.append(line);
  return line;
}

function logError(error) {
  console.error('[ERROR] Export failed:', error);
  logLine(`Export failed: ${error.message}`, 'export-error');
}

function logReport({ files, skipped, clippedTracks, recommendedVolume }, scope) {
  if (skipped.length > 0) {
    const list = skipped.map(({ name, reason }) => `${name} (${reason})`).join(', ');
    logLine(`Skipped, FluidSynth cannot play: ${list}`);
  }
  if (clippedTracks.length > 0) {
    const help = document.createElement('span');
    help.className = 'help';
    help.title = CLIPPING_HELP;
    help.textContent = '?';
    logLine('Warning: clipping occurred during export!', 'export-error').append(' ', help);
    logLine(`Clipped: ${clippedTracks.join(', ')}. Recommended volume: ×${recommendedVolume.toFixed(2)} or lower.`);
  } else if (files.length > 0) {
    logLine(scope === 'track' ? 'Track exported.' : 'All tracks exported.', 'export-ok');
  }
}

// ---------------------------------------------------------------------------
// Running an export
// ---------------------------------------------------------------------------
function download(bytes, fileName) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url)); // after the browser has started the download
}

function showProgress({ phase, trackNumber, trackCount, fraction }) {
  progressBar.value = fraction;
  const action = phase === 'analysing' ? 'Analysing' : 'Encoding';
  progressText.textContent = `${action} track ${trackNumber}/${trackCount} – ${Math.round(fraction * 100)}%`;
}

function setBusy(busy) {
  exportTrackBtn.disabled = busy;
  exportPlaylistBtn.disabled = busy;
  optionsFieldset.disabled = busy;
  progressEl.hidden = !busy;
  progressBar.value = 0;
  progressText.textContent = '';
}

/** @param {'track'|'playlist'} scope */
async function runExport(app, scope) {
  logEl.replaceChildren();
  const tracks = await app.getTracks(scope);
  if (tracks.length === 0) {
    logLine(scope === 'track' ? 'No track selected.' : 'The playlist is empty.');
    return;
  }
  const soundfont = app.getSoundfont();
  if (!soundfont) {
    logLine('No soundfont loaded yet.');
    return;
  }
  const settings = { ...readSettings(app), soundfont };
  const estimatedBytes = estimateExportBytes(tracks, settings);
  if (estimatedBytes > SIZE_WARNING_BYTES && !window.confirm(`This export should weigh about `
    + `${Math.round(estimatedBytes / 1e6)} MB and is built in memory, which may slow down or crash the browser tab. `
    + 'Continue?')) {
    return;
  }

  // Kept until the export ends, even if another soundfont is selected meanwhile
  soundfont.retain();
  exportController = new AbortController();
  try {
    await app.pausePlayback();
    app.setPlaybackLocked(true);
    setBusy(true);
    const result = await exportTracks(tracks, settings, { onProgress: showProgress, signal: exportController.signal });
    if (scope === 'track' && result.files.length > 0) {
      download(result.files[0].bytes, result.files[0].name);
    } else if (result.files.length > 0) {
      progressText.textContent = 'Building ZIP…';
      download(await zipFiles(result.files, settings.format), PLAYLIST_ZIP_NAME);
    }
    logReport(result, scope);
  } catch (error) {
    if (error.name === 'AbortError') logLine('Export cancelled.');
    else logError(error);
  } finally {
    exportController = null;
    setBusy(false);
    app.setPlaybackLocked(false);
    soundfont.release();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Fill the export options and wire the buttons.
 * @param {object} app
 * @param {(scope: 'track'|'playlist') => Promise<{ name: string, arrayBuffer: ArrayBuffer }[]>} app.getTracks
 * @param {() => import('./synthesizer-player.js').SharedSoundfont|null} app.getSoundfont
 * @param {() => number} app.getVolume volume slider gain
 * @param {(initialBpm: number) => number} app.tempoMultiplierFor playback speed multiplier for a file
 * @param {() => Promise<void>} app.pausePlayback
 * @param {(locked: boolean) => void} app.setPlaybackLocked
 */
export function initExportPanel(app) {
  setSelectOptions(formatSelect,
    Object.entries(EXPORT_FORMATS).map(([value, { label }]) => ({ value, label })), DEFAULT_FORMAT);
  updateFormatOptions();
  updateVolumeOptions();
  formatSelect.addEventListener('change', updateFormatOptions);
  normalizeToggle.addEventListener('change', updateVolumeOptions);
  cancelBtn.addEventListener('click', () => exportController?.abort());
  // Errors before the export starts (e.g. reading files) end up in the log too
  exportTrackBtn.addEventListener('click', () => runExport(app, 'track').catch(logError));
  exportPlaylistBtn.addEventListener('click', () => runExport(app, 'playlist').catch(logError));
}
