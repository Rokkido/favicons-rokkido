import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import vtracer from '@visioncortex/vtracer';

const ICON_FILES = [
  'favicon.ico',
  'apple-touch-icon.png',
  'web-app-manifest-192x192.png',
  'web-app-manifest-512x512.png'
];

const MANIFEST_FILE = 'site.webmanifest';
const SVG_FILE = 'favicon.svg';
const PNG_FILE = 'favicon.png';
const DEFAULT_LIMITS = Object.freeze({
  maxSourceBytes: 20 * 1024 * 1024,
  maxInputPixels: 4_000_000,
  maxVectorBytes: 20 * 1024 * 1024
});

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, fallback, label) {
  return value === undefined ? fallback : requiredString(value, label);
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function getLimits(input) {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError('limits must be an object');
  }
  for (const name of Object.keys(input ?? {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit: ${name}`);
  }
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`limits.${name} must be a positive safe integer`);
    }
  }
  return limits;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function loadSource(directory, limits) {
  const svgPath = join(directory, SVG_FILE);
  const pngPath = join(directory, PNG_FILE);
  const hasSvg = await isFile(svgPath);
  const hasPng = await isFile(pngPath);
  if (!hasSvg && !hasPng) {
    throw new Error(`No favicon source found in ${directory}; expected favicon.svg or favicon.png`);
  }

  const source = hasSvg ? 'svg' : 'png';
  const sourcePath = hasSvg ? svgPath : pngPath;
  let input;
  try {
    const sourceSize = (await stat(sourcePath)).size;
    if (sourceSize > limits.maxSourceBytes) {
      throw new Error(`source is ${sourceSize} bytes; limit is ${limits.maxSourceBytes} bytes`);
    }
    input = await readFile(sourcePath);
    const metadata = await sharp(input).metadata();
    if (metadata.format !== source) throw new Error(`expected ${source.toUpperCase()} data`);
    const pixels = metadata.width * metadata.height;
    if (pixels > limits.maxInputPixels) {
      throw new Error(`source is ${pixels} pixels; limit is ${limits.maxInputPixels} pixels`);
    }
    await sharp(input).resize(1, 1).png().toBuffer();
  } catch (error) {
    throw new Error(`Cannot read or decode ${sourcePath}: ${error.message}`, { cause: error });
  }
  return { source, input, hasPng, pngPath };
}

async function raster(input, size, background) {
  return sharp(input)
    .resize(size, size, { fit: 'contain', background })
    .png()
    .toBuffer();
}

function createManifest(manifest) {
  const name = requiredString(manifest?.name, 'manifest.name');
  const result = {
    name,
    short_name: optionalString(manifest.shortName, name, 'manifest.shortName'),
    theme_color: optionalString(manifest.themeColor, '#ffffff', 'manifest.themeColor'),
    background_color: optionalString(manifest.backgroundColor, '#ffffff', 'manifest.backgroundColor'),
    display: optionalString(manifest.display, 'standalone', 'manifest.display')
  };
  if (manifest.startUrl !== undefined) {
    result.start_url = requiredString(manifest.startUrl, 'manifest.startUrl');
  }
  result.icons = [192, 512].map(size => ({
    src: `web-app-manifest-${size}x${size}.png`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose: 'maskable'
  }));
  return result;
}

async function tracePixels(input, maxVectorBytes) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const paths = [];
  const { width, height, channels } = info;
  const prefix = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">`;
  const suffix = '</svg>';
  let outputBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width;) {
      const offset = (y * width + x) * channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const alpha = data[offset + 3];
      let end = x + 1;
      while (end < width) {
        const next = (y * width + end) * channels;
        if (data[next] !== red || data[next + 1] !== green || data[next + 2] !== blue || data[next + 3] !== alpha) break;
        end++;
      }
      if (alpha) {
        const color = [red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('');
        const opacity = alpha === 255 ? '' : ` fill-opacity="${(alpha / 255).toFixed(6)}"`;
        const path = `<path fill="#${color}"${opacity} d="M${x} ${y}h${end - x}v1H${x}z"/>`;
        outputBytes += Buffer.byteLength(path);
        if (outputBytes > maxVectorBytes) {
          throw new Error(`Generated SVG exceeds limits.maxVectorBytes (${maxVectorBytes} bytes)`);
        }
        paths.push(path);
      }
      x = end;
    }
  }
  // An empty image has no visible contours; keep one invisible vector contour.
  if (!paths.length) {
    const path = '<path fill="#000000" fill-opacity="0" d="M0 0h1v1H0z"/>';
    outputBytes += Buffer.byteLength(path);
    if (outputBytes > maxVectorBytes) {
      throw new Error(`Generated SVG exceeds limits.maxVectorBytes (${maxVectorBytes} bytes)`);
    }
    paths.push(path);
  }
  return `${prefix}${paths.join('')}${suffix}`;
}

async function vectorize(input, maxVectorBytes) {
  let svg;
  try {
    svg = vtracer.convertBuffer(input, { preset: 'poster' });
  } catch {
    // Valid images VTracer cannot trace still get vector paths below.
  }
  if (svg && /<svg\b/i.test(svg) && /<path\b/i.test(svg) && !/<image\b|data:/i.test(svg)) {
    if (Buffer.byteLength(svg) > maxVectorBytes) {
      throw new Error(`Generated SVG exceeds limits.maxVectorBytes (${maxVectorBytes} bytes)`);
    }
    return svg;
  }
  return tracePixels(input, maxVectorBytes);
}

async function checkOutputs(stage, generatedSvg) {
  if (generatedSvg) {
    const svg = await readFile(join(stage, SVG_FILE), 'utf8');
    if (!/<svg\b/i.test(svg) || !/<path\b/i.test(svg) || /<image\b|data:/i.test(svg)) {
      throw new Error('PNG vectorization did not produce a path-based SVG');
    }
  }

  for (const [file, size] of [
    ['apple-touch-icon.png', 180],
    ['web-app-manifest-192x192.png', 192],
    ['web-app-manifest-512x512.png', 512]
  ]) {
    const info = await sharp(join(stage, file)).metadata();
    if (info.format !== 'png' || info.width !== size || info.height !== size) {
      throw new Error(`Invalid generated image: ${file}`);
    }
  }

  const ico = await readFile(join(stage, 'favicon.ico'));
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 3) {
    throw new Error('Invalid generated favicon.ico');
  }
  const dimensions = [16, 32, 48];
  for (let i = 0; i < dimensions.length; i++) {
    if (ico[6 + i * 16] !== dimensions[i] || ico[7 + i * 16] !== dimensions[i]) {
      throw new Error('favicon.ico has incorrect frame sizes');
    }
  }
}

/** Generate favicon files in a directory containing favicon.svg or favicon.png. */
export async function generateFavicons(options) {
  const directory = resolve(requiredString(options?.directory, 'directory'));
  const manifestPath = join(directory, MANIFEST_FILE);
  const removeUnusedPng = optionalBoolean(options.removeUnusedPng, false, 'removeUnusedPng');
  const limits = getLimits(options.limits);
  const source = await loadSource(directory, limits);
  const manifest = createManifest(options.manifest);
  const files = [SVG_FILE, ...ICON_FILES, MANIFEST_FILE];
  let stage;
  try {
    await access(directory, constants.W_OK);
    stage = await mkdtemp(join(directory, '.favicon-tmp-'));

    if (source.source === 'png') {
      let svg;
      try {
        svg = await vectorize(source.input, limits.maxVectorBytes);
      } catch (error) {
        throw new Error(`Cannot vectorize ${source.pngPath}: ${error.message}`, { cause: error });
      }
      await writeFile(join(stage, SVG_FILE), svg);
    }

    const icoFrames = [];
    for (const size of [16, 32, 48]) {
      const frame = join(stage, `ico-${size}.png`);
      await writeFile(frame, await raster(source.input, size, '#00000000'));
      icoFrames.push(frame);
    }
    await writeFile(join(stage, 'favicon.ico'), await pngToIco(icoFrames));
    await writeFile(join(stage, 'apple-touch-icon.png'), await raster(source.input, 180, manifest.background_color));
    for (const size of [192, 512]) {
      await writeFile(
        join(stage, `web-app-manifest-${size}x${size}.png`),
        await raster(source.input, size, '#00000000')
      );
    }

    await writeFile(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await checkOutputs(stage, source.source === 'png');
    // Keep the old manifest until staging succeeds; remove it before changing outputs.
    await rm(manifestPath, { force: true });
    for (const file of ICON_FILES) {
      await copyFile(join(stage, file), join(directory, file));
    }
    if (source.source === 'png') {
      await copyFile(join(stage, SVG_FILE), join(directory, SVG_FILE));
    }
    await rename(join(stage, MANIFEST_FILE), manifestPath);
    if (source.source === 'svg' && source.hasPng && removeUnusedPng) {
      try {
        await unlink(source.pngPath);
      } catch (error) {
        await rm(manifestPath, { force: true });
        throw new Error(`Generated icons, but cannot remove ${source.pngPath}: ${error.message}`, { cause: error });
      }
    }
    return { generated: true, source: source.source, files: files.map(file => join(directory, file)) };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
