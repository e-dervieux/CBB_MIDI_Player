// AudioWorklet for heartbeat end-detection
// Runs continuously to detect MIDI playback end even in background tabs
class HeartbeatWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // Fire every N samples (default 1024 if not provided)
    this.fireEveryNSamples = Math.max(128, Number(opts.fireEveryNSamples) || 1024);
    this.samplesSinceLastPost = 0;
    this.samplesPerQuantum = 128; // fixed by Web Audio spec
  }

  process() {
    this.samplesSinceLastPost += this.samplesPerQuantum;
    if (this.samplesSinceLastPost >= this.fireEveryNSamples) {
      this.port.postMessage(0);
      this.samplesSinceLastPost = 0;
    }
    return true;
  }
}

registerProcessor('heartbeat-worklet', HeartbeatWorklet);
