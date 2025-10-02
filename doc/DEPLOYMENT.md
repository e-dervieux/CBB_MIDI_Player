# Deployment Guide

## Overview

This project now uses a **unified build system** powered by Vite. Both local serving and GitHub Pages deployment use the same `dist/` folder structure, ensuring consistency across environments.

## How It Works

### Build Process

When you run `npm run build`, Vite:

1. **Bundles JavaScript**: Compiles all JS modules (`main.js`, `app.js`, `synthesizer-player.js`) and the `js-synthesizer` library into optimized chunks
2. **Bundles CSS**: Compiles and minifies `styles.css`
3. **Detects FluidSynth Version**: 
   - Scans `node_modules/js-synthesizer/externals/` for available FluidSynth versions
   - Automatically selects the latest version (e.g., 2.4.6)
   - Creates a version-agnostic copy named `libfluidsynth-with-libsndfile.js`
4. **Copies External Dependencies**: 
   - All FluidSynth WASM files from `node_modules/js-synthesizer/externals/` → `dist/externals/`
5. **Copies Sound Data Assets**:
   - `sound_data/` folder (MIDI and SF2 files) → `dist/sound_data/`
   - `assets/` folder → `dist/assets/`
6. **Generates Manifest**: Creates `dist/soundfonts.json` with a list of all SF2 files in `dist/sound_data/Soundfonts/`
7. **Generates HTML**: Creates `dist/index.html` with proper relative paths to all assets

**Version Resilience**: The build system automatically detects the latest FluidSynth version, so updating `js-synthesizer` won't break your build. No hardcoded version numbers!

### Path Resolution

All paths use **relative references** (`./`) which work in both scenarios:
- **Root domain**: `http://localhost:8000/` → `./sound_data/Soundfonts/` → `http://localhost:8000/sound_data/Soundfonts/`
- **Subdirectory**: `https://e-dervieux.github.io/CBB_MIDI_Player/` → `./sound_data/Soundfonts/` → `https://e-dervieux.github.io/CBB_MIDI_Player/sound_data/Soundfonts/`

### Environment-Specific Behavior

The app automatically detects the environment:

#### Development Mode (`npm run dev`)
- Vite dev server runs on port 8000
- Hot module reloading enabled
- **Auto-detects FluidSynth version**: Creates `fluidsynth-version.js` on startup with detected version
- FluidSynth externals loaded from `node_modules/` using detected version
- Sound data files served directly from `sound_data/` folder
- **Refresh button works**: Can dynamically scan for new SF2 files if you add them to `sound_data/Soundfonts/`

#### Production Mode (`npm run build` + serve)
- All assets bundled into `dist/`
- Optimized and minified code
- **Version-agnostic FluidSynth**: Uses `libfluidsynth-with-libsndfile.js` (symlink to latest version)
- FluidSynth externals copied to `dist/externals/`
- Sound data files copied to `dist/sound_data/`
- `soundfonts.json` manifest generated
- **Refresh button behavior**: 
  - If served with directory listing (Python HTTP server): can scan for files
  - If served without directory listing (GitHub Pages): falls back to `soundfonts.json`

## Deployment Options

### 1. Local Development

```bash
npm install
npm run dev
```

Opens at `http://localhost:8000` with hot-reloading.

### 2. Local Production Testing

```bash
npm run serve
```

This builds and serves the production version at `http://localhost:8000`.

### 3. GitHub Pages (Automatic)

The GitHub Actions workflow (`.github/workflows/deploy.yml`) automatically deploys when you push to `master`. It will:

1. Install dependencies
2. Build the project
3. Upload the `dist/` folder
4. Deploy to GitHub Pages

## Scripts Reference

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build (Vite's built-in server)
- `npm run serve` - Build and serve with Python HTTP server
- `npm run clean` - Remove dist folder

