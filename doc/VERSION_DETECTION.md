# FluidSynth Version Detection

## Problem

The previous implementation hardcoded the FluidSynth version in the path:
```javascript
'../node_modules/js-synthesizer/externals/libfluidsynth-2.4.6-with-libsndfile.js'
```

This would break whenever `js-synthesizer` updates to a new FluidSynth version.

## Solution

The build system now **automatically detects** the latest available FluidSynth version and creates version-agnostic references.

### How It Works

#### Development Mode

1. When you run `npm run dev`, Vite's `detectFluidSynthVersion` plugin:
   - Scans `node_modules/js-synthesizer/externals/`
   - Finds all `libfluidsynth-*-with-libsndfile.js` files
   - Sorts by version number and picks the latest
   - Creates `src/fluidsynth-config.json` with the detected version info

2. The app loads this config at runtime and uses the correct path

**Example config:**
```json
{
  "version": "2.4.6",
  "file": "libfluidsynth-2.4.6-with-libsndfile.js",
  "path": "../node_modules/js-synthesizer/externals/libfluidsynth-2.4.6-with-libsndfile.js"
}
```

#### Production Mode

1. When you run `npm run build`, Vite's `copyJsSynthesizerExternals` plugin:
   - Copies all FluidSynth files to `dist/externals/`
   - Detects the latest version (same logic as dev)
   - **Creates a copy** named `libfluidsynth-with-libsndfile.js` (no version number)

2. The app simply loads `./externals/libfluidsynth-with-libsndfile.js`

### Benefits

✅ **No hardcoded versions**: Update `js-synthesizer` and everything just works
✅ **Automatic latest selection**: Always uses the newest available FluidSynth
✅ **Fallback handling**: If detection fails, falls back to a reasonable default
✅ **Consistent API**: Same approach for both dev and production

### Version Sorting Algorithm

The system uses semantic versioning comparison:
- Extracts version numbers using regex: `/libfluidsynth-([\d.]+)-/`
- Splits into parts: `"2.4.6"` → `[2, 4, 6]`
- Compares numerically: `2.4.6 > 2.3.0 > 2.4.0`
- Handles different lengths: `2.4` is treated as `2.4.0`

### Maintenance

If you update `js-synthesizer`:
```bash
npm update js-synthesizer
npm run build  # Automatically detects new version
```

No code changes needed!

### Testing

To verify version detection:
```bash
# Development
npm run dev
# Look for: [FluidSynth] Detected version X.X.X

# Production
npm run build
# Look for: [Externals] Using FluidSynth vX.X.X as default
```

### Files

- **`vite.config.js`**: Contains version detection logic
- **`src/main.js`**: Loads the appropriate FluidSynth file
- **`src/fluidsynth-config.json`**: Auto-generated (dev only, gitignored)
- **`dist/externals/libfluidsynth-with-libsndfile.js`**: Version-agnostic copy (production)

