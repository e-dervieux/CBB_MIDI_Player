/**
 * Shared constants for build configuration
 * Used by vite.config.js
 */

// File patterns
export const SF2_PATTERN = /\.(sf2|sf3)$/i;
export const EXTERNAL_FILES_PATTERN = /\.(js|wasm|data)$/i;

// Paths
export const SOUNDFONTS_DIR = 'sound_data/Soundfonts';
export const SOUND_DATA_DIR = 'sound_data';
export const EXTERNALS_DIR = 'node_modules/js-synthesizer/externals';
export const FLUIDSYNTH_PATTERN = /^libfluidsynth-(\d+\.\d+\.\d+)-with-libsndfile\.js$/;

