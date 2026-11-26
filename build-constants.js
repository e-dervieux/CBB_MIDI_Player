/**
 * Shared constants for build configuration
 * Used by vite.config.js (and audio-encoder.js for the libav.js location)
 */

// File patterns
export const SF2_PATTERN = /\.(sf2|sf3)$/i;
export const EXTERNAL_FILES_PATTERN = /\.(js|wasm|data)$/i;

// Paths
export const SOUNDFONTS_DIR = 'sound_data/Soundfonts';
export const SOUND_DATA_DIR = 'sound_data';
export const EXTERNALS_DIR = 'node_modules/js-synthesizer/externals';
export const FLUIDSYNTH_PATTERN = /^libfluidsynth-(\d+\.\d+\.\d+)-with-libsndfile\.js$/;
// libav.js (audio export encoders): loaded at run time from LIBAV_DIR in development, LIBAV_BUILD_DIR once built
export const LIBAV_DIR = 'node_modules/@libav.js/variant-obsolete/dist';
export const LIBAV_BUILD_DIR = 'externals/libav';
export const LIBAV_FILES_PATTERN = /^libav-(obsolete\.mjs|[\d.]+-obsolete\.wasm\.(mjs|wasm))$/;

