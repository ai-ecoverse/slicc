/**
 * migrate_page tool — Extract page data for EDS migration.
 *
 * Clones the target repo, navigates to the URL, captures a full-page
 * screenshot, extracts the visual tree, brand data, metadata, and
 * inventories existing blocks. Returns file paths for all artifacts.
 */

import type { BrowserAPI } from '../cdp/index.js';
import { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import type { ExtractionResult } from '../migration/types.js';
import { GitCommands } from '../git/git-commands.js';
import { OVERLAY_DISMISS_SCRIPT } from '../migration/scripts/overlay-dismiss-script.js';
import { PAGE_PREP_SCRIPT } from '../migration/scripts/page-prep-script.js';
import { VISUAL_TREE_SCRIPT } from '../migration/scripts/visual-tree-script.js';
import { BRAND_EXTRACT_SCRIPT } from '../migration/scripts/brand-script.js';
import { METADATA_EXTRACT_SCRIPT } from '../migration/scripts/metadata-script.js';
import { scanBlockInventory } from '../migration/block-inventory.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool:migrate-page');

export function deriveProjectPath(repo: string): string {
  const repoName = repo.split('/').pop() || repo;
  return `/shared/${repoName}`;
}

export function deriveBranchName(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/|\/$/g, '') || 'index';
  const slug = path.replace(/\//g, '-');
  return `migrate/${slug}`;
}

/** Minimal interface for git operations (testable). */
export interface GitOps {
  clone(repo: string, dest: string): Promise<void>;
  checkoutNewBranch(dir: string, branch: string): Promise<void>;
}

async function readGithubToken(): Promise<string | undefined> {
  // Check .env first (VITE_GITHUB_TOKEN)
  const envToken = (import.meta as unknown as { env?: Record<string, string> })
    .env?.VITE_GITHUB_TOKEN;
  if (envToken) return envToken;

  // Fall back to git config token in global VFS
  try {
    const globalFs = await VirtualFS.create({
      dbName: 'slicc-fs-global',
    });
    const token = (
      await globalFs.readFile('/workspace/.git/github-token', {
        encoding: 'utf-8',
      })
    ) as string;
    return token.trim() || undefined;
  } catch {
    return undefined;
  }
}

function createDefaultGitOps(fs: VirtualFS): GitOps {
  return {
    async clone(repo: string, dest: string): Promise<void> {
      const token = await readGithubToken();
      const host = token
        ? `x-access-token:${token}@github.com`
        : 'github.com';
      const gitUrl = `https://${host}/${repo}.git`;
      const git = new GitCommands({ fs });
      const result = await git.execute(
        ['clone', gitUrl, dest, '--depth', '1'],
        '/',
      );
      if (result.exitCode !== 0) {
        throw new Error(`git clone failed: ${result.stderr}`);
      }
    },
    async checkoutNewBranch(
      dir: string,
      branch: string,
    ): Promise<void> {
      const git = new GitCommands({ fs });
      const result = await git.execute(
        ['checkout', '-b', branch],
        dir,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `git checkout -b failed: ${result.stderr}`,
        );
      }
    },
  };
}

/** Decode base64 string to Uint8Array. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function runMigrationExtraction(
  browser: BrowserAPI,
  fs: VirtualFS,
  url: string,
  repo: string,
  projectPath: string,
  branch: string,
): Promise<ExtractionResult> {
  const migrationDir = `${projectPath}/.migration`;
  await fs.mkdir(migrationDir, { recursive: true });

  const targetId = await browser.createPage(url);
  await browser.attachToPage(targetId);
  await browser.navigate(url);

  log.info('Dismissing overlays');
  await browser.evaluate(OVERLAY_DISMISS_SCRIPT);

  await browser.evaluate(PAGE_PREP_SCRIPT);

  const base64 = await browser.screenshot({ fullPage: true });
  const screenshotPath = `${migrationDir}/screenshot.png`;
  await fs.writeFile(screenshotPath, base64ToBytes(base64 as string));

  const visualTree = await browser.evaluate(VISUAL_TREE_SCRIPT);
  const visualTreePath = `${migrationDir}/visual-tree.json`;
  await fs.writeFile(
    visualTreePath,
    JSON.stringify(visualTree, null, 2),
  );

  const brand = await browser.evaluate(BRAND_EXTRACT_SCRIPT);
  const brandPath = `${migrationDir}/brand.json`;
  await fs.writeFile(brandPath, JSON.stringify(brand, null, 2));

  const metadata = await browser.evaluate(METADATA_EXTRACT_SCRIPT);
  const metadataPath = `${migrationDir}/metadata.json`;
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  const blocks = await scanBlockInventory(fs, projectPath);
  const inventoryPath = `${migrationDir}/block-inventory.json`;
  await fs.writeFile(inventoryPath, JSON.stringify(blocks, null, 2));

  const parsed = new URL(url);
  const pageSlug =
    parsed.pathname.replace(/^\/|\/$/g, '') || 'index';

  return {
    url,
    repo,
    projectPath,
    branch,
    files: {
      screenshot: screenshotPath,
      visualTree: visualTreePath,
      brand: brandPath,
      metadata: metadataPath,
      blockInventory: inventoryPath,
    },
    blockCount: blocks.length,
    pageSlug,
  };
}

function formatResult(result: ExtractionResult): string {
  return [
    `Migration extraction complete for ${result.url}`,
    ``,
    `Project: ${result.projectPath}`,
    `Branch: ${result.branch}`,
    `Page: ${result.pageSlug}`,
    `Blocks found: ${result.blockCount}`,
    ``,
    `Files:`,
    `  ${result.files.screenshot}`,
    `  ${result.files.visualTree}`,
    `  ${result.files.brand}`,
    `  ${result.files.metadata}`,
    `  ${result.files.blockInventory}`,
  ].join('\n');
}

/** Create the migrate_page tool bound to BrowserAPI and VirtualFS. */
export function createMigratePageTool(
  browser: BrowserAPI,
  fs: VirtualFS,
  gitOps?: GitOps,
): ToolDefinition {
  const git = gitOps ?? createDefaultGitOps(fs);

  return {
    name: 'migrate_page',
    description:
      'Extract page data for EDS migration. Clones the target repo, ' +
      'navigates to the URL, captures a full-page screenshot, extracts ' +
      'the visual tree, brand data, metadata, and inventories existing ' +
      'blocks. Returns file paths for all extraction artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL of the page to migrate.',
        },
        repo: {
          type: 'string',
          description:
            'GitHub repo in owner/repo format (e.g. "adobe/eds-site").',
        },
      },
      required: ['url', 'repo'],
    },
    async execute(
      input: Record<string, unknown>,
    ): Promise<ToolResult> {
      const url = input['url'] as string | undefined;
      const repo = input['repo'] as string | undefined;

      if (!url) {
        return {
          content: 'Missing required parameter: url',
          isError: true,
        };
      }

      if (!repo || !repo.includes('/')) {
        return {
          content:
            'Missing or invalid repo. Must be in owner/repo format.',
          isError: true,
        };
      }

      const projectPath = deriveProjectPath(repo);
      const branch = deriveBranchName(url);

      try {
        const exists = await fs.exists(projectPath);
        if (!exists) {
          log.info('Cloning repo', { repo, projectPath });
          await git.clone(repo, projectPath);
        }

        log.info('Creating branch', { branch });
        await git.checkoutNewBranch(projectPath, branch);

        log.info('Running extraction', { url });
        const result = await runMigrationExtraction(
          browser,
          fs,
          url,
          repo,
          projectPath,
          branch,
        );

        return { content: formatResult(result) };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        log.error('Migration failed', { url, repo, error: message });
        return {
          content: `Migration failed: ${message}`,
          isError: true,
        };
      }
    },
  };
}
