/**
 * Types for the page migration system.
 *
 * Extraction scripts run in-page via evaluate() and return
 * JSON-serializable data matching these interfaces.
 */

export interface VisualNode {
  id: string;
  tag: string;
  selector: string;
  bounds: { x: number; y: number; width: number; height: number };
  background?: { type: 'color' | 'gradient' | 'image'; value: string };
  text?: string;
  role?: string;
  layout?: string;
  children: VisualNode[];
}

export interface VisualTreeResult {
  tree: VisualNode;
  text: string;
  nodeMap: Record<string, string>;
}

export interface BrandData {
  fonts: {
    body: string;
    heading: string;
    sizes: Record<string, { desktop: string; mobile: string }>;
  };
  colors: {
    background: string;
    text: string;
    link: string;
    linkHover: string;
    light: string;
    dark: string;
  };
  spacing: {
    sectionPadding: string;
    contentMaxWidth: string;
    navHeight: string;
  };
  favicons: Array<{ url: string; rel: string; sizes?: string }>;
}

export interface PageMetadata {
  title: string;
  description: string;
  canonical?: string;
  ogTags: Record<string, string>;
  twitterTags: Record<string, string>;
  jsonLd?: unknown[];
}

export interface BlockInventoryEntry {
  name: string;
  hasJs: boolean;
  hasCss: boolean;
  jsSize?: number;
  cssSize?: number;
}

export interface ExtractionResult {
  url: string;
  repo: string;
  projectPath: string;
  branch: string;
  files: {
    screenshot: string;
    visualTree: string;
    brand: string;
    metadata: string;
    blockInventory: string;
  };
  blockCount: number;
  pageSlug: string;
}
