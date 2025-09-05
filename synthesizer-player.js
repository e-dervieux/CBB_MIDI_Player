/* js-synthesizer adapter for this app
   - Wraps FluidSynth (WASM) via js-synthesizer
   - Stable API used by app.js: loadSF2, loadMIDI, play, pause, seek
   - Internal: isolated test synth for MIDI Test (so it never affects the main song)
*/
(function(){
  'use strict';

  /**
   * JSSynthPlayer
   * Adapter around js-synthesizer (FluidSynth WASM) exposing a compact API used by app.js.
   * Manages the WebAudio graph, main synth, and an isolated test synth for the MIDI Test button.
   */
  class JSSynthPlayer {
    constructor() {
      // WebAudio pipeline ------------------------------------------------------
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this._gain = this._audioContext.createGain();
      this._gain.gain.value = 0.7;
      this._gain.connect(this._audioContext.destination);

      // Synth state ------------------------------------------------------------
      this._synth = null;           // main synthesizer (FluidSynth)
      this._sfontId = null;         // current SFont id
      this._sfontBytes = null;      // raw SF2 bytes for reuse (test synth)
      this._node = null;            // main audio node
      this._tickNode = null;        // background heartbeat node
      this._tickGain = null;        // silent gain for heartbeat
      this._onAudioTick = null;     // callback invoked on audio process
      this._nodeConnected = false;  // connection state
      this._tickConnected = false;  // connection state

      // Isolated test synth (for MIDI Test) -----------------------------------
      this._testSynth = null;
      this._testNode = null;

      // Transport mirrors (not strictly required, but kept for compatibility)
      this._currentTime = 0;
      this._duration = 0;
      this._playing = false;

      // Readiness --------------------------------------------------------------
      this._ready = false;
      this._init();
    }

    /**
     * Initialize js-synthesizer and bootstrap the audio graph.
     * Creates main synth and audio nodes, plus a silent heartbeat node to keep callbacks active
     * in background tabs when needed.
     * @private
     */
    async _init(){
      const JSSynth = window.JSSynth;
      if (!JSSynth) { console.error('js-synthesizer not found'); return; }
      await JSSynth.waitForReady();
      // Bind WASM module
      if (JSSynth.Synthesizer.waitForWasmInitialized) {
        await JSSynth.Synthesizer.waitForWasmInitialized();
      }
      // Create main synth + node
      this._synth = new JSSynth.Synthesizer();
      this._synth.init(this._audioContext.sampleRate);
      this._node = this._synth.createAudioNode(this._audioContext, 2048);
      this._node.connect(this._gain);
      this._nodeConnected = true;
      // Heartbeat node to keep callbacks in background (Firefox throttles rAF)
      try {
        const sp = this._audioContext.createScriptProcessor(256, 1, 1);
        const g = this._audioContext.createGain();
        g.gain.value = 0; // silent
        sp.connect(g).connect(this._gain);
        sp.onaudioprocess = () => { try { if (typeof this._onAudioTick === 'function') this._onAudioTick(); } catch(_){} };
        this._tickNode = sp; this._tickGain = g; this._tickConnected = true;
      } catch(_) { /* ignore if not available */ }
      this._ready = true;
    }

    /**
     * Load an SF2 soundfont into the main synthesizer.
     * Also caches raw bytes for the isolated test synth.
     * @param {ArrayBuffer|Uint8Array} buf
     */
    async loadSF2(buf){
      while (!this._ready) { await new Promise(r=>setTimeout(r,10)); }
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      this._sfontBytes = bytes.slice();
      this._sfontId = await this._synth.loadSFont(bytes);
      console.log('[DEBUG] js-synthesizer: SF2 loaded');
    }

    /**
     * Replace current soundfont with minimal interruption.
     * @param {ArrayBuffer|Uint8Array} buf
     */
    async replaceSF2(buf){
      // Swap current soundfont with minimal interruption
      while (!this._ready) { await new Promise(r=>setTimeout(r,10)); }
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      // Unload previous if present
      try { if (this._sfontId != null && this._synth.unloadSFont) this._synth.unloadSFont(this._sfontId); } catch(_) {}
      this._sfontBytes = bytes.slice();
      this._sfontId = await this._synth.loadSFont(bytes);
      console.log('[DEBUG] js-synthesizer: SF2 replaced');
    }

    /**
     * Load a Standard MIDI File (SMF) into the built-in player.
     * Resets the internal player first to avoid multiple queued songs.
     * @param {Uint8Array} bytes
     */
    async loadMIDI(bytes){
      while (!this._ready) { await new Promise(r=>setTimeout(r,10)); }
      // Reset internal player to ensure only the new track is queued
      try { this._synth.stopPlayer(); } catch(_) {}
      try { await this._synth.resetPlayer(); } catch(_) {}
      await this._synth.addSMFDataToPlayer(bytes);
      this._currentTime = 0;
      console.log('[DEBUG] js-synthesizer: MIDI loaded');
    }

    /** Start playback (resumes AudioContext if needed). */
    play(){ this._audioContext.resume(); this._synth.playPlayer(); this._playing = true; }
    /** Pause/stop playback immediately. */
    pause(){ this._synth.stopPlayer(); this._playing = false; }

    /**
     * Seek the internal player to a given tick position.
     * @param {number} ticks - absolute tick position (0..totalTicks)
     */
    seek(ticks){
      if (!this._synth) return;
      const t = Math.max(0, Math.floor(Number(ticks) || 0));
      this._synth.seekPlayer(t);
      if (t === 0) this._currentTime = 0;
    }

    /**
     * Ensure an isolated synthesizer exists for the MIDI Test feature.
     * Uses the same SF2 bytes as the main synth but a distinct synth instance,
     * so program changes and notes never affect the main song state.
     * @private
     */
    async _ensureTestSynth(){
      if (this._testSynth) return;
      if (!this._sfontBytes) throw new Error('Load an SF2 first');
      const JSSynth = window.JSSynth;
      await JSSynth.waitForReady();
      this._testSynth = new JSSynth.Synthesizer();
      this._testSynth.init(this._audioContext.sampleRate);
      this._testNode = this._testSynth.createAudioNode(this._audioContext, 1024);
      this._testNode.connect(this._gain);
      await this._testSynth.loadSFont(this._sfontBytes);
    }

    /**
     * Play a short C–E–G arpeggio on the isolated test synth (channel 0).
     * Returns after the last note is released.
     */
    async playTestChord(){
      if (!this._ready || !this._synth) return Promise.resolve();
      await this._ensureTestSynth();
      const chan = 0; // dedicated channel on isolated synth
      try {
        if (this._sfontId != null) this._testSynth.midiProgramSelect(chan, this._sfontId, 0, 0);
        else this._testSynth.midiProgramChange(chan, 0);
        // C -> E -> G
        this._testSynth.midiNoteOn(chan, 60, 100);
        setTimeout(() => { try { this._testSynth.midiNoteOff(chan, 60); this._testSynth.midiNoteOn(chan, 64, 100); } catch(_){} }, 160);
        setTimeout(() => { try { this._testSynth.midiNoteOff(chan, 64); this._testSynth.midiNoteOn(chan, 67, 100); } catch(_){} }, 320);
      } catch(_) {}
      return new Promise((resolve) => {
        setTimeout(() => {
          try { this._testSynth.midiNoteOff(chan, 67); } catch(_) {}
          resolve();
        }, 520);
      });
    }

    // Optional helpers ---------------------------------------------------------
    /** @returns {Promise<number>} total ticks, or 0 on failure */
    async getTotalTicks(){ try { return await this._synth.retrievePlayerTotalTicks(); } catch(_) { return 0; } }
    /** @returns {Promise<number>} current tick, or 0 on failure */
    async getCurrentTick(){ try { return await this._synth.retrievePlayerCurrentTick(); } catch(_) { return 0; } }
    /** @returns {Promise<number>} tempo in microseconds per quarter note */
    async getMidiTempoUsPerQuarter(){ try { return await this._synth.retrievePlayerMIDITempo(); } catch(_) { return 500000; } }
    /** @returns {Promise<number>} beats per minute */
    async getBPM(){ try { return await this._synth.retrievePlayerBpm(); } catch(_) { return 120; } }

    /**
     * Register a callback invoked from the silent heartbeat node's onaudioprocess.
     * Useful to detect end-of-track in background tabs.
     * @param {Function|null} fn
     */
    setOnAudioTick(fn){ this._onAudioTick = (typeof fn === 'function') ? fn : null; }

    // Control connections to reduce CPU when idle ----------------------------
    /** Connect/disconnect main audio node to reduce CPU when idle. */
    setMainNodeEnabled(enabled){
      if (!this._node) return;
      if (enabled && !this._nodeConnected) {
        try { this._node.connect(this._gain); this._nodeConnected = true; } catch(_) {}
      } else if (!enabled && this._nodeConnected) {
        try { this._node.disconnect(); this._nodeConnected = false; } catch(_) {}
      }
    }

    /** Enable/disable background heartbeat node. */
    setHeartbeatEnabled(enabled){
      if (!this._tickNode || !this._tickGain) return;
      if (enabled && !this._tickConnected) {
        try { this._tickNode.connect(this._tickGain); this._tickGain.connect(this._gain); this._tickConnected = true; } catch(_) {}
      } else if (!enabled && this._tickConnected) {
        try { this._tickNode.disconnect(); this._tickGain.disconnect(); this._tickConnected = false; } catch(_) {}
      }
    }

    /** Suspend/resume the AudioContext (low-power idle). */
    async setIdle(idle){
      try {
        if (idle) { await this._audioContext.suspend(); }
        else { await this._audioContext.resume(); }
      } catch(_) {}
    }
  }

  window.JSSynthPlayer = JSSynthPlayer;
})();


