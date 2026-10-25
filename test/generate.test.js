import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { generateFavicons } from '../index.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#e03244"/></svg>';
const manifest = { name: 'Example', startUrl: '../../' };

async function fixture(t, sourceFiles = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'favicons-rokkido-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(sourceFiles)) {
    await writeFile(join(directory, file), contents);
  }
  return directory;
}

async function pngSource() {
  return sharp({
    create: { width: 64, height: 64, channels: 4, background: '#e03244' }
  }).composite([{
    input: Buffer.from('<svg width="64" height="64"><circle cx="32" cy="32" r="18" fill="#2867cf"/></svg>')
  }]).png().toBuffer();
}

async function verifyOutputs(directory, result) {
  assert.equal(result.generated, true);
  assert.equal(result.files.length, 6);
  for (const file of result.files) assert.ok((await readFile(file)).length > 0);

  const ico = await readFile(join(directory, 'favicon.ico'));
  assert.equal(ico.readUInt16LE(4), 3);
  assert.deepEqual([0, 1, 2].map(i => ico[6 + i * 16]), [16, 32, 48]);
  assert.deepEqual([0, 1, 2].map(i => ico[7 + i * 16]), [16, 32, 48]);

  for (const [file, size] of [
    ['apple-touch-icon.png', 180],
    ['web-app-manifest-192x192.png', 192],
    ['web-app-manifest-512x512.png', 512]
  ]) {
    const metadata = await sharp(join(directory, file)).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
  }

  const data = JSON.parse(await readFile(join(directory, 'site.webmanifest'), 'utf8'));
  assert.equal(data.name, 'Example');
  assert.equal(data.short_name, 'Example');
  assert.equal(data.start_url, '../../');
  assert.deepEqual(data.icons.map(icon => icon.src), [
    'web-app-manifest-192x192.png',
    'web-app-manifest-512x512.png'
  ]);
  assert.deepEqual(data.icons.map(icon => icon.purpose), ['maskable', 'maskable']);
}

test('existing manifest is replaced on every run', async t => {
  const directory = await fixture(t, { 'favicon.svg': svg, 'site.webmanifest': 'old' });
  const result = await generateFavicons({ directory, manifest });
  await verifyOutputs(directory, result);
  assert.notEqual(await readFile(join(directory, 'site.webmanifest'), 'utf8'), 'old');
  assert.equal((await generateFavicons({ directory, manifest })).generated, true);
});

test('SVG source generates the required files and keeps its source', async t => {
  const directory = await fixture(t, { 'favicon.svg': svg });
  const result = await generateFavicons({ directory, manifest });
  assert.equal(result.source, 'svg');
  await verifyOutputs(directory, result);
  assert.equal(await readFile(join(directory, 'favicon.svg'), 'utf8'), svg);
});

test('manifest icons fill the canvas without an added white background', async t => {
  const directory = await fixture(t, { 'favicon.svg': svg });
  await generateFavicons({ directory, manifest });
  const { data, info } = await sharp(join(directory, 'web-app-manifest-512x512.png'))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
  assert.equal(pixel(0, 0)[3], 0);
  assert.deepEqual(pixel(64, 256), [224, 50, 68, 255]);
});

test('PNG source produces vector SVG and keeps original PNG', async t => {
  const png = await pngSource();
  const directory = await fixture(t, { 'favicon.png': png });
  const result = await generateFavicons({ directory, manifest });
  assert.equal(result.source, 'png');
  await verifyOutputs(directory, result);
  const traced = await readFile(join(directory, 'favicon.svg'), 'utf8');
  assert.match(traced, /<path\b/);
  assert.doesNotMatch(traced, /<image\b|data:/);
  assert.deepEqual(await readFile(join(directory, 'favicon.png')), png);
});

test('SVG wins over PNG, and PNG is removed after success', async t => {
  const directory = await fixture(t, { 'favicon.svg': svg, 'favicon.png': await pngSource() });
  const result = await generateFavicons({ directory, manifest, removeUnusedPng: true });
  assert.equal(result.source, 'svg');
  await verifyOutputs(directory, result);
  assert.ok(!(await readdir(directory)).includes('favicon.png'));
});

test('missing or corrupt source leaves directory without a manifest', async t => {
  for (const files of [{}, { 'favicon.svg': 'broken' }, { 'favicon.png': 'broken' }]) {
    const directory = await fixture(t, files);
    const before = await readdir(directory);
    await assert.rejects(generateFavicons({ directory, manifest }));
    assert.deepEqual(await readdir(directory), before);
  }
});

test('optional start_url is omitted', async t => {
  const directory = await fixture(t, { 'favicon.svg': svg });
  await generateFavicons({ directory, manifest: { name: 'Example' } });
  const data = JSON.parse(await readFile(join(directory, 'site.webmanifest'), 'utf8'));
  assert.ok(!Object.hasOwn(data, 'start_url'));
});

test('fully transparent PNG still produces a path-based SVG', async t => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: '#00000000' }
  }).png().toBuffer();
  const directory = await fixture(t, { 'favicon.png': png });
  await generateFavicons({ directory, manifest });
  const traced = await readFile(join(directory, 'favicon.svg'), 'utf8');
  assert.match(traced, /<path\b/);
  assert.doesNotMatch(traced, /<image\b|data:/);
  assert.deepEqual(await readFile(join(directory, 'favicon.png')), png);
});

test('write failure leaves source intact and no manifest', async t => {
  const directory = await fixture(t, { 'favicon.svg': svg });
  // A directory at an output path makes copying fail even on an elevated account.
  await mkdir(join(directory, 'favicon.ico'));
  await assert.rejects(generateFavicons({ directory, manifest }));
  assert.equal(await readFile(join(directory, 'favicon.svg'), 'utf8'), svg);
  assert.deepEqual(await readdir(directory), ['favicon.ico', 'favicon.svg']);
});

test('PNG is kept by default when SVG is selected', async t => {
  const png = await pngSource();
  const directory = await fixture(t, { 'favicon.svg': svg, 'favicon.png': png });
  const result = await generateFavicons({ directory, manifest });
  assert.equal(result.source, 'svg');
  assert.deepEqual(await readFile(join(directory, 'favicon.png')), png);
});

test('a second PNG-source run keeps the original PNG by default', async t => {
  const png = await pngSource();
  const directory = await fixture(t, { 'favicon.png': png });
  assert.equal((await generateFavicons({ directory, manifest })).source, 'png');
  assert.equal((await generateFavicons({ directory, manifest })).source, 'svg');
  assert.deepEqual(await readFile(join(directory, 'favicon.png')), png);
});

test('limits reject oversized sources before modifying the directory', async t => {
  const directory = await fixture(t, { 'favicon.svg': svg });
  await assert.rejects(
    generateFavicons({ directory, manifest, limits: { maxSourceBytes: 10 } }),
    /maxSourceBytes|limit is 10 bytes/
  );
  await assert.rejects(
    generateFavicons({ directory, manifest, limits: { maxInputPixels: 1 } }),
    /limit is 1 pixels/
  );
  assert.deepEqual(await readdir(directory), ['favicon.svg']);
});

test('limits cap generated SVG and allow explicit overrides', async t => {
  const png = await pngSource();
  const directory = await fixture(t, { 'favicon.png': png });
  await assert.rejects(
    generateFavicons({ directory, manifest, limits: { maxVectorBytes: 1 } }),
    /maxVectorBytes/
  );
  assert.deepEqual(await readdir(directory), ['favicon.png']);
  const result = await generateFavicons({ directory, manifest, limits: { maxVectorBytes: 1024 * 1024 } });
  assert.equal(result.generated, true);
});

test('failed generation keeps an existing manifest until staging succeeds', async t => {
  const directory = await fixture(t, { 'favicon.svg': svg, 'site.webmanifest': 'old' });
  await assert.rejects(
    generateFavicons({ directory, manifest, limits: { maxSourceBytes: 1 } })
  );
  assert.equal(await readFile(join(directory, 'site.webmanifest'), 'utf8'), 'old');
});

test('write failure removes stale manifest but keeps both sources', async t => {
  const png = await pngSource();
  const directory = await fixture(t, {
    'favicon.svg': svg,
    'favicon.png': png,
    'site.webmanifest': 'old'
  });
  await mkdir(join(directory, 'favicon.ico'));
  await assert.rejects(generateFavicons({ directory, manifest }));
  assert.equal(await readFile(join(directory, 'favicon.svg'), 'utf8'), svg);
  assert.deepEqual(await readFile(join(directory, 'favicon.png')), png);
  assert.ok(!(await readdir(directory)).includes('site.webmanifest'));
});
