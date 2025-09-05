/* MIDI Player App (FluidSynth via js-synthesizer)
   - Robust transport state with internal tick source of truth
   - DRY helpers for playlist navigation and time conversion
   - Clear separation of concerns and comments for maintainability
*/

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants / Config
  // ---------------------------------------------------------------------------
  const UI_UPDATE_INTERVAL_MS = 50; // ~20 fps timeline updates
  const DEFAULT_TEMPO_US_PER_QUARTER = 500000; // 120 BPM
  const DEFAULT_PPQ = 480;
  const PAUSE_LOW_POWER_MS = 30000; // 30s to fully suspend when paused
  const SUPPORTED_MIDI_EXTENSIONS = ['mid', 'midi', 'mld', 'mml', 'mmi', 'ms2mml', 'mms'];

  // ---------------------------------------------------------------------------
  // App State
  // ---------------------------------------------------------------------------
  let player;              // JSSynthPlayer instance
  const playlist = [];     // { name, ext, file, arrayBuffer? }
  let currentIndex = -1;   // active playlist index
  let isPlaying = false;   // transport state (true while playing)
  let autoplay = true;     // autoplay toggle state

  // Transport timing is driven by these variables
  let currentTick = 0;                 // source of truth for playhead
  let totalTicks = 0;                  // track length in ticks
  let tempoUsPerQuarter = DEFAULT_TEMPO_US_PER_QUARTER; // last known tempo
  let currentPPQ = DEFAULT_PPQ;        // PPQ from SMF header (division)
  let rafId = 0;           // UI loop handle
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
  if (testChordBtn) { try { testChordBtn.disabled = true; } catch(_){} }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  /** Log debug messages (safe in older browsers). */
  function debug(message, ...args) {
    try { console.log('[DEBUG]', message, ...args); } catch (_) {}
  }

  /** Debug tick state for end-detection issues. */
  function debugTickState(label) {
    try {
      if (player && player._synth) {
        const cur = player._synth.retrievePlayerCurrentTick();
        const tot = player._synth.retrievePlayerTotalTicks();
        const isPlayingFn = player._synth.isPlayerPlaying ? player._synth.isPlayerPlaying() : null;
        Promise.all([cur, tot]).then(([current, total]) => {
          console.log(`[TICK_DEBUG] ${label}: synth_current=${current}, synth_total=${total}, synth_playing=${isPlayingFn}, app_currentTick=${currentTick}, app_totalTicks=${totalTicks}, isPlaying=${isPlaying}`);
        });
      } else {
        console.log(`[TICK_DEBUG] ${label}: no synth, app_currentTick=${currentTick}, app_totalTicks=${totalTicks}, isPlaying=${isPlaying}`);
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

  /** Seconds per tick from current tempo and PPQ. */
  function secPerTick() {
    const ppq = currentPPQ || DEFAULT_PPQ;
    const usPerQuarter = tempoUsPerQuarter || DEFAULT_TEMPO_US_PER_QUARTER;
    return (usPerQuarter / 1e6) / ppq;
  }

  // Playlist helpers
  /** @returns {number} number of tracks in playlist */
  function getTrackCount() { return playlist.length; }
  /** @returns {boolean} true if exactly one track */
  function hasSingleTrack() { return getTrackCount() === 1; }
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
      // Wait until adapter reports ready
      let guard = 0;
      while (!player._ready && guard < 500) { await new Promise((res) => setTimeout(res, 10)); guard++; }
      debug('JSSynthPlayer ready');
      if (player._gain) player._gain.gain.value = 0.7;
      // UI loop will start on first play to reduce idle CPU
      // Subscribe to audio heartbeat so onEnded triggers in background tabs
      if (typeof player.setOnAudioTick === 'function') {
        player.setOnAudioTick(() => {
          // Fast end detection without rAF
          try {
            if (!isPlaying || !player || !player._synth) return;
            const reachedEnd = (totalTicks > 0 && currentTick >= totalTicks - 1);
            const synthStopped = (typeof player._synth.isPlayerPlaying === 'function' && !player._synth.isPlayerPlaying());
            if (reachedEnd || synthStopped) {
              debugTickState('heartbeat end detected');
              debugTickState('onEnded triggered from heartbeat');
              onEnded();
            }
          } catch(_) {}
        });
      }
    }
    return player;
  }

  async function waitForSynthReady(maxMs = 8000) { await ensurePlayer(); return true; }

  // ---------------------------------------------------------------------------
  // Timeline update loop
  // ---------------------------------------------------------------------------
  /** Update timer labels and slider; keeps currentTick in sync while playing. */
  async function updateTimeline() {
    if (!player) return;
    const oldTick = currentTick;
    // When playing, keep internal currentTick in sync with synth
    if (isPlaying && player._synth && player._synth.retrievePlayerCurrentTick) {
      try {
        currentTick = await player._synth.retrievePlayerCurrentTick();
      } catch (_) {}
    }
    // Lazy-load total/tempo (first-play guard)
    if (totalTicks === 0 && player && player._synth) {
      try {
        const tt = await player._synth.retrievePlayerTotalTicks();
        if (typeof tt === 'number' && tt > 0) totalTicks = tt;
        const t = await player._synth.retrievePlayerMIDITempo();
        if (typeof t === 'number' && t > 0) tempoUsPerQuarter = t;
      } catch (_) {}
    }
    const spt = secPerTick();
    const curStr = formatTimeStr(currentTick * spt);
    const totStr = formatTimeStr(totalTicks * spt);
    const seekStr = totalTicks > 0 ? String(Math.round((currentTick / totalTicks) * 1000)) : '0';
    if (curStr !== lastUi.cur) { currentTimeEl.textContent = curStr; lastUi.cur = curStr; }
    if (totStr !== lastUi.tot) { totalTimeEl.textContent = totStr; lastUi.tot = totStr; }
    if (seekStr !== lastUi.seek) { seekEl.value = seekStr; lastUi.seek = seekStr; }
  }

  /** After PAUSE_LOW_POWER_MS, fully suspend/disable audio while paused. */
  function schedulePauseLowPower() {
    try { if (pauseLowPowerTimer) { clearTimeout(pauseLowPowerTimer); pauseLowPowerTimer = 0; } } catch(_) {}
    pauseLowPowerTimer = setTimeout(() => {
      try {
        if (!isPlaying && player) {
          if (player.setHeartbeatEnabled) player.setHeartbeatEnabled(false);
          if (player.setMainNodeEnabled) player.setMainNodeEnabled(false);
          if (player.setIdle) player.setIdle(true);
        }
      } catch(_) {}
    }, PAUSE_LOW_POWER_MS);
  }

  /** Cancel low-power timer and wake audio (used when resuming). */
  function cancelPauseLowPower() {
    try { if (pauseLowPowerTimer) { clearTimeout(pauseLowPowerTimer); pauseLowPowerTimer = 0; } } catch(_) {}
    // Wake up audio immediately
    try {
      if (player) {
        if (player.setIdle) player.setIdle(false);
        if (player.setMainNodeEnabled) player.setMainNodeEnabled(true);
      }
    } catch(_) {}
  }

  /** Clear the pending low-power timer without waking audio. */
  function clearPauseLowPowerTimer() {
    try { if (pauseLowPowerTimer) { clearTimeout(pauseLowPowerTimer); pauseLowPowerTimer = 0; } } catch(_) {}
  }

  /** rAF-driven UI loop (runs only while playing). */
  function uiLoop() {
    if (!isPlaying) return;
    const now = performance.now();
    if (!uiLoop._last || now - uiLoop._last > UI_UPDATE_INTERVAL_MS) {
      updateTimeline();
      try {
        const reachedEnd = (totalTicks > 0 && currentTick >= totalTicks - 1);
        const synthStopped = (player && player._synth && typeof player._synth.isPlayerPlaying === 'function' && !player._synth.isPlayerPlaying());
        if (reachedEnd || synthStopped) {
          debugTickState('uiLoop end detected');
        }
        if (isPlaying && (reachedEnd || synthStopped)) {
          debugTickState('onEnded triggered from uiLoop');
          onEnded();
        }
      } catch (_) {}
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
        currentTick = 0;
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
    try { if (typeof player.seek === 'function') player.seek(currentTick); } catch (_) {}
    debugTickState('after seek');
    player.play();
    debugTickState('after play');
    isPlaying = true;
    playPauseBtn.textContent = '⏸';
    // Ensure audio graph is active and heartbeat enabled while playing
    try { if (player.setIdle) player.setIdle(false); } catch(_) {}
    try { if (player.setMainNodeEnabled) player.setMainNodeEnabled(true); } catch(_) {}
    try { if (player.setHeartbeatEnabled) player.setHeartbeatEnabled(true); } catch(_) {}
    startUiLoop();
    cancelPauseLowPower();
  }

  /** Pause playback, keep position and schedule low-power. */
  async function pauseTrack() {
    await ensurePlayer();
    if (!player) return;
    debug('Pause requested');
    try { if (player._synth && player._synth.retrievePlayerCurrentTick) currentTick = await player._synth.retrievePlayerCurrentTick(); } catch (_) {}
    if (typeof player.pause === 'function') player.pause();
    isPlaying = false;
    playPauseBtn.textContent = '▶️';
    updateTimeline();
    // When paused, keep main node connected (so resume is instant), but we can suspend context if tab hidden
    try { if (player.setHeartbeatEnabled) player.setHeartbeatEnabled(false); } catch(_) {}
    stopUiLoop();
    schedulePauseLowPower();
  }

  /** Stop playback and reset to zero, fully suspending audio. */
  async function stopTrack() {
    await ensurePlayer();
    if (!player) return;
    debug('Stop requested');
    if (typeof player.pause === 'function') player.pause();
    currentTick = 0;
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
    playPauseBtn.textContent = '▶️';
    // Reflect instantly in UI
    const spt = secPerTick();
    currentTimeEl.textContent = formatTimeStr(0);
    totalTimeEl.textContent = formatTimeStr(totalTicks * spt);
    seekEl.value = '0';
    // Reduce CPU: disable heartbeat; optionally suspend context
    try { if (player.setHeartbeatEnabled) player.setHeartbeatEnabled(false); } catch(_) {}
    try { if (player.setMainNodeEnabled) player.setMainNodeEnabled(false); } catch(_) {}
    try { if (player.setIdle) player.setIdle(true); } catch(_) {}
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
      currentTick = 0;
      // Update UI immediately
      const spt = secPerTick();
      currentTimeEl.textContent = formatTimeStr(0);
      seekEl.value = '0';
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
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = name;
      const actions = document.createElement('span');
      const playBtn = document.createElement('button');
      playBtn.textContent = 'Play';
      playBtn.addEventListener('click', async () => {
        const idx = [...playlistEl.children].indexOf(li);
        await loadTrack(idx);
        playTrack();
      });
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => {
        const idx = [...playlistEl.children].indexOf(li);
        if (idx === currentIndex) {
          stopTrack();
          currentIndex = -1;
          trackTitleEl.textContent = 'No track loaded';
        } else if (idx < currentIndex) {
          currentIndex -= 1;
        }
        playlist.splice(idx, 1);
        li.remove();
        highlightActive();
      });
      actions.appendChild(playBtn);
      actions.appendChild(removeBtn);
      li.appendChild(title);
      li.appendChild(actions);
      li.addEventListener('dblclick', async () => {
        const idx = [...playlistEl.children].indexOf(li);
        await loadTrack(idx);
        playTrack();
      });
      playlistEl.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // SoundFont scanning and selection (from /Soundfonts)
  // ---------------------------------------------------------------------------
  /**
   * List SF2/SF3 files under /Soundfonts using Python http.server index.
   * @returns {Promise<string[]>}
   */
  async function listSoundfonts() {
    // Try to list files in /Soundfonts/ by fetching an index. With python -m http.server,
    // directory listing is an HTML page; we parse it for links ending with .sf2/.sf3.
    try {
      const res = await fetch('Soundfonts/');
      if (!res.ok) return [];
      const html = await res.text();
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const anchors = Array.from(tmp.querySelectorAll('a'));
      const names = anchors.map(a => a.getAttribute('href') || '').filter(h => /\.(sf2|sf3)$/i.test(h));
      // De-dup and decode
      const unique = Array.from(new Set(names)).map(n => decodeURIComponent(n));
      return unique;
    } catch(_) { return []; }
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
      const url = 'Soundfonts/' + encodeURIComponent(name);
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch ' + name);
      const buf = await res.arrayBuffer();
      const wasPlaying = isPlaying;
      let resumeTick = currentTick;
      if (wasPlaying) await pauseTrack();
      if (typeof player.replaceSF2 === 'function') await player.replaceSF2(buf);
      // Restore play state and position
      currentTick = resumeTick;
      if (wasPlaying) await playTrack();
      if (testChordBtn) testChordBtn.disabled = false;
      debug('SF2 switched to', name);
    } catch (e) {
      console.error('Failed to switch SF2', e);
      alert('Failed to load SF2: ' + (e && e.message ? e.message : e));
    }
  }

  /** Parse PPQ from SMF header and update currentPPQ if present. */
  function parsePpqFromSmfHeader(arrayBuffer) {
    try {
      const dv = new DataView(arrayBuffer);
      if (dv.getUint32(0, false) === 0x4D546864 /* 'MThd' */) {
        const div = dv.getInt16(12, false);
        if ((div & 0x8000) === 0) { currentPPQ = Math.max(1, div); }
      }
    } catch (_) {}
  }

  /** Set track title in the UI. */
  function updateTitle(name) {
    trackTitleEl.textContent = name || 'No track loaded';
  }

  /** Reset timing state before/after (re)loading a track. */
  function _setTimingDefaults() {
    currentTick = 0;
    totalTicks = 0;
    tempoUsPerQuarter = DEFAULT_TEMPO_US_PER_QUARTER;
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
        parsePpqFromSmfHeader(arrayBuffer);

        const u8 = new Uint8Array(arrayBuffer);
        await player.loadMIDI(u8);

        // Initialize timing state
        _setTimingDefaults();
        try {
          totalTicks = player._synth ? (await player._synth.retrievePlayerTotalTicks()) || 0 : 0;
          tempoUsPerQuarter = player._synth ? (await player._synth.retrievePlayerMIDITempo()) || DEFAULT_TEMPO_US_PER_QUARTER : DEFAULT_TEMPO_US_PER_QUARTER;
        } catch (_) { totalTicks = 0; tempoUsPerQuarter = DEFAULT_TEMPO_US_PER_QUARTER; }

        totalTimeEl.textContent = formatTimeStr(totalTicks * secPerTick());
        updateTimeline();
      } catch (e) {
        console.error(e);
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
    await ensurePlayer();
    const fractional = Number(volumeEl.value) / 100;
    debug('Volume set', fractional);
    if (player && player._gain) player._gain.gain.value = fractional;
  });

  // Seek slider: maps 0..1000 to 0..totalTicks, updates synth and UI immediately
  seekEl.addEventListener('input', async () => {
    await ensurePlayer();
    if (totalTicks > 0) {
      const targetTicks = Math.floor((Number(seekEl.value) / 1000) * totalTicks);
      currentTick = targetTicks;
      try { if (typeof player.seek === 'function') player.seek(targetTicks); } catch (_) {}
      updateTimeline();
    }
  });

  // Keyboard shortcuts: Space play/pause, arrows prev/next
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); togglePlayPause(); }
    else if (e.code === 'ArrowRight') { nextTrack(); }
    else if (e.code === 'ArrowLeft') { prevTrack(); }
  });

  // Diagnostics
  // Test Beep: always produces a short sine tone, even with no SF2/MIDI
  if (testBeepBtn) {
    testBeepBtn.addEventListener('click', async () => {
      await ensurePlayer();
      try {
        try { if (player && player.setIdle) await player.setIdle(false); } catch(_) {}
        const ac = player._audioContext;
        const dest = player._gain || ac.destination;
        const osc = ac.createOscillator();
        const g = ac.createGain();
        g.gain.value = 0.2;
        osc.type = 'sine';
        osc.frequency.value = 440;
        osc.connect(g).connect(dest);
        osc.start();
        setTimeout(() => { try { osc.stop(); osc.disconnect(); g.disconnect(); } catch(_){} }, 1000);
        console.log('[DEBUG] Test beep played');
      } catch (e) { console.error('Test beep failed', e); }
    });
  }

  // MIDI Test: pauses main playback, plays C–E–G on isolated synth, then resumes
  // This was necessary not to alter the main synth channel affectation, otherwise the used channel of the main synth
  // would be set to a neutral piano sound.
  if (testChordBtn) {
    testChordBtn.addEventListener('click', async () => {
      await ensurePlayer();
      try {
        try { if (player && player.setIdle) await player.setIdle(false); } catch(_) {}
        testChordBtn.disabled = true;
        const wasPlaying = isPlaying;
        if (wasPlaying) { await pauseTrack(); }
        if (typeof player.playTestChord === 'function') { await player.playTestChord(); }
        if (wasPlaying) { await playTrack(); }
        console.log('[DEBUG] Test chord triggered');
      } catch (e) {
        console.error('Test chord failed', e);
      } finally {
        if (sf2Input && sf2Input.files && sf2Input.files.length > 0) { testChordBtn.disabled = false; }
      }
    });
  }

  // SF2 file input: load custom SF2, enable MIDI Test; keep context suspended if idle
  if (sf2Input) {
    sf2Input.addEventListener('change', async () => {
      if (!sf2Input.files || sf2Input.files.length === 0) return;
      const file = sf2Input.files[0];
      debug('Custom SF2 selected (Timidity)', file.name, file.size);
      const buffer = await file.arrayBuffer();
      await ensurePlayer();
      try {
        await player.loadSF2(buffer);
        debug('SF2 loaded into Timidity');
        if (testChordBtn) testChordBtn.disabled = false;
        // We can keep context suspended until user hits play
        try { if (!isPlaying && player.setHeartbeatEnabled) player.setHeartbeatEnabled(false); } catch(_) {}
        try { if (!isPlaying && player.setIdle) player.setIdle(true); } catch(_) {}
      } catch (e) {
        console.error('Failed to load SF2 into Timidity:', e);
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
  // Rescan Soundfonts directory and repopulate dropdown
  if (refreshSf2Btn) {
    refreshSf2Btn.addEventListener('click', refreshSf2List);
  }
})();


