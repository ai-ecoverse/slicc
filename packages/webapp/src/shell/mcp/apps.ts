import { slugify } from '@slicc/shared-ts';
import { escapeHtml } from '@slicc/webcomponents/internal/html';
import { createLogger } from '../../base/logger.js';
import { GLOBAL_FS_DB_NAME } from '../../fs/global-db.js';
import { FsError } from '../../fs/types.js';
import type { McpAppDef } from './types.js';

const log = createLogger('mcp-apps');

export const MCP_SPRINKLES_DIR = '/workspace/.mcp/sprinkles';

interface MinimalFs {
  readFile: (path: string, options?: { encoding?: 'utf-8' | 'binary' }) => Promise<unknown>;
  writeFile: (path: string, content: string | Uint8Array) => Promise<void>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
}

async function openFs(injected?: MinimalFs | null): Promise<MinimalFs> {
  if (injected) return injected;
  const { VirtualFS } = await import('../../fs/index.js');
  return (await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME })) as unknown as MinimalFs;
}

export function slugifyAppName(name: string): string {
  return slugify(name, { maxLen: 64, fallback: 'app' });
}

export function renderAppSprinkle(serverName: string, app: McpAppDef): string {
  const title = escapeHtml(app.title ?? app.name);
  const description = app.description ? escapeHtml(app.description) : '';
  const templateUri = escapeHtml(app.templateUri ?? 'about:blank');
  const serverJson = JSON.stringify(serverName);
  const appJson = JSON.stringify(app.name);
  return `<div class="mcp-app" data-sprinkle-title="${title}" style="display:flex;flex-direction:column;height:100%;min-height:0;">
  <header class="mcp-app__header" style="padding:8px 12px;border-bottom:1px solid var(--s2-border-subtle,#3a3a3a);">
    <h2 style="font-size:14px;font-weight:600;margin:0;">${title}</h2>${
      description
        ? `\n    <p style="font-size:12px;margin:4px 0 0;color:var(--s2-content-secondary,#a0a0a0);">${description}</p>`
        : ''
    }
  </header>
  <iframe class="mcp-app__frame" src="${templateUri}" sandbox="allow-scripts" referrerpolicy="no-referrer" style="flex:1;border:0;min-height:0;width:100%;"></iframe>
  <script>
    (function() {
      var SERVER = ${serverJson};
      var APP = ${appJson};
      var frame = document.currentScript.previousElementSibling;
      window.addEventListener('message', function(e) {
        if (frame && e.source !== frame.contentWindow) return;
        var msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'mcp:lick') {
          slicc.lick({ action: 'mcp:lick', data: { server: SERVER, app: APP, event: msg.event, payload: msg.data } });
        } else if (msg.type === 'mcp:invoke') {
          slicc.lick({ action: 'mcp:invoke', data: { server: SERVER, app: APP, tool: msg.tool, args: msg.args, callId: msg.callId } });
        }
      });
      window.mcpInvoke = function(server, tool, args) {
        slicc.lick({ action: 'mcp:invoke', data: { server: server, app: APP, tool: tool, args: args || {} } });
      };
    })();
  </script>
</div>
`;
}

export async function materializeAppSprinkles(
  serverName: string,
  apps: McpAppDef[],
  injectedFs?: MinimalFs | null
): Promise<string[]> {
  const fs = await openFs(injectedFs);
  const dir = `${MCP_SPRINKLES_DIR}/${serverName}`;
  await removeAppSprinkles(serverName, injectedFs);
  const renderable = apps.filter(
    (a) => typeof a.templateUri === 'string' && a.templateUri.length > 0
  );
  if (renderable.length === 0) return [];
  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  const used = new Set<string>();
  for (const app of renderable) {
    const slug = slugifyAppName(app.name);
    let candidate = slug;
    let n = 2;
    while (used.has(candidate)) candidate = `${slug}-${n++}`;
    used.add(candidate);
    const path = `${dir}/${candidate}.shtml`;
    await fs.writeFile(path, renderAppSprinkle(serverName, app));
    written.push(path);
  }
  return written;
}

export async function removeAppSprinkles(
  serverName: string,
  injectedFs?: MinimalFs | null
): Promise<boolean> {
  const fs = await openFs(injectedFs);
  const dir = `${MCP_SPRINKLES_DIR}/${serverName}`;
  try {
    if (!(await fs.exists(dir))) return false;
    await fs.rm(dir, { recursive: true });
    return true;
  } catch (e) {
    if (e instanceof FsError && e.code === 'ENOENT') return false;
    log.debug('removeAppSprinkles failed', {
      dir,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
