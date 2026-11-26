/* MIDI Player App (FluidSynth via js-synthesizer)
  - Robust transport state with internal tick source of truth
  - DRY helpers for playlist navigation and time conversion
  - Clear separation of concerns and comments for maintainability
*/

import { DEFAULT_BPM, DEFAULT_BUNDLED_SF2_NAME } from './playback-defaults.js';
import { JSSynthPlayer, CLIP_LEVEL } from './synthesizer-player.js';
import { checkMidiFile } from './midi-file-check.js';
import { TempoMap, readTempoMap } from './midi-file.js';
import { initExportPanel } from './export-panel.js';

// ---------------------------------------------------------------------------
// Constants / Config
// ---------------------------------------------------------------------------
const UI_UPDATE_INTERVAL_MS = 50;     // ~20 fps timeline updates
const DEFAULT_PPQ = 480;              // PPQ = Pulses Per Quarter note (MIDI tick resolution)
const PAUSE_LOW_POWER_MS = 30000;     // 30s to fully suspend when paused
const SUPPORTED_MIDI_EXTENSIONS = ['mid', 'midi', 'mld', 'mml', 'mmi', 'ms2mml', 'mms'];
const SEEK_SLIDER_MAX = 1000;         // range max for seek slider
const KEYBOARD_SEEK_STEP_SEC = 5;     // Wall-clock seconds for ArrowLeft / ArrowRight Seek
const TEST_BEEP_DURATION_MS = 1000;   // test beep duration
const AUDIO_STATE = Object.freeze({
  playing: 'playing',   // full pipeline active (context resumed, main + heartbeat connected)
  paused: 'paused',     // playback stopped but graph kept warm for instant resume
  stopped: 'stopped',   // minimize CPU (disconnect nodes, optionally suspend context)
  lowPower: 'lowPower', // like stopped; entered after idle pause timeout for battery savings
  wakeUp: 'wakeUp'      // transient state to quickly resume context and reconnect nodes
});
const SOUND_DATA_PATH = './sound_data/';
const customSf2Registry = new Map();  // Registry for custom SF2s added during this session: name -> ArrayBuffer

/** Slider range for relative playback speed (maps to FluidSynth internal tempo multiplier when base = T_ref). */
const TEMPO_FACTOR_MIN = 0.5;
const TEMPO_FACTOR_MAX = 2;
const TEMPO_FACTOR_STEP = 0.05;
const TEMPO_FACTOR_DEFAULT = 1;
/**
 * Volume slider: position 0…VOLUME_SLIDER_MAX, midpoint = ×1 (unity master gain).
 * Lower half is quadratic (0 → ×1), upper half is linear in dB (×1 → ×VOLUME_GAIN_MAX).
 */
const VOLUME_SLIDER_MAX = 100;
const VOLUME_GAIN_MAX = 10;           // +20 dB
const VOLUME_GAIN_DEFAULT = 1;
const VOLUME_GAIN_DANGER = 3;         // Track turns red from here (orange between ×1 and this)
/** Reasonable manual BPM input range (extremes still clamped into FluidSynth 0.001…1000 multiplier). */
const MANUAL_BPM_MIN = 1;
const MANUAL_BPM_MAX = 1000;

// ---------------------------------------------------------------------------
// App State
// ---------------------------------------------------------------------------
let player;              // JSSynthPlayer instance
const playlist = [];     // { name, ext, file, arrayBuffer? }
let currentIndex = -1;   // active playlist index
let isPlaying = false;   // transport state (true while playing)
let autoplay = true;     // autoplay toggle state
let playbackLocked = false; // true while an audio export runs (Play does nothing)

/** Canonical tempo state updated when a file sets T_ref; controls (checkbox, inputs, slider) stay in the DOM. */
const tempoStore = {
  trackRefBpm: DEFAULT_BPM,
};

// ---------------------------------------------------------------------------
// Timing State Management
// ---------------------------------------------------------------------------
class TimingState {
  constructor() {
    // Playback speed multiplier currently applied by FluidSynth (set by setTempoState); kept across tracks
    this.speed = 1;
    this.reset();
  }

  /** Reset to default values (used when loading new track). */
  reset() {
    this.currentTick = 0;                              // source of truth for playhead
    this.totalTicks = 0;                               // track length in ticks
    this.tempoMap = new TempoMap(DEFAULT_PPQ, []);     // replaced by the file's own map once read
  }

  /**
   * Ticks → seconds for the timeline: follows every tempo change of the file, divided by the speed
   * multiplier (FluidSynth scales all tempos by it), so these are listening seconds at the current speed.
   */
  ticksToSeconds(ticks) {
    return this.tempoMap.ticksToSeconds(ticks) / this.speed;
  }

  /** Seconds at the current speed → ticks (inverse of ticksToSeconds, fractional). */
  secondsToTicks(seconds) {
    return this.tempoMap.secondsToTicks(seconds * this.speed);
  }

  /** Clamp currentTick to valid range. */
  clampTick() {
    this.currentTick = Math.max(0, Math.min(this.currentTick, this.totalTicks));
  }
}

const timing = new TimingState();
let rafId = 0;                       // UI loop handle
let suppressFirstSynthRead = false;  // Skip one synth tick read on play to avoid flicker
let lastUi = { cur: '', tot: '', seek: '' };
let pauseLowPowerTimer = 0;

// ---------------------------------------------------------------------------
// DOM Elements
// ---------------------------------------------------------------------------
const midiInput = document.getElementById('midiInput');
const playlistEl = document.getElementById('playlist');
const playPauseBtn = document.getElementById('playPauseBtn');
const rewindBtn = document.getElementById('rewindBtn');
const stopBtn = document.getElementById('stopBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const seekEl = document.getElementById('seek');
const volumeEl = document.getElementById('volume');
const volumeValueEl = document.getElementById('volumeValue');
const volumeResetBtn = document.getElementById('volumeResetBtn');
const clipIndicatorEl = document.getElementById('clipIndicator');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const trackTitleEl = document.getElementById('trackTitle');
const autoplayToggle = document.getElementById('autoplayToggle');
const loopEnableToggle = document.getElementById('loopEnableToggle');
const loopModeField = document.getElementById('loopModeField');
const loopModeTrack = document.getElementById('loopModeTrack');
const loopModePlaylist = document.getElementById('loopModePlaylist');
const sf2Input = document.getElementById('sf2Input');
const midiTempoDefinedToggle = document.getElementById('midiTempoDefinedToggle');
const tempoBaseInput = document.getElementById('tempoBaseInput');
const tempoEffectiveInput = document.getElementById('tempoEffectiveInput');
const tempoFactorSlider = document.getElementById('tempoFactorSlider');
const tempoFactorValueEl = document.getElementById('tempoFactorValue');
const tempoFactorResetBtn = document.getElementById('tempoFactorResetBtn');
const tempoControlsEl = document.querySelector('.tempo-controls');
const sf2Select = document.getElementById('sf2Select');
const refreshSf2Btn = document.getElementById('refreshSf2Btn');
const testBeepBtn = document.getElementById('testBeepBtn');
const testChordBtn = document.getElementById('testChordBtn');
const playDemoBtn = document.getElementById('playDemoBtn');

// Disable MIDI Test button until synth and SF2 are loaded
testChordBtn.disabled = true;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
/** Log debug messages */
function debug(message, ...args) {
  console.log('[DEBUG]', message, ...args);
}

/** Set play/pause button icon and aria-label consistently. */
function setPlayPauseIcon(isPlayingState) {
  playPauseBtn.textContent = isPlayingState ? '⏸️' : '▶️';
  playPauseBtn.setAttribute('title', isPlayingState ? 'Pause' : 'Play');
}

/**
 * True when keyboard shortcuts should not run (focus in a text-entry or native arrow/space navigation control).
 * Excludes button-like inputs (checkbox, range, etc.) so shortcuts still work from those.
 */
function isKeyboardShortcutSuppressed(target) {
  if (!target || target.nodeType !== Node.ELEMENT_NODE) return false;
  const field = target.closest('input, textarea, select, [contenteditable="true"]');
  if (!field) return false;
  if (field.isContentEditable && field.getAttribute('contenteditable') !== 'false') return true;
  if (field.tagName === 'TEXTAREA') return !(field.disabled || field.readOnly);
  if (field.tagName === 'SELECT') return !field.disabled;
  if (field.tagName === 'INPUT') {
    if (field.disabled || field.readOnly) return false;
    const type = (field.type || 'text').toLowerCase();
    const noCharEntry = new Set([
      'button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'hidden', 'image', 'color'
    ]);
    return !noCharEntry.has(type);
  }
  return true;
}

/** Safely call a player method with error handling. */
function safePlayerCall(method, ...args) {
  try {
    if (player && typeof method === 'function') {
      return method.apply(player, args);
    }
  } catch (error) {
    console.error('[ERROR] Failed to call player method:', error);
  }
}

/** Safely call a synth method with error handling. */
async function safeSynthCall(method, ...args) {
  try {
    if (player && player._synth && typeof method === 'function') {
      return await method.apply(player._synth, args);
    }
  } catch (error) {
    console.error('[ERROR] Failed to call synth method:', error);
  }
  return null;
}

/** Safely clear a timeout with error handling. */
function safeClearTimeout(timerId, errorContext = 'timer') {
  try {
    if (timerId) {
      clearTimeout(timerId);
      return 0;
    }
  } catch (error) {
    console.error(`[ERROR] Failed to clear ${errorContext}:`, error);
  }
  return 0;
}

/** Debug tick state for end-detection issues. */
function debugTickState(label) {
  try {
    if (player && player._synth) {
      const cur = player._synth.retrievePlayerCurrentTick();
      const tot = player._synth.retrievePlayerTotalTicks();
      const isPlayingFn = player._synth.isPlayerPlaying ? player._synth.isPlayerPlaying() : null;
      Promise.all([cur, tot]).then(([current, total]) => {
        console.log(`[TICK_DEBUG] ${label}: synth_current=${current}, synth_total=${total}, synth_playing=${isPlayingFn}, app_currentTick=${timing.currentTick}, app_totalTicks=${timing.totalTicks}, isPlaying=${isPlaying}`);
      });
    } else {
      console.log(`[TICK_DEBUG] ${label}: no synth, app_currentTick=${timing.currentTick}, app_totalTicks=${timing.totalTicks}, isPlaying=${isPlaying}`);
    }
  } catch(e) {
    console.log(`[TICK_DEBUG] ${label}: error:`, e);
  }
}

/**
 * Format seconds to mm:ss or h:mm:ss.
 * @param {number} seconds
 * @returns {string}
 */
function formatTimeStr(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return '00:00';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Playlist helpers
/** @returns {number} number of tracks in playlist */
function getTrackCount() { return playlist.length; }
/** @returns {boolean} true if exactly one track */
function hasSingleTrack() { return getTrackCount() === 1; }
/** Create a playlist list item with actions and wiring. */
function createPlaylistItem(name) {
  const listItem = document.createElement('li');
  const titleSpan = document.createElement('span');
  titleSpan.className = 'title';
  titleSpan.textContent = name;
  const actionsContainer = document.createElement('span');
  actionsContainer.className = 'playlist-actions';
  const playButton = document.createElement('button');
  playButton.textContent = 'Play';
  playButton.addEventListener('click', async () => {
    try {
      const indexInList = [...playlistEl.children].indexOf(listItem);
      await loadTrack(indexInList);
      playTrack();
    } catch (error) {
      console.error('[ERROR] Failed to play track from playlist:', error);
    }
  });
  const removeButton = document.createElement('button');
  removeButton.textContent = '✕';
  removeButton.title = 'Remove';
  removeButton.addEventListener('click', () => {
    const indexInList = [...playlistEl.children].indexOf(listItem);
    if (indexInList === currentIndex) {
      stopTrack();
      setCurrentIndex(-1);
      trackTitleEl.textContent = '—';
    } else if (indexInList < currentIndex) {
      setCurrentIndex(currentIndex - 1);
    }
    playlist.splice(indexInList, 1);
    listItem.remove();
    highlightActive();
  });
  actionsContainer.appendChild(playButton);
  actionsContainer.appendChild(removeButton);
  listItem.appendChild(titleSpan);
  listItem.appendChild(actionsContainer);
  listItem.addEventListener('dblclick', async () => {
    try {
      const indexInList = [...playlistEl.children].indexOf(listItem);
      await loadTrack(indexInList);
      playTrack();
    } catch (error) {
      console.error('[ERROR] Failed to play track from double-click:', error);
    }
  });
  return listItem;
}
/** Whether the Loop checkbox is on (Track/Playlist radios are only active when this is true). */
function isLoopEnabled() {
  return loopEnableToggle.checked;
}

/** @returns {'track' | 'playlist'} */
function getLoopMode() {
  return loopModeTrack.checked ? 'track' : 'playlist';
}

/** Enable/disable loop mode radios to match the Loop checkbox; dim container when off. */
function syncLoopModeRadiosUi() {
  const enabled = isLoopEnabled();
  loopModeField.classList.toggle('loop-mode--disabled', !enabled);
  loopModeTrack.disabled = !enabled;
  loopModePlaylist.disabled = !enabled;
}

// ---------------------------------------------------------------------------
// Tempo (FluidSynth internal multiplier)
// All changes go through setTempoState() so UI + engine stay aligned.
// ---------------------------------------------------------------------------

/** Set currentIndex and sync tempo control availability. */
function setCurrentIndex(i) {
  currentIndex = i;
  syncTempoControlsAvailability();
}

/** Returns store T_ref if valid, otherwise DEFAULT_BPM. */
function getTrackRefBpmSafe() {
  const t = tempoStore.trackRefBpm;
  return (t > 0 && Number.isFinite(t)) ? t : DEFAULT_BPM;
}

/** µs per quarter note → BPM (60 seconds = 60e6 µs per minute). */
function usPerQuarterToBpm(us) {
  if (typeof us !== 'number' || us <= 0) return NaN;
  return 60_000_000 / us;
}

function isMidiTempoDefinedChecked() {
  return midiTempoDefinedToggle.checked;
}

function getTempoFactorFromSlider() {
  const v = Number(tempoFactorSlider.value);
  return Number.isFinite(v) ? v : TEMPO_FACTOR_DEFAULT;
}

/** Two-decimal readout for the speed slider (tabular width fixed in CSS). */
function formatTempoFactorReadout(factor) {
  const f = Number(factor);
  return Number.isFinite(f) ? f.toFixed(2) : TEMPO_FACTOR_DEFAULT.toFixed(2);
}

function updateTempoFactorReadout() {
  tempoFactorValueEl.textContent = formatTempoFactorReadout(getTempoFactorFromSlider());
}

/** Apply MANUAL_BPM_* to the base BPM number input; constants are the single source of truth (not index.html). */
function applyTempoBaseInputBounds() {
  tempoBaseInput.min = String(MANUAL_BPM_MIN);
  tempoBaseInput.max = String(MANUAL_BPM_MAX);
}

/** Apply TEMPO_FACTOR_* to the Speed × range input; constants are the single source of truth (not index.html). */
function applyTempoFactorSliderDomFromConstants() {
  tempoFactorSlider.min = String(TEMPO_FACTOR_MIN);
  tempoFactorSlider.max = String(TEMPO_FACTOR_MAX);
  tempoFactorSlider.step = String(TEMPO_FACTOR_STEP);
  tempoFactorSlider.value = String(TEMPO_FACTOR_DEFAULT);
  updateTempoFactorReadout();
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------
/** Slider position (0…1) → linear gain: quadratic below the midpoint, dB-linear above, ×1 at 0.5. */
function volumePositionToGain(position) {
  if (position <= 0.5) return (2 * position) ** 2;
  return VOLUME_GAIN_MAX ** (2 * position - 1);
}

/** Inverse of volumePositionToGain. */
function volumeGainToPosition(gain) {
  if (gain <= 1) return Math.sqrt(gain) / 2;
  return (1 + Math.log(gain) / Math.log(VOLUME_GAIN_MAX)) / 2;
}

function getVolumeGainFromSlider() {
  return volumePositionToGain(Number(volumeEl.value) / VOLUME_SLIDER_MAX);
}

function setVolumeSliderGain(gain) {
  volumeEl.value = String(volumeGainToPosition(gain) * VOLUME_SLIDER_MAX);
}

/**
 * Latched clip indicator: raised by the player's onClip callback, cleared when the volume is lowered.
 * @param {number} level CLIP_LEVEL
 */
function setClipIndicator(level) {
  clipIndicatorEl.textContent = {
    [CLIP_LEVEL.none]: 'No clipping yet',
    [CLIP_LEVEL.mild]: 'Mild clipping.',
    [CLIP_LEVEL.severe]: 'CLIPPING!',
  }[level];
  clipIndicatorEl.classList.toggle('clip-indicator--mild', level === CLIP_LEVEL.mild);
  clipIndicatorEl.classList.toggle('clip-indicator--severe', level === CLIP_LEVEL.severe);
}

function updateVolumeReadout() {
  volumeValueEl.textContent = `×${getVolumeGainFromSlider().toFixed(2)}`;
}

/** Apply VOLUME_* to the volume range input and its track colors; constants are the single source of truth (not index.html). */
function applyVolumeSliderDomFromConstants() {
  volumeEl.min = '0';
  volumeEl.max = String(VOLUME_SLIDER_MAX);
  volumeEl.step = '1';
  setVolumeSliderGain(VOLUME_GAIN_DEFAULT);
  volumeEl.style.setProperty('--volume-danger-start', `${volumeGainToPosition(VOLUME_GAIN_DANGER) * 100}%`);
  updateVolumeReadout();
}

/** Active base BPM: file reference when MIDI-defined, else user field (HTML min/max enforces range). */
function getActiveBaseBpm(Tref = getTrackRefBpmSafe()) {
  if (isMidiTempoDefinedChecked()) return Tref;
  const raw = Number(tempoBaseInput.value);
  if (!Number.isFinite(raw) || raw <= 0) {
    console.warn('[WARN] Manual BPM invalid; using reference BPM', Tref);
    return Tref;
  }
  return raw;
}

/**
 * Internal multiplier: factor × (T_active / T_ref). Matches uniform scaling of all MIDI tempo events.
 * @param {number} [Tref] starting BPM of the file (default: the loaded track's)
 */
function computeInternalTempoMultiplier(Tref = getTrackRefBpmSafe()) {
  const factor = getTempoFactorFromSlider();
  const Tactive = getActiveBaseBpm(Tref);
  return factor * (Tactive / Tref);
}

function formatBpmForDisplay(bpm) {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm)) return '—';
  return String(Math.round(bpm * 100) / 100);
}

function updateTempoEffectiveDisplay() {
  const eff = getActiveBaseBpm() * getTempoFactorFromSlider();
  tempoEffectiveInput.value = formatBpmForDisplay(eff);
  updateTempoFactorReadout();
}

/** Grey out tempo block when no track; lock base field when using MIDI reference. */
function syncTempoControlsAvailability() {
  const hasTrack = currentIndex >= 0 && getTrackCount() > 0;
  tempoControlsEl.classList.toggle('tempo-controls--inactive', !hasTrack);
  midiTempoDefinedToggle.disabled = !hasTrack;
  tempoFactorSlider.disabled = !hasTrack;
  tempoFactorResetBtn.disabled = !hasTrack;
  tempoBaseInput.disabled = !hasTrack || isMidiTempoDefinedChecked();
}

/** After load or when turning MIDI-defined on: show T_ref in the base field. */
function syncTempoBaseFieldFromReference() {
  if (isMidiTempoDefinedChecked()) {
    tempoBaseInput.value = String(Math.round(getTrackRefBpmSafe() * 100) / 100);
  }
}

/**
 * Apply optional tempo patch, then refresh UI and/or FluidSynth so everything stays consistent.
 *
 * @param {object} [patch]
 * @param {number} [patch.trackRefBpm]  File reference BPM (T_ref) when loading or re-reading tempo
 * @param {boolean} [patch.skipUi]      Only push multiplier to engine (e.g. after resetPlayer cleared it)
 * @param {boolean} [patch.skipEngine] Only refresh UI (no player write)
 */
async function setTempoState(patch = {}) {
  if (patch.trackRefBpm !== undefined) {
    const v = Number(patch.trackRefBpm);
    tempoStore.trackRefBpm = (Number.isFinite(v) && v > 0) ? v : DEFAULT_BPM;
  }
  if (!patch.skipUi) {
    syncTempoBaseFieldFromReference();
    syncTempoControlsAvailability();
    updateTempoEffectiveDisplay();
  }
  if (patch.skipEngine) return;
  if (currentIndex < 0) return;
  await ensurePlayer();
  if (!player) return;
  const appliedSpeed = player.setPlayerTempoMultiplier(computeInternalTempoMultiplier());
  if (appliedSpeed !== undefined) timing.speed = appliedSpeed;
}

/**
 * Next index when advancing due to player end.
 * Honors Loop mode and Autoplay; returns null when stopping or when looping the current track.
 */
function getNextIndexForPlayer() {
  const len = getTrackCount();
  if (len === 0) return null;
  if (hasSingleTrack()) return null; // handled in onEnded
  if (isLoopEnabled() && getLoopMode() === 'track') return null;
  if (isLoopEnabled() && getLoopMode() === 'playlist') return (currentIndex + 1) % len;
  if (autoplay) return currentIndex < len - 1 ? currentIndex + 1 : null;
  return null;
}
/** Next index for UI button (always wraps). */
function getNextIndexForButton() {
  const len = getTrackCount();
  return len === 0 ? -1 : (currentIndex + 1) % len;
}
/** Previous index for UI button (always wraps). */
function getPrevIndexForButton() {
  const len = getTrackCount();
  return len === 0 ? -1 : (currentIndex - 1 + len) % len;
}

// ---------------------------------------------------------------------------
// Player lifecycle
// ---------------------------------------------------------------------------
/** Ensure a singleton JSSynthPlayer is ready; returns it. */
async function ensurePlayer() {
  if (!player) {
    debug('Initializing JSSynthPlayer');
    player = new JSSynthPlayer();
    // Constructor kicks off async _init(); block until WASM + audio graph are ready.
    if (typeof player._waitForReady === 'function') {
      await player._waitForReady();
    }
    debug('JSSynthPlayer ready');
    player.setVolume(getVolumeGainFromSlider());
    player.setOnClip(setClipIndicator);
    // UI loop will start on first play to reduce idle CPU
    // Subscribe to audio heartbeat so onEnded triggers in background tabs
    if (typeof player.setOnAudioTick === 'function') {
      player.setOnAudioTick(() => {
        // Fast end detection without rAF
        checkForTrackEnd('heartbeat');
      });
    }
  }
  return player;
}

// ---------------------------------------------------------------------------
// End-of-track detection
// ---------------------------------------------------------------------------
/** Check if track has ended and trigger onEnded if needed. */
function checkForTrackEnd(context = 'unknown') {
  try {
    if (!isPlaying || !player || !player._synth) return;

    const reachedEnd = (timing.totalTicks > 0 && timing.currentTick >= timing.totalTicks - 1);
    const synthStopped = (typeof player._synth.isPlayerPlaying === 'function' && !player._synth.isPlayerPlaying());

    if (reachedEnd || synthStopped) {
      debugTickState(`${context} end detected`);
      debugTickState(`onEnded triggered from ${context}`);
      onEnded();
    }
  } catch (error) {
    console.error(`[ERROR] End detection failed in ${context}:`, error);
  }
}

// ---------------------------------------------------------------------------
// Timeline update loop (three focused helpers + coordinator)
// ---------------------------------------------------------------------------

/** Sync currentTick from synth while playing. */
async function syncTickFromSynth() {
  if (!isPlaying) return;
  if (suppressFirstSynthRead) {
    // Clear guard; use current tick for this frame to avoid flicker right after seek+play
    suppressFirstSynthRead = false;
    return;
  }
  const tick = await safeSynthCall(player._synth?.retrievePlayerCurrentTick);
  if (tick !== null) timing.currentTick = tick;
}

/** Read the song length from the synth if it was not available yet (e.g. right after loading). */
async function syncTotalTicksFromSynth() {
  if (!player._synth || timing.totalTicks > 0) return;
  const totalTicks = await safeSynthCall(player._synth?.retrievePlayerTotalTicks);
  if (typeof totalTicks === 'number' && totalTicks > 0) timing.totalTicks = totalTicks;
}

/** Render timeline labels and seek slider from current timing state (pure DOM update). */
function renderTimeline() {
  const currentSec = timing.ticksToSeconds(timing.currentTick);
  const totalSec = timing.ticksToSeconds(timing.totalTicks);
  const curStr = formatTimeStr(currentSec);
  const totStr = formatTimeStr(totalSec);
  // Seek slider position is proportional to time, so it moves steadily and matches the labels across tempo changes
  const seekStr = totalSec > 0 ? Math.round((currentSec / totalSec) * SEEK_SLIDER_MAX).toString() : '0';
  // Update DOM only when values actually change (avoids unnecessary reflow)
  if (curStr !== lastUi.cur) { currentTimeEl.textContent = curStr; lastUi.cur = curStr; }
  if (totStr !== lastUi.tot) { totalTimeEl.textContent = totStr; lastUi.tot = totStr; }
  if (seekStr !== lastUi.seek) { seekEl.value = seekStr; lastUi.seek = seekStr; }
}

/** Sync state from synth then render timeline labels and seek slider. */
async function updateTimeline() {
  if (!player) return;
  await syncTickFromSynth();
  await syncTotalTicksFromSynth();
  renderTimeline();
}

/** After PAUSE_LOW_POWER_MS, fully suspend/disable audio while paused. */
function schedulePauseLowPower() {
  pauseLowPowerTimer = safeClearTimeout(pauseLowPowerTimer, 'pause timer');
  pauseLowPowerTimer = setTimeout(() => {
    if (!isPlaying && player) {
      safePlayerCall(player.setAudioState, AUDIO_STATE.lowPower);
    }
  }, PAUSE_LOW_POWER_MS);
}

/** Cancel low-power timer and wake audio (used when resuming). */
function cancelPauseLowPower() {
  pauseLowPowerTimer = safeClearTimeout(pauseLowPowerTimer, 'pause timer in cancel');
  // Wake up audio immediately
  safePlayerCall(player.setAudioState, AUDIO_STATE.wakeUp);
}

/** Clear the pending low-power timer without waking audio. */
function clearPauseLowPowerTimer() {
  pauseLowPowerTimer = safeClearTimeout(pauseLowPowerTimer, 'pause timer in clear');
}

/** rAF-driven UI loop (runs only while playing). */
function uiLoop() {
  if (!isPlaying) return;
  const now = performance.now();
    if (!uiLoop._last || now - uiLoop._last > UI_UPDATE_INTERVAL_MS) {
      updateTimeline();
      checkForTrackEnd('uiLoop');
      uiLoop._last = now;
    }
  rafId = requestAnimationFrame(uiLoop);
}

/** Start/stop UI loop helpers. */
function startUiLoop(){ if (!rafId) rafId = requestAnimationFrame(uiLoop); }
function stopUiLoop(){ if (rafId) { cancelAnimationFrame(rafId); rafId = 0; uiLoop._last = 0; } }

// ---------------------------------------------------------------------------
// Transport controls
// ---------------------------------------------------------------------------
/** Handle track end: loop/advance/stop according to settings. */
function onEnded() {
  debug('onEnded triggered');
  isPlaying = false;
  setPlayPauseIcon(false);
  const len = getTrackCount();
  const loopOn = isLoopEnabled();

  if (len === 1) {
    if (loopOn) {
      // Loop single track without reloading to avoid artifacts
      timing.currentTick = 0;
      if (typeof player.seek === 'function') player.seek(0);
      playTrack();
    } else {
      stopTrack();
    }
    return;
  }

  // Multi-track: repeat current song when Loop → Track; playlist wrap uses getNextIndexForPlayer.
  if (loopOn && getLoopMode() === 'track') {
    timing.currentTick = 0;
    if (player && typeof player.seek === 'function') player.seek(0);
    playTrack();
    return;
  }

  const nextIdx = getNextIndexForPlayer();
  if (nextIdx != null) {
    loadTrack(nextIdx).then(() => playTrack());
  } else {
    stopTrack();
  }
}

/** Start playback from currentTick, enabling audio and UI loops. */
async function playTrack() {
  await ensurePlayer();
  if (!player || currentIndex < 0 || playbackLocked) return;
  debugTickState('playTrack start');
  debug('Play requested at index', currentIndex, 'title:', trackTitleEl.textContent);
  // Sync synth to our internal position first
  try {
    if (typeof player.seek === 'function') player.seek(timing.currentTick);
  } catch (error) {
    console.error('[ERROR] Failed to seek to current tick:', error);
  }
  debugTickState('after seek');
  // Ensure the first UI frame after play uses our current state (post-seek)
  suppressFirstSynthRead = true;
  player.play();
  debugTickState('after play');
  isPlaying = true;
  setPlayPauseIcon(true);
  // Ensure audio graph is active and heartbeat enabled while playing
  safePlayerCall(player.setAudioState, AUDIO_STATE.playing);
  startUiLoop();
  cancelPauseLowPower();
}

/** Pause playback, keep position and schedule low-power. */
async function pauseTrack() {
  await ensurePlayer();
  if (!player) return;
  debug('Pause requested');
  const tick = await safeSynthCall(player._synth?.retrievePlayerCurrentTick);
  if (tick !== null) timing.currentTick = tick;
  if (typeof player.pause === 'function') player.pause();
  isPlaying = false;
  setPlayPauseIcon(false);
  updateTimeline();
  // When paused, keep main node connected (so resume is instant), but we can suspend context if tab hidden
  safePlayerCall(player.setAudioState, AUDIO_STATE.paused);
  stopUiLoop();
  schedulePauseLowPower();
}

/** Stop playback and reset to zero, fully suspending audio. */
async function stopTrack() {
  await ensurePlayer();
  if (!player) return;
  debug('Stop requested');
  if (typeof player.pause === 'function') player.pause();
  timing.currentTick = 0;
  if (typeof player.seek === 'function') {
    // When track ends, player may be in "ended" state - try to restart it cleanly
    try {
      if (player._synth && player._lastSmfBytes) {
        // Stop and reset to clear "ended" state, then reload SMF data
        if (typeof player._synth.stopPlayer === 'function') {
          player._synth.stopPlayer();
        }
        if (typeof player._synth.resetPlayer === 'function') {
          await player._synth.resetPlayer();
        }
        // Reload the SMF data to restart from clean state
        await player._synth.addSMFDataToPlayer(player._lastSmfBytes);
        // Now seek to 0 should work
        if (typeof player._synth.seekPlayer === 'function') {
          player._synth.seekPlayer(0);
        }
      } else {
        // Fallback to simple seek if we don't have cached bytes
        player.seek(0);
      }
    } catch(e) {
      debug('Error restarting player, using fallback:', e);
      player.seek(0);
    }
  }
  isPlaying = false;
  setPlayPauseIcon(false);
  // Centralized UI render
  await updateTimeline();
  // Reduce CPU: disable heartbeat; optionally suspend context
  safePlayerCall(player.setAudioState, AUDIO_STATE.stopped);
  stopUiLoop();
  clearPauseLowPowerTimer();
  // resetPlayer (above) clears FluidSynth's internal tempo multiplier; reapply it.
  await setTempoState({ skipUi: true });
}

/** Toggle between play and pause; loads first track if none active. */
async function togglePlayPause() {
  await ensurePlayer();
  if (isPlaying) { await pauseTrack(); }
  else {
    if (currentIndex === -1 && getTrackCount() > 0) await loadTrack(0);
    playTrack();
  }
}

/** Seek to the beginning of the current track without changing play state. */
async function rewindToBeginning() {
  await ensurePlayer();
  if (!player || currentIndex === -1) return;
  debug('Rewind to beginning requested');
  try {
    // Prefer underlying synth seek when available for reliability
    if (player._synth && typeof player._synth.seekPlayer === 'function') {
      player._synth.seekPlayer(0);
    }
    if (typeof player.seek === 'function') {
      await player.seek(0);
    }
    timing.currentTick = 0;
    // Centralized UI render
    await updateTimeline();
  } catch (e) {
    debug('Error seeking to beginning:', e);
  }
}

/** Nudge playhead by Δ seconds of wall-clock playback time (same basis as timeline labels). */
async function seekByWallClockSeconds(deltaSec) {
  try {
    await ensurePlayer();
    if (!player || currentIndex < 0 || timing.totalTicks <= 0) return;
    // Add the step in seconds, then convert back to ticks: a 5 s jump stays 5 s even across a tempo change
    const targetSec = timing.ticksToSeconds(timing.currentTick) + deltaSec;
    const target = Math.max(0, Math.min(Math.round(timing.secondsToTicks(targetSec)), timing.totalTicks));
    timing.currentTick = target;
    if (typeof player.seek === 'function') player.seek(target);
    await updateTimeline();
  } catch (error) {
    console.error('[ERROR] seekByWallClockSeconds failed:', error);
  }
}

/** Select previous track and start playback. */
async function prevTrack() {
  await ensurePlayer();
  if (getTrackCount() === 0) return;
  const prevIndex = getPrevIndexForButton();
  debug('Prev track ->', prevIndex);
  await loadTrack(prevIndex);
  playTrack();
}

/** Select next track and start playback. */
async function nextTrack() {
  await ensurePlayer();
  if (getTrackCount() === 0) return;
  const nextIndex = getNextIndexForButton();
  debug('Next track ->', nextIndex);
  await loadTrack(nextIndex);
  playTrack();
}

// ---------------------------------------------------------------------------
// Loading / Playlist
// ---------------------------------------------------------------------------
/** Update playlist UI to reflect the active index. */
function highlightActive() {
  [...playlistEl.children].forEach((li, idx) => {
    if (idx === currentIndex) li.classList.add('active'); else li.classList.remove('active');
  });
}

/** Append files to playlist UI and internal list. */
function addToPlaylist(files) {
  for (const file of files) {
    const name = file.name;
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!SUPPORTED_MIDI_EXTENSIONS.includes(ext)) continue;
    const item = { name, ext, file };
    playlist.push(item);
    const listItem = createPlaylistItem(name);
    playlistEl.appendChild(listItem);
    void checkPlaylistItem(item, listItem);
  }
}

/** Read the file once (cached for loadTrack) and flag the playlist entry if the MIDI check finds issues. */
async function checkPlaylistItem(item, listItem) {
  try {
    item.arrayBuffer ??= await item.file.arrayBuffer();
    const issues = checkMidiFile(item.arrayBuffer);
    if (issues.length > 0) addPlaylistItemWarning(listItem, issues);
  } catch (error) {
    console.error('[ERROR] Failed to check MIDI file:', item.name, error);
  }
}

/** Warning sign left of the Play button; hovering it lists the issues. */
function addPlaylistItemWarning(listItem, issues) {
  const warning = document.createElement('span');
  warning.className = 'playlist-warning';
  warning.textContent = '⚠️';
  warning.title = ['This MIDI file may have some issues:', ...issues.map((issue) => `  - ${issue}`)].join('\n');
  listItem.querySelector('.playlist-actions').prepend(warning);
}

// ---------------------------------------------------------------------------
// SoundFont scanning and selection (hybrid: demo/Soundfonts/ + manifest)
// ---------------------------------------------------------------------------

/**
 * List SF2/SF3 files using hybrid approach:
 * 1. Try Vite dev API endpoint (dev mode with refresh support)
 * 2. Try directory listing (Python HTTP server)
 * 3. Fall back to static soundfonts.json manifest (GitHub Pages)
 * @returns {Promise<string[]>}
 */
async function listSoundfonts() {
  // Strategy 1: Try Vite dev API endpoint (works in dev mode, supports refresh)
  try {
    const res = await fetch('/api/list-soundfonts');
    if (res.ok) {
      const data = await res.json();
      console.log('[DEBUG] Using Vite API soundfont listing (dev mode):', data.soundfonts?.length || 0, 'files');
      return data.soundfonts || [];
    }
    // API endpoint not found (expected in production)
    console.log('[DEBUG] Vite API not available (production mode), trying directory listing (ignore 404 above)');
  } catch (error) {
    // Network error
    console.log('[DEBUG] Vite API unreachable, trying directory listing');
  }

  // Strategy 2: Try directory listing (Python HTTP server in production)
  try {
    const res = await fetch(SOUND_DATA_PATH + 'Soundfonts/');
    if (res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        // We got HTML back - this is a directory listing!
        const html = await res.text();
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const anchors = Array.from(tmp.querySelectorAll('a'));
        const names = anchors.map(a => a.getAttribute('href') || '')
          .filter(h => /\.(sf2|sf3)$/i.test(h));
        const unique = Array.from(new Set(names)).map(n => decodeURIComponent(n));
        if (unique.length > 0) {
          console.log('[DEBUG] Using directory listing (HTTP server):', unique.length, 'files');
          return unique;
        }
      }
    }
  } catch (error) {
    console.log('[DEBUG] HTTP dynamic listing unavailable, trying static manifest');
  }

  // Strategy 3: Fall back to static manifest (GitHub Pages)
  try {
    const res = await fetch('./soundfonts.json');
    if (res.ok) {
      const manifest = await res.json();
      console.log('[DEBUG] Using static soundfont manifest:', manifest.soundfonts?.length || 0, 'files');
      return manifest.soundfonts || [];
    }
  } catch (error) {
    console.error('[ERROR] All soundfont listing strategies failed');
  }

  return [];
}

/** Refresh SoundFonts dropdown with current directory listing. */
async function refreshSf2List() {
  if (!sf2Select) return;
  const opts = await listSoundfonts();
  // Preserve current selection if possible
  const current = sf2Select.value;
  while (sf2Select.firstChild) sf2Select.removeChild(sf2Select.firstChild);
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  sf2Select.appendChild(none);
  for (const name of opts) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sf2Select.appendChild(opt);
  }
  if (opts.includes(current)) sf2Select.value = current; else sf2Select.value = '';
  if (!sf2Select.value && opts.includes(DEFAULT_BUNDLED_SF2_NAME)) {
    sf2Select.value = DEFAULT_BUNDLED_SF2_NAME;
    await applySelectedSf2();
  }
}

/** Replace current SF2 with the selected one, preserving play state. */
async function applySelectedSf2() {
  if (!sf2Select) return;
  const selected = sf2Select.value;
  if (!selected) return;
  await ensurePlayer();
  try {
    let sf2FileData;
    let displayName = selected;

    // Custom entry path: value starts with prefix
    if (selected.startsWith('custom::')) {
      const name = selected.slice('custom::'.length);
      const buf = customSf2Registry.get(name);
      if (!buf) throw new Error('Custom SF2 not found in session registry');
      sf2FileData = buf;
      displayName = `Custom: ${name}`;
    } else {
      // Built-in path: fetch from sound_data/Soundfonts
      const url = SOUND_DATA_PATH + 'Soundfonts/' + encodeURIComponent(selected);
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch ' + selected);
      sf2FileData = await res.arrayBuffer();
    }

    const wasPlaying = isPlaying;
    let resumeTick = timing.currentTick;
    if (wasPlaying) await pauseTrack();
    if (typeof player.loadSF2 === 'function') await player.loadSF2(sf2FileData, true);
    // Restore play state and position
    timing.currentTick = resumeTick;
    if (wasPlaying) await playTrack();
    testChordBtn.disabled = false;
    debug('SF2 switched to', displayName);
  } catch (e) {
    console.error('Failed to switch SF2', e);
    alert('Failed to load SF2: ' + (e && e.message ? e.message : e));
  }
}

/** Update the "Now playing" title span. */
function updateTitle(name) {
  trackTitleEl.textContent = name || '—';
}

/** Load track by index from playlist into the synth player. */
function loadTrack(index) {
  if (index < 0 || index >= getTrackCount()) return Promise.resolve();
  ensurePlayer();
  const item = playlist[index];
  setCurrentIndex(index);
  highlightActive();
  updateTitle(item.name);

  const proceed = async (arrayBuffer) => {
    try {
      debug('Loading track into player:', item.name, '(' + item.ext + ')');
      if (typeof player.pause === 'function') player.pause();
      await ensurePlayer();

      timing.reset();
      const tempoMap = readTempoMap(arrayBuffer);
      if (tempoMap) timing.tempoMap = tempoMap;
      else console.warn('[WARN] Could not read the tempo map; timeline assumes', DEFAULT_BPM, 'BPM');

      const u8 = new Uint8Array(arrayBuffer);
      await player.loadMIDI(u8);
      await syncTotalTicksFromSynth();
      // T_ref: the file's tempo at tick 0 (120 BPM when unset)
      await setTempoState({ trackRefBpm: usPerQuarterToBpm(timing.tempoMap.initialUsPerQuarter) });

      // Centralized UI render
      await updateTimeline();
    } catch (e) {
      console.error('[ERROR] Failed to load track into player:', e);
      alert('Failed to load: ' + item.name + (e && e.message ? '\n' + e.message : ''));
    }
  };

  if (item.arrayBuffer) {
    return proceed(item.arrayBuffer);
  } else {
    return item.file.arrayBuffer().then((buf) => { item.arrayBuffer = buf; return proceed(buf); });
  }
}

// ---------------------------------------------------------------------------
// Events / Wiring
// ---------------------------------------------------------------------------
// File input: append selected MIDI files to playlist UI and internal list
midiInput.addEventListener('change', () => {
  if (midiInput.files && midiInput.files.length) addToPlaylist(midiInput.files);
});

// Transport buttons
playPauseBtn.addEventListener('click', togglePlayPause);
rewindBtn.addEventListener('click', rewindToBeginning);
stopBtn.addEventListener('click', stopTrack);
prevBtn.addEventListener('click', prevTrack);
nextBtn.addEventListener('click', nextTrack);

// Toggles
autoplayToggle.addEventListener('change', () => { autoplay = autoplayToggle.checked; });
syncLoopModeRadiosUi();
loopEnableToggle.addEventListener('change', syncLoopModeRadiosUi);

// Tempo: single delegated handler on the tempo section.
// `change` fires for checkbox toggle and committed number input;
// `input` fires for live slider drag (needs real-time engine update) and live number typing (readout only).
async function onTempoControlChange(e) {
  if (e.target === tempoEffectiveInput) return; // readonly readout
  // Switching from MIDI-defined to manual: populate base field if empty
  if (e.target === midiTempoDefinedToggle && !isMidiTempoDefinedChecked() && !tempoBaseInput.value.trim()) {
    tempoBaseInput.value = String(Math.round(getTrackRefBpmSafe() * 100) / 100);
  }
  if (e.target === tempoBaseInput && isMidiTempoDefinedChecked()) return;
  await setTempoState();
  updateTimeline();
}
async function onTempoControlInput(e) {
  if (e.target === tempoEffectiveInput) return; // readonly
  if (e.target === tempoBaseInput) {
    // Live readout while typing; engine push deferred to `change`
    if (!isMidiTempoDefinedChecked()) updateTempoEffectiveDisplay();
    return;
  }
  // Slider: full sync on every input for real-time engine update
  await setTempoState();
  updateTimeline();
}
tempoControlsEl.addEventListener('change', onTempoControlChange);
tempoControlsEl.addEventListener('input', onTempoControlInput);
// Reset: preset slider value then let the unified handler run
tempoFactorResetBtn.addEventListener('click', () => {
  tempoFactorSlider.value = String(TEMPO_FACTOR_DEFAULT);
  tempoFactorSlider.dispatchEvent(new Event('input', { bubbles: true }));
});
applyTempoBaseInputBounds();
applyTempoFactorSliderDomFromConstants();
void setTempoState({ skipEngine: true });

// Volume slider: non-linear position → gain mapping (see volumePositionToGain)
volumeEl.addEventListener('input', async () => {
  updateVolumeReadout();
  try {
    await ensurePlayer();
    const gain = getVolumeGainFromSlider();
    debug('Volume set', gain);
    // Lowering the volume clears the clip indicator until clipping happens again
    if (gain < player.getVolume()) {
      player.resetClipDetection();
      setClipIndicator(CLIP_LEVEL.none);
    }
    player.setVolume(gain);
  } catch (error) {
    console.error('[ERROR] Failed to set volume:', error);
  }
});
// Reset: preset slider value then let the input handler run (same pattern as tempo reset)
volumeResetBtn.addEventListener('click', () => {
  setVolumeSliderGain(VOLUME_GAIN_DEFAULT);
  volumeEl.dispatchEvent(new Event('input'));
});
applyVolumeSliderDomFromConstants();

// Seek slider: maps 0..SEEK_SLIDER_MAX to 0..total duration (seconds → ticks), updates synth and UI immediately
seekEl.addEventListener('input', async () => {
  try {
    await ensurePlayer();
    if (timing.totalTicks > 0) {
      const targetSec = (Number(seekEl.value) / SEEK_SLIDER_MAX) * timing.ticksToSeconds(timing.totalTicks);
      const targetTicks = Math.min(Math.floor(timing.secondsToTicks(targetSec)), timing.totalTicks);
      timing.currentTick = targetTicks;
      try {
        if (typeof player.seek === 'function') player.seek(targetTicks);
      } catch (error) {
        console.error('[ERROR] Failed to seek to target ticks:', error);
      }
      updateTimeline();
    }
  } catch (error) {
    console.error('[ERROR] Failed to handle seek input:', error);
  }
});

// Keyboard: Space play/pause, S stop, arrows ±5s wall-clock seek / rewind (disabled in text fields — see isKeyboardShortcutSuppressed)
document.addEventListener('keydown', (e) => {
  if (isKeyboardShortcutSuppressed(e.target)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlayPause(); }
  else if (e.key === 's' || e.key === 'S') { stopTrack(); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); seekByWallClockSeconds(KEYBOARD_SEEK_STEP_SEC); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); seekByWallClockSeconds(-KEYBOARD_SEEK_STEP_SEC); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); rewindToBeginning(); }
});

// Diagnostics
// Test Beep: always produces a short sine tone, even with no SF2/MIDI
testBeepBtn.addEventListener('click', async () => {
  await ensurePlayer();
  try {
    safePlayerCall(player.setAudioState, AUDIO_STATE.wakeUp);
    const ac = player._audioContext;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    g.gain.value = 0.2;
    osc.type = 'sine';
    osc.frequency.value = 440;
    osc.connect(g).connect(ac.destination);
    osc.start();
    setTimeout(() => {
      try {
        osc.stop();
        osc.disconnect();
        g.disconnect();
      } catch (error) {
        console.error('[ERROR] Failed to cleanup test beep audio nodes:', error);
      }
    }, TEST_BEEP_DURATION_MS);
    console.log('[DEBUG] Test beep played');
  } catch (e) { console.error('[ERROR] Test beep failed:', e); }
});

// Play demo file button: fetch and load demo/MIDI/demo.MID
playDemoBtn.addEventListener('click', async () => {
  try {
    const response = await fetch(SOUND_DATA_PATH + 'MIDI/demo.MID');
    if (!response.ok) throw new Error('Demo file not found');

    const blob = await response.blob();
    const file = new File([blob], 'demo.MID', { type: 'audio/midi' });

    addToPlaylist([file]);
    const newIndex = getTrackCount() - 1;
    await loadTrack(newIndex);
    playTrack();

    debug('Demo file loaded and playing');
  } catch (error) {
    console.error('[ERROR] Failed to load demo file:', error);
    alert('Failed to load demo file. Make sure demo/MIDI/demo.MID exists.');
  }
});

// MIDI Test: pauses main playback, plays C–E–G on isolated synth, then resumes
// This was necessary not to alter the main synth channel affectation, otherwise the used channel of the main synth
// would be set to a neutral piano sound.
testChordBtn.addEventListener('click', async () => {
  await ensurePlayer();
  try {
    safePlayerCall(player.setAudioState, AUDIO_STATE.wakeUp);
    testChordBtn.disabled = true;
    const wasPlaying = isPlaying;
    if (wasPlaying) { await pauseTrack(); }
    if (typeof player.playTestChord === 'function') { await player.playTestChord(); }
    if (wasPlaying) { await playTrack(); }
    console.log('[DEBUG] Test chord triggered');
  } catch (e) {
    console.error('[ERROR] Test chord failed:', e);
  } finally {
    // Re-enable button if any SF2 is loaded (via file input or dropdown)
    const hasSf2File = sf2Input.files && sf2Input.files.length > 0;
    const hasSf2Dropdown = sf2Select.value && sf2Select.value !== '';
    if (hasSf2File || hasSf2Dropdown) { testChordBtn.disabled = false; }
  }
});

// SF2 file input: load custom SF2, enable MIDI Test; keep context suspended if idle
sf2Input.addEventListener('change', async () => {
  if (!sf2Input.files || sf2Input.files.length === 0) return;
  const file = sf2Input.files[0];
  debug('Custom SF2 selected (FluidSynth)', file.name, file.size);

  // Read SF2 file data as ArrayBuffer
  const sf2FileData = await file.arrayBuffer();

  // If a custom with the same name already exists, ask to replace
  const existingValue = `custom::${file.name}`;
  const existingOption = Array.from(sf2Select.options).find(opt => opt.value === existingValue);
  if (existingOption) {
    const replace = window.confirm(`A custom SF2 named "${file.name}" already exists. Replace it with the new file?`);
    if (!replace) {
      // Keep existing; select it and load
      sf2Select.value = existingValue;
      await applySelectedSf2();
      return;
    }
  }

  // Store/replace in registry
  customSf2Registry.set(file.name, sf2FileData);

  // Ensure an option exists (insert or update)
  let opt = existingOption;
  if (!opt) {
    opt = document.createElement('option');
    opt.value = `custom::${file.name}`;
    opt.textContent = `Custom: ${file.name}`;
    // Insert custom option at top of list (after placeholder if any)
    if (sf2Select.firstChild) {
      sf2Select.insertBefore(opt, sf2Select.firstChild.nextSibling);
    } else {
      sf2Select.appendChild(opt);
    }
  } else {
    opt.textContent = `Custom: ${file.name}`;
  }

  // Select and load via unified path
  sf2Select.value = `custom::${file.name}`;
  await applySelectedSf2();

  // Keep context suspended if idle
  if (!isPlaying) {
    safePlayerCall(player.setAudioState, AUDIO_STATE.stopped);
  }
});

// Audio export: export-panel.js has no access to the app's state, so it receives this small interface.
// Through it, the panel reads what an export needs (tracks, loaded soundfont, volume, speed) and pauses
// playback, which stays locked until the export ends.
initExportPanel({
  /** @param {'track'|'playlist'} scope @returns {Promise<{ name: string, arrayBuffer: ArrayBuffer }[]>} */
  async getTracks(scope) {
    const items = scope === 'playlist' ? playlist : (currentIndex >= 0 ? [playlist[currentIndex]] : []);
    return Promise.all(items.map(async (item) => {
      item.arrayBuffer ??= await item.file.arrayBuffer();
      return { name: item.name, arrayBuffer: item.arrayBuffer };
    }));
  },
  async getSoundfontBytes() {
    await ensurePlayer();
    return player.getSoundfontBytes();
  },
  getVolume: getVolumeGainFromSlider,
  tempoMultiplierFor: computeInternalTempoMultiplier,
  async pausePlayback() {
    if (isPlaying) await pauseTrack();
  },
  setPlaybackLocked(locked) {
    playbackLocked = locked;
    playPauseBtn.disabled = locked;
  },
});

// SoundFonts dropdown: initial fill, selection applies new SF2
refreshSf2List();
sf2Select.addEventListener('change', applySelectedSf2);
// Rescan demo/Soundfonts directory and repopulate dropdown
refreshSf2Btn.addEventListener('click', refreshSf2List);
