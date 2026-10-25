# favicons-rokkido

Generate favicon files from a local `favicon.svg` or `favicon.png` in Node.js. The package does not need Vite, change your HTML, or make network requests during generation.

## Requirements and installation

- Node.js 20.9 or later
- A directory containing `favicon.svg`, `favicon.png`, or both

Install the published package in your project:

```sh
npm install favicons-rokkido
```

Before the first npm release, install a local checkout instead. For example, if the package directory is next to your project:

```sh
npm install ../favicons-rokkido --install-links
```

Run `npm install` in this package directory if you are working on the package itself.

To try the package with `faviconTest/favicon.svg` in this repository, run `npm run demo` from the package directory. The command writes generated icons into `faviconTest`. You can run it again after changing the source image.

## Quick start

Put a source image in your project:

```text
public/
└── img/
    └── favicon/
        └── favicon.svg
```

Create `generate-favicons.mjs` in your project root:

```js
import { generateFavicons } from 'favicons-rokkido';

const result = await generateFavicons({
  directory: './public/img/favicon',
  manifest: {
    name: 'My website',
    shortName: 'My site',
    themeColor: '#ffffff',
    backgroundColor: '#ffffff',
    display: 'standalone',
    startUrl: '../../'
  }
});

console.log(result);
```

Run it from your project root:

```sh
node generate-favicons.mjs
```

Relative `directory` paths are resolved from `process.cwd()`, the directory where you run Node.js. The source and generated files share this directory.

## Options

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `directory` | Yes | — | Path to the source and output directory. |
| `manifest.name` | Yes | — | Non-empty site name. |
| `manifest.shortName` | No | `name` | Short name in the web app manifest. |
| `manifest.themeColor` | No | `#ffffff` | Manifest theme color. |
| `manifest.backgroundColor` | No | `#ffffff` | Manifest background color and Apple icon background. |
| `manifest.display` | No | `standalone` | Manifest display mode. |
| `manifest.startUrl` | No | Omitted | Manifest `start_url`. Resolve this path relative to `site.webmanifest`. |
| `removeUnusedPng` | No | `false` | Remove `favicon.png` after selecting an existing SVG when set to `true`. |
| `limits` | No | See below | Resource limits for the source and traced SVG. |

Supply `startUrl` if you need the manifest to define a PWA start page. It is not written when omitted.

The default limits are `maxSourceBytes: 20971520` (20 MiB), `maxInputPixels: 4000000`, and `maxVectorBytes: 20971520` (20 MiB). A source above a limit fails before the package changes any output. `maxVectorBytes` applies only when tracing PNG to SVG. Override a limit when you trust a larger source:

```js
await generateFavicons({
  directory: './public/img/favicon',
  manifest: { name: 'My website' },
  limits: { maxInputPixels: 8_000_000 }
});
```

Limits reduce the risk of excessive memory use; they are not a time limit for vectorization.

## Generated files

| File | Content |
| --- | --- |
| `favicon.svg` | Original SVG, or vector paths traced from PNG. |
| `favicon.ico` | 16 × 16, 32 × 32, and 48 × 48 pixel frames. |
| `apple-touch-icon.png` | 180 × 180 pixels. |
| `web-app-manifest-192x192.png` | 192 × 192 pixel maskable icon. |
| `web-app-manifest-512x512.png` | 512 × 512 pixel maskable icon. |
| `site.webmanifest` | Site details and relative paths to the two maskable icons. |

Manifest icons fill the available square while preserving the source aspect ratio. Any unused area stays transparent; the package adds no white padding. A device can crop the outer parts when it applies a mask, so keep important details near the center of the source. Raster icons are made directly from the input image. PNG tracing creates real SVG paths, without embedding the PNG. Photos and gradients can produce large SVG files or look different from the original.

The package does not create HTML, CSS, or browser JavaScript. Add links in your page yourself. For example:

```html
<link rel="icon" href="./img/favicon/favicon.ico">
<link rel="icon" type="image/svg+xml" sizes="any" href="./img/favicon/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="./img/favicon/apple-touch-icon.png">
<link rel="manifest" href="./img/favicon/site.webmanifest">
```

Adjust these links for your page's location and URL structure.

## Source selection and repeat runs

- If both `favicon.svg` and `favicon.png` exist, SVG wins. The PNG remains unless `removeUnusedPng: true` is set.
- If only `favicon.png` exists, the package traces it to `favicon.svg` and keeps the original PNG.
- Every call regenerates the icons and replaces `site.webmanifest`. After a PNG-only first run, both sources exist; the next run selects SVG and keeps the PNG by default.

To remove `favicon.png` after selecting SVG:

```js
await generateFavicons({
  directory: './public/img/favicon',
  manifest: { name: 'My website' },
  removeUnusedPng: true
});
```

Success returns `{ generated: true, source: 'svg' | 'png', files: string[] }`. `files` contains absolute paths to all six output files. Missing or unreadable sources, exceeded limits, and generation failures throw an error; the function does not exit the process. Generated files are staged first, and the manifest is written to the output directory last. An existing manifest remains until staging succeeds.
