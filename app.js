/* MIDI Player App (FluidSynth via js-synthesizer)
  - Robust transport state with internal tick source of truth
  - DRY helpers for playlist navigation and time conversion
  - Clear separation of concerns and comments for maintainability
*/

// ---------------------------------------------------------------------------
// Constants / Config
// ---------------------------------------------------------------------------
const UI_UPDATE_INTERVAL_MS = 50;     // ~20 fps timeline updates
const DEFAULT_TEMPO_US_PER_QUARTER = 500000; // 120 BPM
const DEFAULT_PPQ = 480;              // PPQ = Pulses Per Quarter note (MIDI tick resolution)
const PAUSE_LOW_POWER_MS = 30000;     // 30s to fully suspend when paused
const SUPPORTED_MIDI_EXTENSIONS = ['mid', 'midi', 'mld', 'mml', 'mmi', 'ms2mml', 'mms'];
const SEEK_SLIDER_MAX = 1000;         // range max for seek slider
const TEST_BEEP_DURATION_MS = 1000;   // test beep duration
const AUDIO_STATE = Object.freeze({
  playing: 'playing',   // full pipeline active (context resumed, main + heartbeat connected)
  paused: 'paused',     // playback stopped but graph kept warm for instant resume
  stopped: 'stopped',   // minimize CPU (disconnect nodes, optionally suspend context)
  lowPower: 'lowPower', // like stopped; entered after idle pause timeout for battery savings
  wakeUp: 'wakeUp'      // transient state to quickly resume context and reconnect nodes
});
const SOUND_DATA_PATH = './sound_data/';

// ---------------------------------------------------------------------------
// App State
// ---------------------------------------------------------------------------
let player;              // JSSynthPlayer instance
const playlist = [];     // { name, ext, file, arrayBuffer? }
let currentIndex = -1;   // active playlist index
let isPlaying = false;   // transport state (true while playing)
let autoplay = true;     // autoplay toggle state

// ---------------------------------------------------------------------------
// Timing State Management
// ---------------------------------------------------------------------------
class TimingState {
  constructor() {
    this.currentTick = 0;                 // source of truth for playhead
    this.totalTicks = 0;                  // track length in ticks
    this.tempoUsPerQuarter = DEFAULT_TEMPO_US_PER_QUARTER; // last known tempo
    this.ppq = DEFAULT_PPQ;               // PPQ from SMF header (division)
  }

  /** Reset to default values (used when loading new track). */
  reset() {
    this.currentTick = 0;
    this.totalTicks = 0;
    this.tempoUsPerQuarter = DEFAULT_TEMPO_US_PER_QUARTER;
    this.ppq = DEFAULT_PPQ;
    this.secPerTick = 0;
    this.setSecPerTick();
  }

  /** Update timing from synth values. */
  updateFromSynth(totalTicks, tempoUsPerQuarter, ppq = this.ppq) {
    if (typeof totalTicks === 'number' && totalTicks > 0) this.totalTicks = totalTicks;
    if (typeof tempoUsPerQuarter === 'number' && tempoUsPerQuarter > 0) this.tempoUsPerQuarter = tempoUsPerQuarter;
    if (typeof ppq === 'number' && ppq > 0) this.ppq = ppq;
    this.setSecPerTick();
  }

  /** Calculate seconds per tick based on current tempo and PPQ. */
  setSecPerTick() {
    this.secPerTick = (this.tempoUsPerQuarter / 1e6) / this.ppq;
  }

  /** Convert ticks to seconds. */
  ticksToSeconds(ticks) {
    return ticks * this.secPerTick;
  }

  /** Convert seconds to ticks. */
  secondsToTicks(seconds) {
    console.warn('[WARN] secondsToTicks not tested / called yet.');  // May be used in the future
    return seconds / this.secPerTick;
  }

  /** Clamp currentTick to valid range. */
  clampTick() {
    this.currentTick = Math.max(0, Math.min(this.currentTick, this.totalTicks));
  }
}

const timing = new TimingState();
let rafId = 0;           // UI loop handle
let suppressFirstSynthRead = false; // Skip one synth tick read on play to avoid flicker
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
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const trackTitleEl = document.getElementById('trackTitle');
const autoplayToggle = document.getElementById('autoplayToggle');
const loopToggle = document.getElementById('loopToggle');
const sf2Input = document.getElementById('sf2Input');
const sf2Select = document.getElementById('sf2Select');
const refreshSf2Btn = document.getElementById('refreshSf2Btn');
const testBeepBtn = document.getElementById('testBeepBtn');
const testChordBtn = document.getElementById('testChordBtn');
const playDemoBtn = document.getElementById('playDemoBtn');

// Disable MIDI Test button until synth and SF2 are loaded
if (testChordBtn) testChordBtn.disabled = true;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
/** Log debug messages */
function debug(message, ...args) {
  console.log('[DEBUG]', message, ...args); 
}

/** Set play/pause button icon and aria-label consistently. */
function setPlayPauseIcon(isPlayingState) {
  try {
    if (!playPauseBtn) return;
    playPauseBtn.textContent = isPlayingState ? '⏸️' : '▶️';
    playPauseBtn.setAttribute('title', isPlayingState ? 'Pause' : 'Play');
  } catch (error) {
    console.error('[ERROR] Failed to set play/pause icon:', error);
  }
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
      currentIndex = -1;
      trackTitleEl.textContent = 'No track loaded';
    } else if (indexInList < currentIndex) {
      currentIndex -= 1;
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
/**
 * Next index when advancing due to player end.
 * Honors Loop and Autoplay; returns null when stopping.
 */
function getNextIndexForPlayer() {
  const len = getTrackCount();
  if (len === 0) return null;
  if (hasSingleTrack()) return null; // handled by onEnded branch
  const loopOn = !!(loopToggle && loopToggle.checked);
  if (loopOn) return (currentIndex + 1) % len;
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
    player = new window.JSSynthPlayer();
    // Wait until adapter reports ready (adapter-provided readiness)
    if (typeof player.waitForReady === 'function') {
      await player._waitForReady();
    }
    debug('JSSynthPlayer ready');
    // Set initial volume from slider
    const initial = Number(volumeEl.value) / 100;
    if (player._gain) player._gain.gain.value = initial;
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

async function waitForSynthReady(maxMs = 8000) { await ensurePlayer(); return true; }

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
// Timeline update loop
// ---------------------------------------------------------------------------
/** Update timer labels and slider; keeps currentTick in sync while playing. */
async function updateTimeline() {
  if (!player) return;
  const oldTick = timing.currentTick;
  // When playing, keep internal currentTick in sync with synth
  if (isPlaying) {
    if (suppressFirstSynthRead) {
      // Use current state for this frame; clear guard (avoids flicker on play after seek)
      suppressFirstSynthRead = false;
    } else {
      const tick = await safeSynthCall(player._synth?.retrievePlayerCurrentTick);
      if (tick !== null) timing.currentTick = tick;
    }
  }
  // Lazy-load total/tempo (first-play guard)
  if (timing.totalTicks === 0) {
    const totalTicks = await safeSynthCall(player._synth?.retrievePlayerTotalTicks);
    const tempoUsPerQuarter = await safeSynthCall(player._synth?.retrievePlayerMIDITempo);
    timing.updateFromSynth(totalTicks, tempoUsPerQuarter);
  }
  // Calculate UI strings only once
  const curStr = formatTimeStr(timing.ticksToSeconds(timing.currentTick));
  const totStr = formatTimeStr(timing.ticksToSeconds(timing.totalTicks));
  const seekStr = timing.totalTicks > 0 ? Math.round((timing.currentTick / timing.totalTicks) * SEEK_SLIDER_MAX).toString() : '0';
  
  // Update DOM only when values actually change (efficient string comparison)
  if (curStr !== lastUi.cur) { 
    currentTimeEl.textContent = curStr; 
    lastUi.cur = curStr; 
  }
  if (totStr !== lastUi.tot) { 
    totalTimeEl.textContent = totStr; 
    lastUi.tot = totStr; 
  }
  if (seekStr !== lastUi.seek) { 
    seekEl.value = seekStr; 
    lastUi.seek = seekStr; 
  }
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
  playPauseBtn.textContent = '▶️';
  const len = getTrackCount();
  const loopOn = !!(loopToggle && loopToggle.checked);

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
  if (!player || currentIndex < 0) return;
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
    playlist.push({ name, ext, file });
    const listItem = createPlaylistItem(name);
    playlistEl.appendChild(listItem);
  }
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
}

/** Replace current SF2 with the selected one, preserving play state. */
async function applySelectedSf2() {
  if (!sf2Select) return;
  const name = sf2Select.value;
  if (!name) return;
  await ensurePlayer();
  try {
    const url = SOUND_DATA_PATH + 'Soundfonts/' + encodeURIComponent(name);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch ' + name);
    // Fetch SF2 file data as ArrayBuffer from the demo/Soundfonts/ directory
    const sf2FileData = await res.arrayBuffer();
    const wasPlaying = isPlaying;
    let resumeTick = timing.currentTick;
    if (wasPlaying) await pauseTrack();
    if (typeof player.loadSF2 === 'function') await player.loadSF2(sf2FileData, true);
    // Restore play state and position
    timing.currentTick = resumeTick;
    if (wasPlaying) await playTrack();
    if (testChordBtn) testChordBtn.disabled = false;
    debug('SF2 switched to', name);
  } catch (e) {
    console.error('Failed to switch SF2', e);
    alert('Failed to load SF2: ' + (e && e.message ? e.message : e));
  }
}

/** Parse PPQ from SMF (Standard MIDI File) header and update timing.ppq if present.
 * more info here: https://web.archive.org/web/20250302231448/https://midimusic.github.io/tech/midispec.html
 * and here: https://web.archive.org/web/20250417220139/https://wiki.fourthwoods.com/standard_midi_file_format
 * @param {ArrayBuffer} arrayBuffer - the SMF file data
 * @returns {void}
*/
function parsePpqFromSmfHeader(arrayBuffer) {
  try {
    const dv = new DataView(arrayBuffer);
    if (dv.getUint32(0, false) === 0x4D546864 /* 'MThd' */) {
      const div = dv.getInt16(12, false);
      if ((div & 0x8000) === 0) {
        // PPQ format: use the division value as PPQ
        if (div > 0) {
          timing.ppq = div;
        } else {
          console.error('[ERROR] Invalid PPQ value, using default PPQ');
          console.warn('[WARN] MIDI playback time-related info may be erroneous');
          timing.ppq = DEFAULT_PPQ;
        }
        timing.setSecPerTick(); // Recalculate secPerTick with new PPQ
      } else {
        // SMPTE format: not supported, use default PPQ
        console.error('[ERROR] SMPTE timing format not supported, using default PPQ');
      }
    } else {
      // Not a valid SMF file
      console.error('[ERROR] Invalid SMF file header, using default PPQ');
    }
  } catch (error) {
    console.error('[ERROR] Failed to parse PPQ from SMF header:', error);
  }
}

/** Set track title in the UI. */
function updateTitle(name) {
  trackTitleEl.textContent = name || 'No track loaded';
}

/** Load track by index from playlist into the synth player. */
function loadTrack(index) {
  if (index < 0 || index >= getTrackCount()) return Promise.resolve();
  ensurePlayer();
  const item = playlist[index];
  currentIndex = index;
  highlightActive();
  updateTitle(item.name);

  const proceed = async (arrayBuffer) => {
    try {
      debug('Loading track into player:', item.name, '(' + item.ext + ')');
      if (typeof player.pause === 'function') player.pause();
      await waitForSynthReady(5000);
      
      // Initialize timing state BEFORE parsing PPQ
      timing.reset();
      parsePpqFromSmfHeader(arrayBuffer);

      const u8 = new Uint8Array(arrayBuffer);
      await player.loadMIDI(u8);
      try {
        const totalTicks = player._synth ? (await player._synth.retrievePlayerTotalTicks()) || 0 : 0;
        const tempoUsPerQuarter = player._synth ? (await player._synth.retrievePlayerMIDITempo()) || DEFAULT_TEMPO_US_PER_QUARTER : DEFAULT_TEMPO_US_PER_QUARTER;
        timing.updateFromSynth(totalTicks, tempoUsPerQuarter);
      } catch (error) { 
        console.error('[ERROR] Failed to load timing from synth:', error);
        timing.reset(); 
      }

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
if (loopToggle) loopToggle.addEventListener('change', () => { /* read in onEnded */ });

// Volume slider: maps 0..100 to gain 0..1
volumeEl.addEventListener('input', async () => {
  try {
    await ensurePlayer();
    const fractional = Number(volumeEl.value) / 100;
    debug('Volume set', fractional);
    if (player && player._gain) player._gain.gain.value = fractional;
  } catch (error) {
    console.error('[ERROR] Failed to set volume:', error);
  }
});

// Seek slider: maps 0..SEEK_SLIDER_MAX to 0..totalTicks, updates synth and UI immediately
seekEl.addEventListener('input', async () => {
  try {
    await ensurePlayer();
    if (timing.totalTicks > 0) {
      const targetTicks = Math.floor((Number(seekEl.value) / SEEK_SLIDER_MAX) * timing.totalTicks);
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

// Keyboard shortcuts: Space play/pause, arrows prev/next
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); togglePlayPause(); }
  else if (e.key === 's' || e.key === 'S') { stopTrack(); }
  else if (e.code === 'ArrowRight') { nextTrack(); }
  else if (e.code === 'ArrowLeft') { prevTrack(); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); rewindToBeginning(); }
});

// Diagnostics
// Test Beep: always produces a short sine tone, even with no SF2/MIDI
if (testBeepBtn) {
  testBeepBtn.addEventListener('click', async () => {
    await ensurePlayer();
    try {
      safePlayerCall(player.setAudioState, AUDIO_STATE.wakeUp);
      const ac = player._audioContext;
      const dest = player._gain || ac.destination;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      g.gain.value = 0.2;
      osc.type = 'sine';
      osc.frequency.value = 440;
      osc.connect(g).connect(dest);
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
}

// Play demo file button: fetch and load demo/MIDI/demo.MID
if (playDemoBtn) {
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
}

// MIDI Test: pauses main playback, plays C–E–G on isolated synth, then resumes
// This was necessary not to alter the main synth channel affectation, otherwise the used channel of the main synth
// would be set to a neutral piano sound.
if (testChordBtn) {
  testChordBtn.addEventListener('click', async () => {
    await ensurePlayer();
    try {
      safePlayerCall(player.setAudioState, 'wakeUp');
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
      const hasSf2File = sf2Input && sf2Input.files && sf2Input.files.length > 0;
      const hasSf2Dropdown = sf2Select && sf2Select.value && sf2Select.value !== '';
      if (hasSf2File || hasSf2Dropdown) { testChordBtn.disabled = false; }
    }
  });
}

// SF2 file input: load custom SF2, enable MIDI Test; keep context suspended if idle
if (sf2Input) {
  sf2Input.addEventListener('change', async () => {
    if (!sf2Input.files || sf2Input.files.length === 0) return;
    const file = sf2Input.files[0];
    debug('Custom SF2 selected (FluidSynth)', file.name, file.size);
    // Read SF2 file data as ArrayBuffer from user's selected file
    const sf2FileData = await file.arrayBuffer();
    await ensurePlayer();
    try {
      await player.loadSF2(sf2FileData, false);
      debug('SF2 loaded into FluidSynth');
      if (testChordBtn) testChordBtn.disabled = false;
      // We can keep context suspended until user hits play
      if (!isPlaying) {
        safePlayerCall(player.setAudioState, AUDIO_STATE.stopped);
      }
    } catch (e) {
      console.error('[ERROR] Failed to load SF2 into FluidSynth:', e);
      alert('Failed to load SF2: ' + (e && e.message ? e.message : e));
    }
  });
}

// SoundFonts dropdown: initial fill, selection applies new SF2
if (sf2Select) {
  // Initial fill and wire events
  refreshSf2List();
  sf2Select.addEventListener('change', applySelectedSf2);
}
// Rescan demo/Soundfonts directory and repopulate dropdown
if (refreshSf2Btn) {
  refreshSf2Btn.addEventListener('click', refreshSf2List);
}
