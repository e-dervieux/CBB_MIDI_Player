/* js-synthesizer adapter for this app
   - Wraps FluidSynth (WASM) via js-synthesizer
   - Stable API used by app.js: loadSF2, loadMIDI, play, pause, seek
   - Internal: isolated test synth for MIDI Test (so it never affects the main song)
*/
(function(){
  'use strict';

  // Constants
  const DEFAULT_GAIN = 0.7;                 // WebAudio default gain (0.0 to 1.0)
  const FLUIDSYNTH_GAIN = 5.0;              // FluidSynth internal gain (0.0 to 10.0)
  const WAIT_FOR_READY_TIMEOUT_MS = 50;     // Timeout for waiting for the synthesizer to be ready
  const AUDIO_BUFFER_SIZE = 2048;           // Buffer size for synth audio node
  const TEST_CHORD_NOTE_DURATION_MS = 160;  // Duration per note in test chord

  /**
   * JSSynthPlayer
   * Adapter around js-synthesizer (FluidSynth WASM) exposing a compact API used by app.js.
   * Manages the WebAudio graph, main synth, and an isolated test synth for the MIDI Test button.
   */
  class JSSynthPlayer {
    /** Safely call a synth method with error handling. */
    async _safeSynthCall(method, synth = 'main', ...args) {
      try {
        const targetSynth = synth === 'test' ? this._testSynth : this._synth;
        if (targetSynth && typeof method === 'function') {
          return await method.apply(targetSynth, args);
        }
      } catch (error) {
        console.error(`[ERROR] Failed to call ${synth} synth method:`, error);
      }
      return null;
    }

    /** Wait for the synthesizer to be ready before proceeding. */
    async _waitForReady() {
      while (!this._ready) { 
        await new Promise(r => setTimeout(r, WAIT_FOR_READY_TIMEOUT_MS)); 
      }
    }

    /** Centralized audio state management. */
    setAudioState(state) {
      const states = {
        // Playing state: full audio pipeline active
        playing: () => {
          this.setIdle(false);
          this.setMainNodeEnabled(true);
          this.setHeartbeatEnabled(true);
        },
        // Paused state: keep main node connected for instant resume
        paused: () => {
          this.setHeartbeatEnabled(false);
          // Keep main node connected and context active for instant resume
        },
        // Stopped state: minimize CPU usage
        stopped: () => {
          this.setHeartbeatEnabled(false);
          this.setMainNodeEnabled(false);
          this.setIdle(true);
        },
        // Low power state: suspend context for battery saving
        lowPower: () => {
          this.setHeartbeatEnabled(false);
          this.setMainNodeEnabled(false);
          this.setIdle(true);
        },
        // Wake up from low power
        wakeUp: () => {
          this.setIdle(false);
          this.setMainNodeEnabled(true);
        }
      };

      if (states[state]) {
        states[state]();
      } else {
        console.warn(`[WARN] Unknown audio state: ${state}`);
      }
    }

    /** Load soundfont into both main and test synths. */
    async _loadSF2IntoBothSynths(sf2FileData, unloadPrevious = false) {
      try {
        // Load into main synth
        if (unloadPrevious && this._sfontId != null) {
          await this._safeSynthCall(this._synth?.unloadSFont, this._sfontId);
        }

        // js-synthesizer's loadSFont() method can handle ArrayBuffer directly
        // See: https://github.com/jet2jet/js-synthesizer
        this._sfontId = await this._synth.loadSFont(sf2FileData);
        
        // Load into test synth (same soundfont, different synth instance)
        await this._ensureTestSynth();
        if (unloadPrevious && this._sfontId != null) {
          await this._safeSynthCall(this._testSynth?.unloadSFont, 'test', this._sfontId);
        }
        // Test synth gets the same soundfont ID as main synth
        await this._testSynth.loadSFont(sf2FileData);
      } catch (error) {
        console.error('[ERROR] Failed to load SF2 into both synths:', error);
        throw error; // Re-throw to propagate the error
      }
    }
    constructor() {
      // WebAudio pipeline ------------------------------------------------------
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this._gain = this._audioContext.createGain();
      this._gain.gain.value = DEFAULT_GAIN;
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
      // Set FluidSynth internal gain for proper volume levels
      if (typeof this._synth.setGain === 'function') {
        this._synth.setGain(FLUIDSYNTH_GAIN);
      }
      this._node = this._synth.createAudioNode(this._audioContext, AUDIO_BUFFER_SIZE);
      this._node.connect(this._gain);
      this._nodeConnected = true;
      // Heartbeat node to keep callbacks in background (Firefox throttles rAF)
      await this._audioContext.audioWorklet.addModule('heartbeat-worklet.js');
      const heartbeatWorklet = new AudioWorkletNode(this._audioContext, 'heartbeat-worklet', {
        processorOptions: { fireEveryNSamples: AUDIO_BUFFER_SIZE }
      });
      heartbeatWorklet.port.onmessage = () => {
        if (typeof this._onAudioTick === 'function') this._onAudioTick();
      };
      const g = this._audioContext.createGain();
      g.gain.value = 0; // Silent
      heartbeatWorklet.connect(g).connect(this._gain);
      this._tickNode = heartbeatWorklet;
      this._tickGain = g;
      this._tickConnected = true;
      this._ready = true;
    }

    /**
     * Load an SF2 soundfont into both main and test synthesizers.
     * @param {ArrayBuffer|Uint8Array} sf2FileData SF2 file data from user input
     * @param {boolean} unloadPrevious whether to unload existing soundfont first
     */
    async loadSF2(sf2FileData, unloadPrevious = false){
      try {
        await this._waitForReady();
        
        // Cache the data for potential reuse (e.g., when switching soundfonts)
        this._sfontBytes = sf2FileData.slice();
        
        await this._loadSF2IntoBothSynths(sf2FileData, unloadPrevious);
        
        console.log('[DEBUG] js-synthesizer: SF2 loaded');
      } catch (error) {
        console.error('[ERROR] Failed to load SF2:', error);
        throw error; // Re-throw to propagate the error
      }
    }

    /**
     * Load a Standard MIDI File (SMF) into the built-in player.
     * Resets the internal player first to avoid multiple queued songs.
     * @param {Uint8Array} SMFbytes SMF contents
     */
    async loadMIDI(SMFbytes){
      try {
        await this._waitForReady();
        // Cache the bytes for potential restart after track ends
        this._lastSmfBytes = SMFbytes.slice();
        // Reset internal player to ensure only the new track is queued
        await this._safeSynthCall(this._synth?.stopPlayer);
        await this._safeSynthCall(this._synth?.resetPlayer);
        await this._synth.addSMFDataToPlayer(SMFbytes);
        this._currentTime = 0;
        console.log('[DEBUG] js-synthesizer: MIDI loaded');
      } catch (error) {
        console.error('[ERROR] Failed to load MIDI:', error);
        throw error; // Re-throw to propagate the error
      }
    }

    /** Start playback (resumes AudioContext if needed). */
    play(){ this._audioContext.resume(); this._synth.playPlayer(); this._playing = true; }
    /** Pause/stop playback immediately. */
    pause(){ this._synth.stopPlayer(); this._playing = false; }

    /**
     * Seek the internal player to a given tick position.
     * @param {number} ticks absolute tick position (0..totalTicks)
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
      try {
        if (this._testSynth) return;
        if (!this._sfontBytes) throw new Error('Load an SF2 first');
        const JSSynth = window.JSSynth;
        await JSSynth.waitForReady();
        this._testSynth = new JSSynth.Synthesizer();
        this._testSynth.init(this._audioContext.sampleRate);
        // Set FluidSynth internal gain for test synth too
        if (typeof this._testSynth.setGain === 'function') {
          this._testSynth.setGain(FLUIDSYNTH_GAIN);
        }
        this._testNode = this._testSynth.createAudioNode(this._audioContext, AUDIO_BUFFER_SIZE);
        this._testNode.connect(this._gain);
        await this._testSynth.loadSFont(this._sfontBytes);
      } catch (error) {
        console.error('[ERROR] Failed to ensure test synth:', error);
        throw error; // Re-throw to propagate the error
      }
    }

    /**
     * Play a short C–E–G arpeggio on the isolated test synth (channel 0).
     * Returns after the last note is released.
     */
    async playTestChord(){
      if (!this._ready || !this._synth) return Promise.resolve();
      await this._ensureTestSynth();
      const chan = 0; // dedicated channel on isolated synth
      
      // C -> E -> G arpeggio with proper timing
      const notes = [60, 64, 67]; // C, E, G
      const noteDuration = TEST_CHORD_NOTE_DURATION_MS; // ms per note
      
      try {
        if (this._sfontId != null) this._testSynth.midiProgramSelect(chan, this._sfontId, 0, 0);
        else this._testSynth.midiProgramChange(chan, 0);
        
        // Play first note immediately
        this._testSynth.midiNoteOn(chan, notes[0], 100);
        
        // Schedule subsequent notes and releases
        for (let i = 1; i < notes.length; i++) {
          setTimeout(() => { 
            this._testSynth.midiNoteOff(chan, notes[i - 1]); 
            this._testSynth.midiNoteOn(chan, notes[i], 100); 
          }, i * noteDuration);
        }
        
        // Schedule final note release
        setTimeout(() => { 
          this._testSynth.midiNoteOff(chan, notes[notes.length - 1]); 
        }, notes.length * noteDuration);
        
      } catch (error) {
        console.error('[ERROR] Failed to play test chord:', error);
        throw error; // propagate to UI handler
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve(), notes.length * noteDuration);
      });
    }

    // Optional helpers ---------------------------------------------------------
    /** @returns {Promise<number>} total ticks, or 0 on failure */
    async getTotalTicks(){ 
      const result = await this._safeSynthCall(this._synth?.retrievePlayerTotalTicks);
      return result || 0;
    }
    /** @returns {Promise<number>} current tick, or 0 on failure */
    async getCurrentTick(){ 
      const result = await this._safeSynthCall(this._synth?.retrievePlayerCurrentTick);
      return result || 0;
    }
    /** @returns {Promise<number>} tempo in microseconds per quarter note */
    async getMidiTempoUsPerQuarter(){ 
      const result = await this._safeSynthCall(this._synth?.retrievePlayerMIDITempo);
      return result || 500000;
    }
    /** @returns {Promise<number>} beats per minute */
    async getBPM(){ 
      const result = await this._safeSynthCall(this._synth?.retrievePlayerBpm);
      return result || 120;
    }

    /** Register a callback invoked by the heartbeat worklet on audio ticks.
     * Useful for end-of-track detection in background tabs.
     * @param {Function|null} fn callback or null to clear
     */
    setOnAudioTick(fn){ this._onAudioTick = (typeof fn === 'function') ? fn : null; }

    // Control connections to reduce CPU when idle ----------------------------
    /** Connect/disconnect main audio node to reduce CPU when idle. */
    setMainNodeEnabled(enabled){
      if (!this._node) return;
      if (enabled && !this._nodeConnected) {
        try { 
          this._node.connect(this._gain); 
          this._nodeConnected = true; 
        } catch (error) {
          console.error('[ERROR] Failed to connect main audio node:', error);
        }
      } else if (!enabled && this._nodeConnected) {
        try { 
          this._node.disconnect(); 
          this._nodeConnected = false; 
        } catch (error) {
          console.error('[ERROR] Failed to disconnect main audio node:', error);
        }
      }
    }

    /** Enable/disable background heartbeat node. */
    setHeartbeatEnabled(enabled){
      if (!this._tickNode || !this._tickGain) return;
      if (enabled && !this._tickConnected) {
        try { 
          this._tickNode.connect(this._tickGain); 
          this._tickGain.connect(this._gain); 
          this._tickConnected = true; 
        } catch (error) {
          console.error('[ERROR] Failed to connect heartbeat node:', error);
        }
      } else if (!enabled && this._tickConnected) {
        try { 
          this._tickNode.disconnect(); 
          this._tickGain.disconnect(); 
          this._tickConnected = false; 
        } catch (error) {
          console.error('[ERROR] Failed to disconnect heartbeat node:', error);
        }
      }
    }

    /** Suspend/resume the AudioContext (low-power idle). */
    async setIdle(idle){
      try {
        if (idle) { 
          const sampleRate = this._audioContext.sampleRate;
          const bufferDurationMs = (AUDIO_BUFFER_SIZE / sampleRate) * 1000;
          const drainDelayMs = Math.ceil(bufferDurationMs * 2);  // 2x buffer duration ensures complete drain
          
          setTimeout(async () => {
            try {
              await this._audioContext.suspend(); 
            } catch (error) {
              console.error('[ERROR] Failed to suspend audio context:', error);
            }
          }, drainDelayMs);
        } else { 
          await this._audioContext.resume(); 
        }
      } catch (error) {
        console.error('[ERROR] Failed to set audio context idle state:', error);
      }
    }
  }

  window.JSSynthPlayer = JSSynthPlayer;
})();


