/**
 * DA (Document Authoring) commands implementation for the virtual shell.
 *
 * Provides a CLI-like interface for Adobe Document Authoring operations:
 * content CRUD, preview, publish, and media upload.
 * Follows the same pattern as git-commands.ts.
 */

import { VirtualFS } from '../fs/index.js';
import { daFetch } from './da-http.js';

export interface DACommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DACommandsOptions {
  fs: VirtualFS;
}

interface DAConfig {
  org?: string;
  repo?: string;
  ref?: string;
  clientId?: string;
  clientSecret?: string;
  serviceToken?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const CONFIG_PATH = '/shared/.da-config.json';
const DA_ADMIN_BASE = 'https://admin.da.live';
const AEM_ADMIN_BASE = 'https://admin.hlx.page';
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';

/**
 * DA commands handler that provides CLI-like DA functionality.
 */
export class DACommands {
  private fs: VirtualFS;
  private config: DAConfig | null = null;
  private configLoaded = false;
  private cachedToken: CachedToken | null = null;

  constructor(options: DACommandsOptions) {
    this.fs = options.fs;
  }

  /**
   * Execute a da command.
   * @param args Command arguments (e.g., ['config', 'org', 'myorg'], ['list', '/tavex'])
   * @param cwd Current working directory
   */
  async execute(args: string[], cwd: string): Promise<DACommandResult> {
    if (args.length === 0) {
      return this.help();
    }

    const [command, ...rest] = args;

    try {
      await this.ensureConfigLoaded();
      switch (command) {
        case 'config':
          return await this.configCmd(rest);
        case 'list':
        case 'ls':
          return await this.list(rest);
        case 'get':
          return await this.get(rest);
        case 'put':
          return await this.put(rest, cwd);
        case 'preview':
          return await this.preview(rest);
        case 'publish':
          return await this.publish(rest);
        case 'upload':
          return await this.upload(rest, cwd);
        case 'help':
        case '--help':
        case '-h':
          return this.help();
        default:
          return {
            stdout: '',
            stderr: `da: '${command}' is not a da command. See 'da help'.\n`,
            exitCode: 1,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: `error: ${message}\n`,
        exitCode: 1,
      };
    }
  }

  // ── Config ──────────────────────────────────────────────────────

  private async ensureConfigLoaded(): Promise<void> {
    // Always re-read if config is missing or incomplete (credentials may have been
    // written by another scoop/cone after this instance was created).
    if (this.configLoaded && this.config?.org && this.config?.serviceToken) return;
    this.configLoaded = true;
    try {
      const content = await this.fs.readTextFile(CONFIG_PATH);
      this.config = JSON.parse(content);
    } catch {
      this.config = null;
    }
  }

  private async saveConfig(): Promise<void> {
    if (!this.config) this.config = {};
    await this.fs.writeFile(CONFIG_PATH, JSON.stringify(this.config, null, 2));
  }

  private requireConfig(): DAConfig {
    if (!this.config || !this.config.org || !this.config.repo) {
      throw new Error('DA not configured. Run: da config org <value> && da config repo <value>');
    }
    return this.config;
  }

  private async configCmd(args: string[]): Promise<DACommandResult> {
    if (args.length === 0) {
      // Show current config
      if (!this.config) {
        return { stdout: 'No DA configuration found.\nRun: da config org <value>\n', stderr: '', exitCode: 0 };
      }
      const lines: string[] = [];
      for (const [key, value] of Object.entries(this.config)) {
        if (key === 'clientSecret' || key === 'serviceToken') {
          lines.push(`${key} = ${value ? '****' : '(not set)'}`);
        } else {
          lines.push(`${key} = ${value || '(not set)'}`);
        }
      }
      return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
    }

    if (args.length === 1) {
      // Get a single key
      const key = this.normalizeConfigKey(args[0]);
      const value = this.config?.[key as keyof DAConfig];
      if (value) {
        return { stdout: `${value}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `da config: key '${args[0]}' not set\n`, exitCode: 1 };
    }

    // Set a key
    const key = this.normalizeConfigKey(args[0]);
    const value = args.slice(1).join(' ');
    if (!this.config) this.config = {};
    (this.config as Record<string, string>)[key] = value;
    await this.saveConfig();
    return { stdout: `Set ${key} = ${key === 'clientSecret' || key === 'serviceToken' ? '****' : value}\n`, stderr: '', exitCode: 0 };
  }

  private normalizeConfigKey(raw: string): string {
    // Accept kebab-case, snake_case, or camelCase
    const map: Record<string, string> = {
      'org': 'org',
      'repo': 'repo',
      'ref': 'ref',
      'client-id': 'clientId',
      'client_id': 'clientId',
      'clientid': 'clientId',
      'clientId': 'clientId',
      'client-secret': 'clientSecret',
      'client_secret': 'clientSecret',
      'clientsecret': 'clientSecret',
      'clientSecret': 'clientSecret',
      'service-token': 'serviceToken',
      'service_token': 'serviceToken',
      'servicetoken': 'serviceToken',
      'serviceToken': 'serviceToken',
    };
    return map[raw] ?? raw;
  }

  // ── IMS Token Exchange ──────────────────────────────────────────

  private async getToken(): Promise<string> {
    const config = this.requireConfig();

    if (!config.clientId || !config.clientSecret || !config.serviceToken) {
      throw new Error('DA credentials not configured. Run: da config client-id <value>, da config client-secret <value>, da config service-token <value>');
    }

    // Return cached token if still valid (5 min early expiry)
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 300000) {
      return this.cachedToken.token;
    }

    const params = 'grant_type=authorization_code' +
      '&client_id=' + encodeURIComponent(config.clientId) +
      '&client_secret=' + encodeURIComponent(config.clientSecret) +
      '&code=' + encodeURIComponent(config.serviceToken);

    const resp = await daFetch(IMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`IMS token exchange failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    this.cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 82800) * 1000,
    };
    return this.cachedToken.token;
  }

  // ── DA Content Operations ───────────────────────────────────────

  private daSourceUrl(pagePath: string): string {
    const config = this.requireConfig();
    const path = this.normalizeDaPath(pagePath);
    return `${DA_ADMIN_BASE}/source/${config.org}/${config.repo}/${path}`;
  }

  private normalizeDaPath(pagePath: string): string {
    let p = pagePath.replace(/^\//, '').replace(/\.html$/, '');
    if (p.endsWith('/')) p += 'index';
    return p + '.html';
  }

  private async list(args: string[]): Promise<DACommandResult> {
    const config = this.requireConfig();
    const dirPath = (args[0] || '').replace(/^\//, '').replace(/\/$/, '');
    const token = await this.getToken();

    const url = `${DA_ADMIN_BASE}/list/${config.org}/${config.repo}/${dirPath}`;
    const resp = await daFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      throw new Error(`DA list failed: ${resp.status}`);
    }

    const entries = await resp.json();
    if (!Array.isArray(entries) || entries.length === 0) {
      return { stdout: '(empty)\n', stderr: '', exitCode: 0 };
    }

    const lines = entries.map((e: { name?: string; ext?: string; path?: string }) => {
      const type = e.ext ? e.ext : 'dir';
      return `${type.padEnd(6)} ${e.path || e.name || ''}`;
    });
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  private async get(args: string[]): Promise<DACommandResult> {
    if (args.length === 0) {
      return { stdout: '', stderr: 'Usage: da get <path> [--output <vfs-path>]\n', exitCode: 1 };
    }

    const pagePath = args[0];
    let outputPath: string | null = null;
    const outIdx = args.indexOf('--output');
    if (outIdx >= 0 && args[outIdx + 1]) {
      outputPath = args[outIdx + 1];
    } else if (args.indexOf('-o') >= 0) {
      const oIdx = args.indexOf('-o');
      if (args[oIdx + 1]) outputPath = args[oIdx + 1];
    }

    const token = await this.getToken();
    const url = this.daSourceUrl(pagePath);

    const resp = await daFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      throw new Error(`DA get failed for '${pagePath}': ${resp.status}`);
    }

    const html = await resp.text();

    if (outputPath) {
      await this.fs.writeFile(outputPath, html);
      return { stdout: `Saved to ${outputPath} (${html.length} bytes)\n`, stderr: '', exitCode: 0 };
    }

    return { stdout: html, stderr: '', exitCode: 0 };
  }

  private async put(args: string[], cwd: string): Promise<DACommandResult> {
    if (args.length === 0) {
      return { stdout: '', stderr: 'Usage: da put <da-path> [<vfs-file>] (reads stdin if no file)\n', exitCode: 1 };
    }

    const daPath = args[0];
    let html: string;

    if (args.length >= 2) {
      // Read from VFS file
      const filePath = args[1].startsWith('/') ? args[1] : `${cwd}/${args[1]}`.replace(/\/+/g, '/');
      html = await this.fs.readTextFile(filePath);
    } else {
      return { stdout: '', stderr: 'Usage: da put <da-path> <vfs-file>\n', exitCode: 1 };
    }

    const token = await this.getToken();
    const normalizedPath = this.normalizeDaPath(daPath);
    const config = this.requireConfig();

    const formData = new FormData();
    formData.append('data', new Blob([html], { type: 'text/html' }), 'index.html');

    const url = `${DA_ADMIN_BASE}/source/${config.org}/${config.repo}/${normalizedPath}`;
    const resp = await daFetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!resp.ok) {
      throw new Error(`DA put failed for '${daPath}': ${resp.status}`);
    }

    return { stdout: `Saved: ${normalizedPath}\n`, stderr: '', exitCode: 0 };
  }

  private async preview(args: string[]): Promise<DACommandResult> {
    if (args.length === 0) {
      return { stdout: '', stderr: 'Usage: da preview <path>\n', exitCode: 1 };
    }

    const config = this.requireConfig();
    const ref = config.ref || 'main';
    const path = args[0].replace(/^\//, '').replace(/\.html$/, '');
    const token = await this.getToken();

    const url = `${AEM_ADMIN_BASE}/preview/${config.org}/${config.repo}/${ref}/${path}`;
    const resp = await daFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      throw new Error(`Preview failed for '${args[0]}': ${resp.status}`);
    }

    const data = await resp.json();
    const previewUrl = data?.preview?.url || `https://${ref}--${config.repo}--${config.org}.aem.page/${path}`;
    return { stdout: `Preview: ${previewUrl}\n`, stderr: '', exitCode: 0 };
  }

  private async publish(args: string[]): Promise<DACommandResult> {
    if (args.length === 0) {
      return { stdout: '', stderr: 'Usage: da publish <path>\n', exitCode: 1 };
    }

    const config = this.requireConfig();
    const ref = config.ref || 'main';
    const path = args[0].replace(/^\//, '').replace(/\.html$/, '');
    const token = await this.getToken();

    const url = `${AEM_ADMIN_BASE}/live/${config.org}/${config.repo}/${ref}/${path}`;
    const resp = await daFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      throw new Error(`Publish failed for '${args[0]}': ${resp.status}`);
    }

    const data = await resp.json();
    const liveUrl = data?.live?.url || `https://${ref}--${config.repo}--${config.org}.aem.live/${path}`;
    return { stdout: `Published: ${liveUrl}\n`, stderr: '', exitCode: 0 };
  }

  private async upload(args: string[], cwd: string): Promise<DACommandResult> {
    if (args.length < 2) {
      return { stdout: '', stderr: 'Usage: da upload <vfs-path> <da-path>\n', exitCode: 1 };
    }

    const vfsPath = args[0].startsWith('/') ? args[0] : `${cwd}/${args[0]}`.replace(/\/+/g, '/');
    const daPath = args[1].replace(/^\//, '');
    const config = this.requireConfig();
    const token = await this.getToken();

    const contentRaw = await this.fs.readFile(vfsPath);
    const fileName = vfsPath.split('/').pop() || 'file';

    // Guess MIME type from extension
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const mimeMap: Record<string, string> = {
      'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
      'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp',
      'pdf': 'application/pdf', 'mp4': 'video/mp4',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';

    const formData = new FormData();
    formData.append('data', new Blob([contentRaw as BlobPart], { type: mime }), fileName);

    const url = `${DA_ADMIN_BASE}/source/${config.org}/${config.repo}/${daPath}`;
    const resp = await daFetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!resp.ok) {
      throw new Error(`Upload failed for '${vfsPath}': ${resp.status}`);
    }

    return { stdout: `Uploaded: ${vfsPath} → ${daPath}\n`, stderr: '', exitCode: 0 };
  }

  // ── Help ────────────────────────────────────────────────────────

  private help(): DACommandResult {
    return {
      stdout: `da — Document Authoring CLI

Usage: da <command> [options]

Commands:
  config [key] [value]   Get/set DA configuration
  list [path]            List pages in a DA directory
  get <path>             Get page HTML from DA
  put <path> <file>      Write HTML to DA (from VFS file)
  preview <path>         Preview a page (triggers AEM preview)
  publish <path>         Publish a page (triggers AEM publish)
  upload <vfs> <da>      Upload a VFS file to DA (media)
  help                   Show this help

Configuration keys:
  org                    GitHub org / DA org
  repo                   Repository name
  ref                    Branch (default: main)
  client-id              IMS client ID
  client-secret          IMS client secret
  service-token          IMS service token (JWT)

Examples:
  da config org paolomoz
  da config repo az-sitebuilder
  da config client-id my-client
  da config client-secret "my-secret"
  da config service-token "eyJ..."
  da list /tavex
  da get /tavex/dosing
  da get /tavex/dosing --output /workspace/page.html
  da put /tavex/dosing /workspace/page.html
  da preview /tavex/dosing
  da publish /tavex/dosing
  da upload /workspace/image.png tavex/media_1234.png
`,
      stderr: '',
      exitCode: 0,
    };
  }
}
