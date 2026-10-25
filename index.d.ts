export interface FaviconManifestOptions {
  name: string;
  shortName?: string;
  themeColor?: string;
  backgroundColor?: string;
  display?: string;
  startUrl?: string;
}

export interface GenerateFaviconsOptions {
  directory: string;
  manifest: FaviconManifestOptions;
  /** Remove favicon.png after SVG is selected. Default: false. */
  removeUnusedPng?: boolean;
  limits?: {
    /** Maximum source file size in bytes. Default: 20 MiB. */
    maxSourceBytes?: number;
    /** Maximum width × height of the source. Default: 4,000,000. */
    maxInputPixels?: number;
    /** Maximum size of an SVG traced from PNG in bytes. Default: 20 MiB. */
    maxVectorBytes?: number;
  };
}

export type GenerateFaviconsResult = { generated: true; source: 'svg' | 'png'; files: string[] };

export function generateFavicons(options: GenerateFaviconsOptions): Promise<GenerateFaviconsResult>;
