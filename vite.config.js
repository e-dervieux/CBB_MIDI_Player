import { defineConfig } from 'vite';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { 
  SF2_PATTERN, 
  EXTERNAL_FILES_PATTERN, 
  SOUNDFONTS_DIR, 
  SOUND_DATA_DIR, 
  EXTERNALS_DIR,
  FLUIDSYNTH_PATTERN 
} from './build-constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find latest FluidSynth version
function findLatestFluidSynth(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const versions = files
    .map(f => {
      const match = f.match(FLUIDSYNTH_PATTERN);
      return match ? { file: f, version: match[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const [aMaj, aMin, aPatch] = a.version.split('.').map(Number);
      const [bMaj, bMin, bPatch] = b.version.split('.').map(Number);
      return bMaj - aMaj || bMin - aMin || bPatch - aPatch;
    });
  return versions[0];
}

// Generate config files for dev/build
function generateConfig() {
  return {
    name: 'generate-config',
    configResolved(config) {
      const isDev = config.command === 'serve';
      const externalsDir = resolve(__dirname, EXTERNALS_DIR);
      const latest = findLatestFluidSynth(externalsDir);
      
      if (!latest) {
        console.warn('[Config] No FluidSynth found!');
        return;
      }

      // Generate fluidsynth-version.js with dynamic FluidSynth path
      const fluidsynthPath = isDev 
        ? `./${EXTERNALS_DIR}/${latest.file}`
        : './externals/libfluidsynth-with-libsndfile.js';
      
      fs.writeFileSync(
        resolve(__dirname, 'fluidsynth-version.js'),
        `export const FLUIDSYNTH_PATH = '${fluidsynthPath}';\n`
      );
      console.log(`[Config] ${isDev ? 'Dev' : 'Build'} mode: FluidSynth v${latest.version}`);
      
      // Generate soundfonts.json (for both dev and build)
      const soundfontsDir = resolve(__dirname, SOUNDFONTS_DIR);
      if (fs.existsSync(soundfontsDir)) {
        const files = fs.readdirSync(soundfontsDir);
        const soundfonts = files.filter(f => SF2_PATTERN.test(f));
        fs.writeFileSync(
          resolve(__dirname, 'soundfonts.json'),
          JSON.stringify({ soundfonts, generated: new Date().toISOString(), count: soundfonts.length }, null, 2)
        );
        console.log(`[Config] Generated soundfonts.json (${soundfonts.length} files)`);
      }
    }
  };
}

// API endpoint for dynamic soundfont listing (dev mode only)
function soundfontListingAPI() {
  return {
    name: 'soundfont-listing-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/api/list-soundfonts') {
          const soundfontsDir = resolve(__dirname, SOUNDFONTS_DIR);
          try {
            const files = fs.readdirSync(soundfontsDir)
              .filter(f => SF2_PATTERN.test(f))
              .sort();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ soundfonts: files, count: files.length }));
          } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'Failed to read soundfonts directory' }));
          }
        } else {
          next();
        }
      });
    }
  };
}

// Copy assets for build only
function copyBuildAssets() {
  return {
    name: 'copy-build-assets',
    apply: 'build',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist');
      
      // Copy FluidSynth externals
      const externalsDir = resolve(__dirname, EXTERNALS_DIR);
      const destExternals = resolve(distDir, 'externals');
      if (fs.existsSync(externalsDir)) {
        fs.mkdirSync(destExternals, { recursive: true });
        const files = fs.readdirSync(externalsDir).filter(f => EXTERNAL_FILES_PATTERN.test(f));
        files.forEach(f => fs.copyFileSync(join(externalsDir, f), join(destExternals, f)));
        
        // Create version-agnostic copy
        const latest = findLatestFluidSynth(externalsDir);
        if (latest) {
          fs.copyFileSync(
            join(destExternals, latest.file),
            join(destExternals, 'libfluidsynth-with-libsndfile.js')
          );
          console.log(`[Build] Copied FluidSynth v${latest.version} → dist/externals/`);
        }
      }
      
      // Copy sound_data folder
      const soundDataDir = resolve(__dirname, SOUND_DATA_DIR);
      if (fs.existsSync(soundDataDir)) {
        fs.cpSync(soundDataDir, resolve(distDir, SOUND_DATA_DIR), { recursive: true });
        console.log(`[Build] Copied ${SOUND_DATA_DIR}/ → dist/${SOUND_DATA_DIR}/`);
      }
      
      // Copy heartbeat-worklet.js
      const workletSrc = resolve(__dirname, 'heartbeat-worklet.js');
      if (fs.existsSync(workletSrc)) {
        fs.copyFileSync(workletSrc, resolve(distDir, 'heartbeat-worklet.js'));
      }
      
      // Copy soundfonts.json (already generated in configResolved)
      const manifestSrc = resolve(__dirname, 'soundfonts.json');
      if (fs.existsSync(manifestSrc)) {
        fs.copyFileSync(manifestSrc, resolve(distDir, 'soundfonts.json'));
      }
    }
  };
}

export default defineConfig({
  root: '.',
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html')
    }
  },
  server: {
    port: 8000
  },
  plugins: [
    generateConfig(),
    soundfontListingAPI(),
    copyBuildAssets()
  ]
});
