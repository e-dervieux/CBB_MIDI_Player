/* js-synthesizer adapter for this app
   - Wraps FluidSynth (WASM) via js-synthesizer (static ES import; init waits for WASM in _init).
   - Stable API used by app.js: loadSF2, getSoundfont, loadMIDI, play, pause, seek, setPlayerTempoMultiplier,
     setVolume, getVolume, setOnClip, resetClipDetection, setOnAudioTick, playTestChord, setAudioState
   - Output: each synth node applies master volume then a soft clipper, so samples never exceed ±1
   - Internal: isolated test synth for MIDI Test (so it never affects the main song), sharing the soundfont
   - Shared with the audio export: softClip, PEAK_CEILING, clampTempoMultiplier, SharedSoundfont
*/
import * as JSSynth from 'js-synthesizer';

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------
const DEFAULT_VOLUME = 1.0;               // Master volume (unity; app.js drives it from the volume slider)
const FLUIDSYNTH_GAIN = 0.2;              // FluidSynth internal gain: its own default, kept low for headroom in dense passages
const SOFT_CLIP_KNEE = 0.8;               // Soft clipper: identity below this level, smooth shoulder towards ±1 above
// −0.5 dBFS: the export normalizes to this level (see audio-export.js); in playback, peaks above it mean
// the soft clipper is distorting audibly ("CLIPPING!"), peaks between the knee and it only mildly
export const PEAK_CEILING = 0.944;
/** Clipping severity reported to the onClip callback, from least to most severe. */
export const CLIP_LEVEL = Object.freeze({ none: 0, mild: 1, severe: 2 });
const WAIT_FOR_READY_TIMEOUT_MS = 50;     // Timeout for waiting for the synthesizer to be ready
const AUDIO_BUFFER_SIZE = 2048;           // Buffer size for synth audio node
const TEST_CHORD_NOTE_DURATION_MS = 160;  // Duration per note in test chord
// FluidSynth's internal tempo multiplier range (FLUID_PLAYER_TEMPO_INTERNAL), see
// https://github.com/FluidSynth/fluidsynth/blob/master/src/midi/fluid_midi.c
const TEMPO_MULTIPLIER_MIN = 0.001;
const TEMPO_MULTIPLIER_MAX = 1000;
// Support both legacy (PlayerSetTempoType) and current (Constants.PlayerSetTempoType) paths
const INTERNAL_TEMPO_TYPE = JSSynth.Constants?.PlayerSetTempoType?.Internal
  ?? JSSynth.PlayerSetTempoType?.Internal
  ?? 0;

/**
 * Soft clipper: y = x up to the knee, then knee + (1 - knee)·tanh((|x| - knee) / (1 - knee)),
 * which joins the identity with matching slope and asymptotes to ±1, so output never exceeds ±1.
 * @param {number} x input sample
 * @returns {number}
 */
export function softClip(x) {
  const magnitude = Math.abs(x);
  if (magnitude <= SOFT_CLIP_KNEE) return x;
  const headroom = 1 - SOFT_CLIP_KNEE;
  return Math.sign(x) * (SOFT_CLIP_KNEE + headroom * Math.tanh((magnitude - SOFT_CLIP_KNEE) / headroom));
}

/**
 * Clamp a tempo multiplier to FluidSynth's limits.
 * @param {number} multiplier e.g. 0.5 halves speed, 2 doubles
 * @returns {number}
 */
export function clampTempoMultiplier(multiplier) {
  const clamped = Math.min(TEMPO_MULTIPLIER_MAX, Math.max(TEMPO_MULTIPLIER_MIN, multiplier));
  if (clamped !== multiplier) {
    console.warn('[WARN] Tempo multiplier clamped to FluidSynth limits:', multiplier, '→', clamped);
  }
  return clamped;
}

/** The FluidSynth WebAssembly module: global set by libfluidsynth-*.js (see main.js), as used by js-synthesizer. */
const fluidsynth = () => globalThis.Module;
const FLUID_BUFSIZE = 64; // FluidSynth renders in blocks of this many frames

/**
 * A soundfont loaded once and shared by every synthesizer: the player's main and MIDI Test synths, and the synths
 * the audio export renders with. js-synthesizer has no API for this, hence the direct FluidSynth calls on its
 * `_synth` handles (fluid_synth_add_sfont, fluid_synth_remove_sfont).
 *
 * Why share: the soundfont is held in memory once however many synths use it, and loaded once (seconds for large
 * soundfonts). Renders were checked bit-identical to synths loading the soundfont themselves.
 * Why the export renders on fresh synths (createSynth): FluidSynth has no complete reset. fluid_synth_system_reset
 * leaves sound ringing for about 0.7 s and keeps the reverb and chorus oscillators and filters running, so a reused
 * synth renders a track slightly differently from a new one.
 * Renders must be exact: the export renders each track twice and relies on both passes being identical.
 * Soundfont ids are not used: FluidSynth stores the id in the soundfont itself and changes it each time the
 * soundfont is added to a synth.
 * Lifetime: a hidden owner synth holds the soundfont. load() counts as a first hold, retain() adds one,
 * release() drops one and the last release frees the soundfont. By then every synth must have been detached
 * (detach, releaseSynth), since a synth frees the soundfonts it holds when deleted.
 */
export class SharedSoundfont {
  /**
   * @param {ArrayBuffer} sf2Bytes soundfont
   * @param {number} sampleRate any (the owner never renders), e.g. the player's
   * @returns {Promise<SharedSoundfont>} held once: call release() when done
   */
  static async load(sf2Bytes, sampleRate) {
    const owner = new JSSynth.Synthesizer();
    owner.init(sampleRate);
    try {
      const id = await owner.loadSFont(sf2Bytes);
      return new SharedSoundfont(owner, fluidsynth()._fluid_synth_get_sfont_by_id(owner._synth, id));
    } catch (error) {
      owner.close();
      throw error;
    }
  }

  constructor(owner, sfont) {
    this._owner = owner;
    this._sfont = sfont; // fluid_sfont_t pointer
    this._holds = 1;
  }

  /** Keep the soundfont until a matching release(), e.g. for the duration of an export. */
  retain() { this._holds++; }

  /** Drop a hold; the last one frees the soundfont. */
  release() {
    this._holds--;
    if (this._holds === 0) this._owner.close();
  }

  /** Make this the synth's soundfont (each channel then selects its program from it). */
  attach(synth) {
    fluidsynth()._fluid_synth_add_sfont(synth._synth, this._sfont);
  }

  /**
   * Remove this soundfont from a synth, stopping the synth's sounds first: a voice still playing keeps using the
   * soundfont's samples, which then could not be freed (i.e. without this, each replaced soundfont stayed in memory).
   * Voices only end during rendering, hence the rendered block (silent, discarded).
   */
  detach(synth) {
    synth.midiAllSoundsOff();
    synth.render([new Float32Array(FLUID_BUFSIZE), new Float32Array(FLUID_BUFSIZE)]);
    fluidsynth()._fluid_synth_remove_sfont(synth._synth, this._sfont);
  }

  /**
   * Fresh synthesizer set up like the playback one (same FluidSynth gain), with this soundfont and the MIDI
   * file playing. Render it with `synth.render()`; give it back with releaseSynth().
   * @param {number} sampleRate
   * @param {ArrayBuffer} smfBytes Standard MIDI File
   * @param {number} tempoMultiplier already within FluidSynth's limits (see clampTempoMultiplier)
   * @returns {Promise<JSSynth.Synthesizer>}
   */
  async createSynth(sampleRate, smfBytes, tempoMultiplier) {
    const synth = new JSSynth.Synthesizer();
    synth.init(sampleRate);
    this.attach(synth);
    try {
      synth.setGain(FLUIDSYNTH_GAIN);
      await synth.addSMFDataToPlayer(smfBytes);
      synth.setPlayerTempo(INTERNAL_TEMPO_TYPE, tempoMultiplier);
      await synth.playPlayer();
    } catch (error) {
      this.releaseSynth(synth);
      throw error;
    }
    return synth;
  }

  /** Detach the soundfont from a synth made by createSynth, then close the synth. */
  releaseSynth(synth) {
    this.detach(synth);
    synth.close();
  }
}

/**
 * JSSynthPlayer
 * Adapter around js-synthesizer (FluidSynth WASM) exposing a compact API used by app.js.
 * Manages the WebAudio graph, main synth, and an isolated test synth for the MIDI Test button.
 */
class JSSynthPlayer {
  /**
   * Safely call a synth instance method (main or test).
   * @param {object|null} target `this._synth` or `this._testSynth`
   * @param {Function|undefined} method e.g. `target?.stopPlayer`
   */
  async _safeSynthCall(target, method, ...args) {
    try {
      if (target && typeof method === 'function') {
        return await method.apply(target, args);
      }
    } catch (error) {
      console.error('[ERROR] Failed to call synth method:', error);
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
      // Playing: full pipeline active (context resumed, main + heartbeat connected).
      playing: () => {
        this.setIdle(false);
        this.setMainNodeEnabled(true);
        this.setHeartbeatEnabled(true);
      },
      // Paused: keep main node connected for instant resume; heartbeat off.
      paused: () => {
        this.setHeartbeatEnabled(false);
        // Keep main node connected and context active for instant resume
      },
      // Stopped: disconnect nodes, optional suspend via setIdle(true).
      stopped: () => {
        this.setHeartbeatEnabled(false);
        this.setMainNodeEnabled(false);
        this.setIdle(true);
      },
      // Low power: like stopped; entered after idle pause timeout for battery savings.
      lowPower: () => {
        this.setHeartbeatEnabled(false);
        this.setMainNodeEnabled(false);
        this.setIdle(true);
      },
      // Wake up: resume context and reconnect main path for quick play.
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

  constructor() {
    // WebAudio pipeline ------------------------------------------------------
    // Synth nodes (volume + soft clip applied per sample, see _createSynthNode) → destination
    this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this._volume = DEFAULT_VOLUME;
    this._clipLevel = CLIP_LEVEL.none; // worst clipping so far (cleared by resetClipDetection)
    this._onClip = null;          // callback invoked when clipping gets worse

    // Synth state ------------------------------------------------------------
    this._synth = null;           // main synthesizer (FluidSynth)
    this._soundfont = null;       // SharedSoundfont of the main and test synths (see loadSF2)
    this._node = null;            // main audio node
    this._tickNode = null;        // background heartbeat node
    this._tickGain = null;        // silent gain for heartbeat
    this._onAudioTick = null;     // callback invoked on audio process
    this._nodeConnected = false;  // whether main node is connected to destination
    this._tickConnected = false;  // whether heartbeat → destination path is connected
    this._idleSuspendTimer = null; // deferred AudioContext.suspend (see setIdle)

    // Isolated test synth (for MIDI Test) -----------------------------------
    this._testSynth = null;
    this._testNode = null;

    // Readiness --------------------------------------------------------------
    this._ready = false;
    this._init();
  }

  /**
   * Streaming audio node for a synth instance. Same as js-synthesizer's createAudioNode
   * (FluidSynth renders each block), plus master volume and soft clipping on every sample.
   * Reports through the onClip callback each time clipping gets worse (see CLIP_LEVEL).
   * @param {JSSynth.Synthesizer} synth main or test synthesizer
   * @returns {ScriptProcessorNode}
   * @private
   */
  _createSynthNode(synth) {
    const node = this._audioContext.createScriptProcessor(AUDIO_BUFFER_SIZE, 0, 2);
    node.addEventListener('audioprocess', (ev) => {
      const buffer = ev.outputBuffer;
      synth.render(buffer);
      let peak = 0;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const samples = buffer.getChannelData(c);
        for (let i = 0; i < samples.length; i++) {
          const x = this._volume * samples[i];
          peak = Math.max(peak, Math.abs(x));
          samples[i] = softClip(x);
        }
      }
      const level = peak > PEAK_CEILING ? CLIP_LEVEL.severe
        : peak > SOFT_CLIP_KNEE ? CLIP_LEVEL.mild
          : CLIP_LEVEL.none;
      if (level > this._clipLevel) {
        this._clipLevel = level;
        if (this._onClip) this._onClip(level);
      }
    });
    return node;
  }

  /**
   * Initialize js-synthesizer and bootstrap the audio graph.
   * Creates main synth and audio nodes, plus a silent heartbeat node to keep callbacks active
   * in background tabs (for instance, Firefox throttles requestAnimationFrame).
   * @private
   */
  async _init() {
    await JSSynth.waitForReady();
    // Ensure WASM backing the Synthesizer is initialized before first use.
    if (JSSynth.Synthesizer.waitForWasmInitialized) {
      await JSSynth.Synthesizer.waitForWasmInitialized();
    }
    // Main synthesizer + streaming audio node.
    this._synth = new JSSynth.Synthesizer();
    this._synth.init(this._audioContext.sampleRate);
    // FluidSynth internal gain (separate from the master volume applied in _createSynthNode).
    if (typeof this._synth.setGain === 'function') {
      this._synth.setGain(FLUIDSYNTH_GAIN);
    }
    this._node = this._createSynthNode(this._synth);
    this._node.connect(this._audioContext.destination);
    this._nodeConnected = true;
    // Heartbeat worklet: fires on audio clock so end-of-track checks work when the tab is backgrounded.
    await this._audioContext.audioWorklet.addModule('heartbeat-worklet.js');
    const heartbeatWorklet = new AudioWorkletNode(this._audioContext, 'heartbeat-worklet', {
      processorOptions: { fireEveryNSamples: AUDIO_BUFFER_SIZE }
    });
    heartbeatWorklet.port.onmessage = () => {
      if (typeof this._onAudioTick === 'function') this._onAudioTick();
    };
    const g = this._audioContext.createGain();
    g.gain.value = 0; // Silent
    heartbeatWorklet.connect(g).connect(this._audioContext.destination);
    this._tickNode = heartbeatWorklet;
    this._tickGain = g;
    this._tickConnected = true;
    this._ready = true;
  }

  /**
   * Load an SF2 soundfont, replacing the current one, for both the main and test synthesizers (one shared
   * soundfont, see SharedSoundfont). The current one is released first, so the player never holds two at once.
   * @param {ArrayBuffer|Uint8Array} sf2FileData SF2 file data
   */
  async loadSF2(sf2FileData) {
    await this._waitForReady();
    this._ensureTestSynth();
    const synths = [this._synth, this._testSynth];
    if (this._soundfont) {
      for (const synth of synths) this._soundfont.detach(synth);
      this._soundfont.release();
      this._soundfont = null;
    }
    this._soundfont = await SharedSoundfont.load(sf2FileData, this._audioContext.sampleRate);
    for (const synth of synths) this._soundfont.attach(synth);
    console.log('[DEBUG] js-synthesizer: SF2 loaded');
  }

  /**
   * Load a Standard MIDI File (SMF) into the built-in player.
   * Resets the internal player first to avoid multiple queued songs.
   * @param {Uint8Array} SMFbytes SMF contents
   */
  async loadMIDI(SMFbytes) {
    try {
      await this._waitForReady();
      // Cache the bytes for potential restart after track ends
      this._lastSmfBytes = SMFbytes.slice();
      // Reset internal player so only the new file is queued.
      await this._safeSynthCall(this._synth, this._synth?.stopPlayer);
      // MIDI system reset: stopPlayer only silences voices, so programs, controllers (sustain,
      // modulation, expression…) and pitch bend would otherwise carry over into the next file.
      await this._safeSynthCall(this._synth, this._synth?.midiSystemReset);
      await this._safeSynthCall(this._synth, this._synth?.resetPlayer);
      await this._synth.addSMFDataToPlayer(SMFbytes);
      console.log('[DEBUG] js-synthesizer: MIDI loaded');
    } catch (error) {
      console.error('[ERROR] Failed to load MIDI:', error);
      throw error; // Re-throw to propagate the error
    }
  }

  /**
   * Set the master volume (linear gain). Above 1, loud passages may reach the soft clipper.
   * @param {number} gain e.g. 1 = unity, 2 ≈ +6 dB
   */
  setVolume(gain) { this._volume = gain; }

  /** @returns {number} current master volume (linear gain) */
  getVolume() { return this._volume; }

  /**
   * Register a callback invoked when clipping gets worse: first mild, then severe (see CLIP_LEVEL).
   * @param {((level: number) => void)|null} fn callback, given the new CLIP_LEVEL, or null to clear
   */
  setOnClip(fn) { this._onClip = (typeof fn === 'function') ? fn : null; }

  /** Forget the clipping seen so far, so the onClip callback fires again on the next clipped block. */
  resetClipDetection() { this._clipLevel = CLIP_LEVEL.none; }

  /** @returns {SharedSoundfont|null} the loaded soundfont, null before the first one is loaded */
  getSoundfont() { return this._soundfont; }

  /** Start playback (resumes AudioContext if needed). */
  play() { this._audioContext.resume(); this._synth.playPlayer(); }

  /** Pause/stop FluidSynth player immediately (MIDI clock stops). */
  pause() { this._synth.stopPlayer(); }

  /**
   * FluidSynth FLUID_PLAYER_TEMPO_INTERNAL: multiply all MIDI tempo events uniformly.
   * Backed by Synthesizer.setPlayerTempo (PlayerSetTempoType.Internal).
   * @param {number} multiplier e.g. 0.5 halves speed, 2 doubles
   * @returns {number|undefined} multiplier actually applied (after clamping), undefined if it could not be applied
   */
  setPlayerTempoMultiplier(multiplier) {
    const m = Number(multiplier);
    if (!Number.isFinite(m)) {
      console.error('[ERROR] Invalid tempo multiplier:', multiplier);
      return undefined;
    }
    const clamped = clampTempoMultiplier(m);
    try {
      this._synth.setPlayerTempo(INTERNAL_TEMPO_TYPE, clamped);
    } catch (error) {
      console.error('[ERROR] setPlayerTempo failed:', error);
      return undefined;
    }
    return clamped;
  }

  /**
   * Seek the internal player to a given tick position.
   * @param {number} ticks absolute tick position (0..totalTicks)
   */
  seek(ticks) {
    if (!this._synth) return;
    const t = Math.max(0, Math.floor(Number(ticks) || 0));
    this._synth.seekPlayer(t);
  }

  /**
   * Ensure an isolated synthesizer exists for the MIDI Test feature: it shares the main synth's soundfont
   * (see loadSF2) but is a distinct synth instance, so program changes and notes never affect the main song state.
   * @private
   */
  _ensureTestSynth() {
    if (this._testSynth) return;
    this._testSynth = new JSSynth.Synthesizer();
    this._testSynth.init(this._audioContext.sampleRate);
    // Match main synth gain so test chord level is comparable.
    this._testSynth.setGain(FLUIDSYNTH_GAIN);
    this._testNode = this._createSynthNode(this._testSynth);
    this._testNode.connect(this._audioContext.destination);
  }

  /**
   * Play a short C–E–G arpeggio on the isolated test synth (channel 0).
   * Returns after the last note is released.
   */
  async playTestChord() {
    if (!this._ready || !this._synth) return Promise.resolve();
    this._ensureTestSynth();
    const chan = 0; // Dedicated channel on the test instance only.

    // C -> E -> G arpeggio with proper duration per note
    const notes = [60, 64, 67]; // C, E, G
    const noteDuration = TEST_CHORD_NOTE_DURATION_MS;
    try {
      this._testSynth.midiProgramChange(chan, 0);

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

  /** Register a callback invoked by the heartbeat worklet on audio ticks.
   * Useful for end-of-track detection in background tabs.
   * @param {Function|null} fn callback or null to clear
   */
  setOnAudioTick(fn) { this._onAudioTick = (typeof fn === 'function') ? fn : null; }

  /** Connect/disconnect main audio node to reduce CPU when idle. */
  setMainNodeEnabled(enabled) {
    if (!this._node) return;
    if (enabled && !this._nodeConnected) {
      try {
        this._node.connect(this._audioContext.destination);
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
  setHeartbeatEnabled(enabled) {
    if (!this._tickNode || !this._tickGain) return;
    if (enabled && !this._tickConnected) {
      try {
        this._tickNode.connect(this._tickGain);
        this._tickGain.connect(this._audioContext.destination);
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

  /**
   * Suspend/resume the AudioContext (low-power idle).
   * Suspend is deferred by two render-quantum durations so the final samples drain cleanly.
   * Any pending suspend is cancelled when setIdle(false) is called, so a quick pause→play
   * cannot leave the context suspended with no matching resume.
   */
  async setIdle(idle) {
    if (this._idleSuspendTimer !== null) {
      clearTimeout(this._idleSuspendTimer);
      this._idleSuspendTimer = null;
    }
    try {
      if (idle) {
        // ~2× one buffer at current sample rate (matches prior inline calculation intent).
        const drainDelayMs = Math.ceil((AUDIO_BUFFER_SIZE / this._audioContext.sampleRate) * 1000 * 2);
        this._idleSuspendTimer = setTimeout(async () => {
          this._idleSuspendTimer = null;
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

export { JSSynthPlayer };
