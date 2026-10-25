import { fileURLToPath } from 'node:url';
import { generateFavicons } from '../index.js';

const directory = fileURLToPath(new URL('../faviconTest/', import.meta.url));
const result = await generateFavicons({
  directory,
  manifest: { name: 'Favicon Test' }
});

console.log(result);
