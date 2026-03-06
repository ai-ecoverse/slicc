/**
 * Browser tool — Control other browser tabs via CDP.
 *
 * Provides a single "browser" tool with sub-actions:
 * - list_tabs: List open browser tabs
 * - navigate: Navigate a tab to a URL
 * - screenshot: Capture a screenshot of a tab
 * - evaluate: Run JavaScript in a tab
 * - click: Click an element by CSS selector
 * - type: Type text into a focused element
 */

import type { BrowserAPI } from '../cdp/index.js';
import { HarRecorder } from '../cdp/index.js';
import type { AccessibilityNode } from '../cdp/types.js';
import type { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool:browser');

/** Decode base64 string to Uint8Array. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Snapshot state for a tab - tracks element refs and page info.
 * Compatible with playwright-cli snapshot format.
 */
interface TabSnapshot {
  url: string;
  title: string;
  /** Map from ref (e.g. "e1") to CSS selector */
  refToSelector: Map<string, string>;
  /** The YAML-like snapshot content */
  content: string;
  /** Timestamp when snapshot was taken */
  timestamp: number;
}

/** Create the browser tool bound to a BrowserAPI instance. */
export function createBrowserTool(browser: BrowserAPI, fs?: VirtualFS | null): ToolDefinition {
  let runtimeTabId: string | null = null;
  let appTabId: string | null = null;
  /** Per-tab snapshot state, keyed by targetId */
  const tabSnapshots = new Map<string, TabSnapshot>();
  /** HAR recorder instance (created lazily when first recording starts) */
  let harRecorder: HarRecorder | null = null;

  /** Detect and cache the SLICC app's own tab ID so we can hide/protect it. */
  async function resolveAppTabId(): Promise<void> {
    if (appTabId) return;
    const pages = await browser.listPages();
    const appOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    // In extension mode, preview tabs share the same origin (chrome-extension://<id>/).
    // Exclude /preview/ URLs so they aren't misidentified as the app tab.
    const appTab = pages.find((p) => p.url.startsWith(appOrigin) && !p.url.includes('/preview/'));
    if (appTab) appTabId = appTab.targetId;
  }

  function isAppTab(targetId: string): boolean {
    return targetId === appTabId;
  }

  /** Resolve the user's active tab. Returns targetId or null. */
  async function getActiveTab(): Promise<string | null> {
    try {
      const pages = await browser.listPages();
      const active = pages.find((p) => p.active && !isAppTab(p.targetId));
      if (!active) {
        log.debug('No active user tab found', {
          totalPages: pages.length,
          activeTabs: pages.filter((p) => p.active).length,
          appTabId,
        });
      }
      return active?.targetId ?? null;
    } catch (err) {
      log.error('Failed to resolve active tab', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  return {
    name: 'browser',
    description:
      'Control browser tabs via Chrome DevTools Protocol. Specify an "action" and relevant parameters. ' +
      'The app\'s own tab is hidden and protected — you cannot accidentally navigate or modify it. ' +
      'If targetId is omitted, the user\'s currently active/focused tab is used automatically. ' +
      'Actions: list_tabs, new_tab (url — creates a new tab and navigates to the URL, returns targetId), ' +
      'new_recorded_tab (url, filter? — creates a tab with HAR recording enabled; recordings saved to /recordings/<id>/; ' +
      'filter is a JS function string (entry) => false|true|object to exclude or transform entries; ' +
      'NOTE: response bodies are captured by default which can be large — use filter to exclude them when not needed), ' +
      'stop_recording (recordingId — stops recording and saves final HAR snapshot), ' +
      'navigate (url, targetId?), ' +
      'snapshot (targetId? — captures page accessibility snapshot with element refs like e1, e2; MUST be called before screenshot), ' +
      'screenshot (targetId?, path?, fullPage?, selector? — requires snapshot first; if path is given, saves PNG to VFS), ' +
      'evaluate (expression, targetId?), click (ref or selector, targetId? — use refs like "e5" from snapshot), type (text, targetId?), ' +
      'evaluate_persistent (expression — runs JS in a persistent blank tab that preserves variables across calls, no targetId needed), ' +
      'serve (directory, entry?, edsProject? — serves VFS directory as a web app in a new browser tab via preview service worker; set edsProject:true for EDS sites so root-relative paths like /styles/ and /blocks/ resolve correctly), ' +
      'show_image (path — displays an image from VFS inline in the chat; use this when the user asks to see an image file).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_tabs', 'new_tab', 'new_recorded_tab', 'stop_recording', 'navigate', 'snapshot', 'screenshot', 'evaluate', 'click', 'type', 'evaluate_persistent', 'serve', 'show_image'],
          description: 'The browser action to perform.',
        },
        targetId: {
          type: 'string',
          description: 'The target/tab ID to operate on. Required for all actions except list_tabs.',
        },
        url: {
          type: 'string',
          description: 'URL to navigate to (for "navigate" action).',
        },
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate (for "evaluate" action).',
        },
        selector: {
          type: 'string',
          description: 'CSS selector — for "click" action: element to click. For "screenshot" action: element to capture (screenshots just that element).',
        },
        ref: {
          type: 'string',
          description: 'Element reference from snapshot (e.g. "e5") — for "click" action. Alternative to selector.',
        },
        text: {
          type: 'string',
          description: 'Text to type (for "type" action).',
        },
        path: {
          type: 'string',
          description: 'VFS path to save screenshot PNG (for "screenshot" action). When provided, saves directly to the virtual filesystem instead of returning base64 data.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page, not just the visible viewport (for "screenshot" action). Default: false.',
        },
        directory: {
          type: 'string',
          description: 'VFS directory path to serve as a web app (for "serve" action). E.g. "/workspace/my-app".',
        },
        entry: {
          type: 'string',
          description: 'Entry file within the directory (for "serve" action). Defaults to "index.html".',
        },
        edsProject: {
          type: 'boolean',
          description: 'Set to true for EDS projects (for "serve" action). Enables root-relative path resolution (/styles/, /scripts/, /blocks/) via the preview SW, emulating aem up.',
        },
        filter: {
          type: 'string',
          description: 'JS filter function for HAR recording (for "new_recorded_tab" action). ' +
            'Called on each HAR entry: (entry) => false (skip), true (keep), or HarEntry (replace). ' +
            'If returning an object, it MUST be a complete valid HAR entry for compatibility. ' +
            'Example: "(e) => !e.request.url.includes(\'.png\')" to exclude images. ' +
            'Example: "(e) => ({ ...e, response: { ...e.response, content: { size: 0, mimeType: e.response.content.mimeType } } })" to strip bodies.',
        },
        recordingId: {
          type: 'string',
          description: 'Recording ID returned by new_recorded_tab (for "stop_recording" action).',
        },
      },
      required: ['action'],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = input['action'] as string;
      const targetId = input['targetId'] as string | undefined;
      log.debug('Action', { action, targetId, url: input['url'], selector: input['selector'] });

      // Protect the SLICC app tab from being modified
      await resolveAppTabId();
      if (targetId && isAppTab(targetId)) {
        return { content: 'Cannot operate on the SLICC app tab — that would kill the application. Use a different tab or create a new one.', isError: true };
      }

      try {
        switch (action) {
          case 'list_tabs': {
            await resolveAppTabId();
            const pages = (await browser.listPages()).filter((p) => !isAppTab(p.targetId));
            if (pages.length === 0) {
              return { content: 'No browser tabs found. Use the "navigate" action with a new tab to open a page.' };
            }
            const lines = pages.map(
              (p) => `${p.active ? '→ ' : '- '}${p.targetId}: ${p.title} (${p.url})`,
            );
            return { content: lines.join('\n') };
          }

          case 'new_tab': {
            const url = input['url'] as string || 'about:blank';
            await resolveAppTabId();
            const newTargetId = await browser.createPage(url);
            return { content: `Created new tab (targetId: ${newTargetId}) at ${url}` };
          }

          case 'new_recorded_tab': {
            const url = input['url'] as string || 'about:blank';
            const filterCode = input['filter'] as string | undefined;

            if (!fs) {
              return { content: 'new_recorded_tab requires VFS to save recordings', isError: true };
            }

            await resolveAppTabId();

            // Create the tab
            const newTargetId = await browser.createPage(url);

            // Create a dedicated CDP session for recording (separate from BrowserAPI's shared session)
            // This avoids invalidation when BrowserAPI attaches to other tabs
            const transport = browser.getTransport();
            const attachResult = await transport.send('Target.attachToTarget', {
              targetId: newTargetId,
              flatten: true,
            });
            const sessionId = attachResult['sessionId'] as string;

            // Create HAR recorder if needed
            if (!harRecorder) {
              harRecorder = new HarRecorder(transport, fs);
            }

            // Start recording
            let recordingId: string;
            try {
              recordingId = await harRecorder.startRecording(newTargetId, sessionId, filterCode);
            } catch (err) {
              return { content: `Failed to start recording: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }

            return {
              content: `Created recorded tab (targetId: ${newTargetId}, recordingId: ${recordingId}) at ${url}\n` +
                `HAR recordings will be saved to /recordings/${recordingId}/\n` +
                `Snapshots are saved automatically on navigation and when recording stops.`
            };
          }

          case 'stop_recording': {
            const recordingId = input['recordingId'] as string;

            if (!recordingId) {
              return { content: 'stop_recording requires recordingId', isError: true };
            }

            if (!harRecorder) {
              return { content: `Recording not found: ${recordingId}`, isError: true };
            }

            try {
              const recordingsPath = await harRecorder.stopRecording(recordingId);
              return { content: `Recording stopped. HAR files saved to ${recordingsPath}` };
            } catch (err) {
              return { content: `Failed to stop recording: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
          }

          case 'navigate': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            const url = input['url'] as string;
            if (!targetId || !url) {
              return { content: 'navigate requires url (and targetId or an active tab)', isError: true };
            }
            await browser.attachToPage(targetId);
            await browser.navigate(url);
            // Invalidate snapshot after navigation
            tabSnapshots.delete(targetId);
            return { content: `Navigated to ${url}` };
          }

          case 'snapshot': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            if (!targetId) {
              return { content: 'snapshot requires targetId or an active tab', isError: true };
            }
            await browser.attachToPage(targetId);

            // Get page info
            const pageInfo = await browser.evaluate(`JSON.stringify({ url: location.href, title: document.title })`);
            const { url, title } = JSON.parse(pageInfo as string);

            // Get accessibility tree and convert to playwright-cli compatible format
            const tree = await browser.getAccessibilityTree();
            const refToSelector = new Map<string, string>();
            let refCounter = 0;

            // Escape string for YAML output (quotes and newlines)
            function escapeYaml(str: string): string {
              return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
            }

            // Escape string for CSS attribute selector
            function escapeCssAttr(str: string): string {
              return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            }

            // Convert accessibility tree to YAML-like snapshot format with refs
            function renderNode(node: AccessibilityNode, indent: string = ''): string[] {
              const lines: string[] = [];
              const role = (node.role || 'unknown').toLowerCase();
              const name = node.name || '';
              
              // Skip certain roles that don't need refs
              const skipRoles = ['none', 'presentation', 'generic', 'rootwebarea'];
              const needsRef = !skipRoles.includes(role) && (name || role === 'textbox' || role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio');
              
              let ref = '';
              if (needsRef) {
                ref = `e${++refCounter}`;
                // Generate valid CSS selectors (no Playwright-specific syntax like :has-text)
                const escapedName = escapeCssAttr(name);
                let selector = '';
                if (role === 'button' && name) {
                  selector = `button[aria-label="${escapedName}"], button[title="${escapedName}"]`;
                } else if (role === 'link' && name) {
                  selector = `a[aria-label="${escapedName}"], a[title="${escapedName}"]`;
                } else if (role === 'textbox') {
                  if (name) {
                    // Match by accessible name via aria-label, placeholder, or title
                    selector = `input[aria-label="${escapedName}"], textarea[aria-label="${escapedName}"], [contenteditable][aria-label="${escapedName}"], input[placeholder="${escapedName}"], textarea[placeholder="${escapedName}"], input[title="${escapedName}"], textarea[title="${escapedName}"]`;
                  } else {
                    selector = `input, textarea, [contenteditable]`;
                  }
                } else if (role === 'checkbox') {
                  selector = `input[type="checkbox"]`;
                } else if (role === 'radio') {
                  selector = `input[type="radio"]`;
                } else if (name) {
                  selector = `[aria-label="${escapedName}"], [title="${escapedName}"]`;
                } else {
                  selector = `[role="${role}"]`;
                }
                refToSelector.set(ref, selector);
              }

              // Format: - role "name" [ref=eN]
              let line = `${indent}- ${role}`;
              if (name) line += ` "${escapeYaml(name)}"`;
              if (ref) line += ` [ref=${ref}]`;
              if (node.value) line += `: "${escapeYaml(node.value)}"`;
              lines.push(line);

              // Recurse into children
              if (node.children) {
                for (const child of node.children) {
                  lines.push(...renderNode(child, indent + '  '));
                }
              }
              return lines;
            }

            const snapshotLines = renderNode(tree);
            const snapshotContent = snapshotLines.join('\n');

            // Store snapshot state
            const snapshot: TabSnapshot = {
              url,
              title,
              refToSelector,
              content: snapshotContent,
              timestamp: Date.now(),
            };
            tabSnapshots.set(targetId, snapshot);

            // Format output like playwright-cli
            const output = [
              '### Page',
              `- Page URL: ${url}`,
              `- Page Title: ${title}`,
              '### Snapshot',
              '```yaml',
              snapshotContent,
              '```',
            ].join('\n');

            return { content: output };
          }

          case 'screenshot': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            if (!targetId) {
              return { content: 'screenshot requires targetId or an active tab', isError: true };
            }
            
            // Guard: require snapshot before screenshot
            const snapshot = tabSnapshots.get(targetId);
            if (!snapshot) {
              return { 
                content: 'Screenshot requires a snapshot first. Run the "snapshot" action to capture the page state before taking a screenshot.', 
                isError: true 
              };
            }
            
            await browser.attachToPage(targetId);
            const fullPage = input['fullPage'] as boolean | undefined;
            const screenshotSelector = input['selector'] as string | undefined;

            // If selector is given, resolve it to a clip rect via evaluate
            let clip: { x: number; y: number; width: number; height: number } | undefined;
            if (screenshotSelector) {
              const rectJson = await browser.evaluate(
                `(function() {
                  const el = document.querySelector(${JSON.stringify(screenshotSelector)});
                  if (!el) return null;
                  el.scrollIntoView({ block: 'center' });
                  const r = el.getBoundingClientRect();
                  return JSON.stringify({ x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height });
                })()`,
              );
              if (rectJson) {
                clip = JSON.parse(rectJson as string);
              } else {
                return { content: `Element not found: ${screenshotSelector}`, isError: true };
              }
            }

            const base64 = await browser.screenshot({
              fullPage: fullPage ?? false,
              ...(clip ? { clip } : {}),
            });
            const savePath = input['path'] as string | undefined;
            if (savePath && fs) {
              // Save PNG directly to VFS — avoids flooding the conversation with megabytes of base64
              const bytes = base64ToBytes(base64);
              await fs.writeFile(savePath, bytes);
              const sizeKB = Math.round(bytes.length / 1024);
              // Include a data URL thumbnail so the chat UI can display the image inline
              return { content: `Screenshot saved to ${savePath} (${sizeKB} KB PNG)\n<img:data:image/png;base64,${base64}>` };
            }
            // No path: return base64 as data URL for inline display
            return { content: `Screenshot captured (base64 PNG, ${base64.length} chars)\n<img:data:image/png;base64,${base64}>` };
          }

          case 'evaluate': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            const expression = input['expression'] as string;
            if (!targetId || !expression) {
              return { content: 'evaluate requires expression (and targetId or an active tab)', isError: true };
            }
            await browser.attachToPage(targetId);
            const result = await browser.evaluate(expression);
            return { content: JSON.stringify(result, null, 2) };
          }

          case 'click': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            let selector = input['selector'] as string;
            const ref = input['ref'] as string;
            
            // Validate targetId first
            if (!targetId) {
              return { content: 'click requires selector or ref (and targetId or an active tab)', isError: true };
            }
            
            // Support ref-based clicking (e.g. "e5" from snapshot)
            if (ref && !selector) {
              const snapshot = tabSnapshots.get(targetId);
              if (!snapshot) {
                return { content: `No snapshot available. Run "snapshot" action first to get element refs.`, isError: true };
              }
              const refSelector = snapshot.refToSelector.get(ref);
              if (!refSelector) {
                return { content: `Unknown ref "${ref}". Available refs: ${[...snapshot.refToSelector.keys()].slice(0, 10).join(', ')}...`, isError: true };
              }
              selector = refSelector;
            }
            
            if (!selector) {
              return { content: 'click requires selector or ref', isError: true };
            }
            await browser.attachToPage(targetId);
            await browser.click(selector);
            // Invalidate snapshot after click (page state may have changed)
            tabSnapshots.delete(targetId);
            return { content: `Clicked: ${ref ? `${ref} (${selector})` : selector}` };
          }

          case 'type': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            const text = input['text'] as string;
            if (!targetId || !text) {
              return { content: 'type requires text (and targetId or an active tab)', isError: true };
            }
            await browser.attachToPage(targetId);
            await browser.type(text);
            return { content: `Typed: ${text}` };
          }

          case 'evaluate_persistent': {
            const expression = input['expression'] as string;
            if (!expression) {
              return { content: 'evaluate_persistent requires expression', isError: true };
            }
            // Ensure we have a persistent runtime tab
            if (runtimeTabId) {
              try {
                await browser.attachToPage(runtimeTabId);
              } catch (err) {
                log.warn('Runtime tab lost, creating new one', {
                  runtimeTabId,
                  error: err instanceof Error ? err.message : String(err),
                });
                runtimeTabId = null;
              }
            }
            if (!runtimeTabId) {
              // listPages ensures CDP connection is established
              await browser.listPages();
              runtimeTabId = await browser.createPage();
              await browser.attachToPage(runtimeTabId);
            }
            const evalResult = await browser.evaluate(expression);
            return { content: JSON.stringify(evalResult, null, 2) };
          }

          case 'show_image': {
            const imagePath = input['path'] as string;
            if (!imagePath || !fs) {
              return { content: 'show_image requires path (VFS path to an image file)', isError: true };
            }
            try {
              const bytes = await fs.readFile(imagePath, { encoding: 'binary' });
              const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes as string);
              // Convert to base64
              let base64 = '';
              const chunk = 8192;
              for (let i = 0; i < data.length; i += chunk) {
                base64 += String.fromCharCode(...data.subarray(i, i + chunk));
              }
              base64 = btoa(base64);
              const ext = imagePath.split('.').pop()?.toLowerCase() ?? 'png';
              const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                : ext === 'svg' ? 'image/svg+xml'
                : ext === 'webp' ? 'image/webp'
                : ext === 'gif' ? 'image/gif'
                : 'image/png';
              const sizeKB = Math.round(data.length / 1024);
              return { content: `Showing ${imagePath} (${sizeKB} KB)\n<img:data:${mime};base64,${base64}>` };
            } catch (err) {
              return { content: `Failed to read image: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
          }

          case 'serve': {
            const directory = input['directory'] as string;
            const entry = (input['entry'] as string) || 'index.html';
            const edsProject = input['edsProject'] as boolean | undefined;

            if (!directory) return { content: 'serve requires a directory path', isError: true };

            // Reject path traversal in entry to prevent serving files outside the directory
            if (entry.includes('..') || entry.startsWith('/')) {
              return { content: `Invalid entry file: ${entry} (must be a relative path without "..")`, isError: true };
            }

            // Verify entry file exists in VFS
            const entryPath = directory.endsWith('/')
              ? directory + entry
              : directory + '/' + entry;

            if (fs) {
              try {
                await fs.stat(entryPath);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('ENOENT')) {
                  return { content: `Entry file not found: ${entryPath}`, isError: true };
                }
                return { content: `Failed to access entry file (${entryPath}): ${msg}`, isError: true };
              }
            }

            const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
            const normalizedDir = directory.startsWith('/') ? directory : '/' + directory;

            // EDS project mode: set project root on the SW so root-relative
            // paths (/styles/styles.css, /scripts/aem.js, /blocks/...)
            // resolve against the VFS project directory — emulates `aem up`.
            if (edsProject) {
              const projectRoot = normalizedDir.endsWith('/') ? normalizedDir.slice(0, -1) : normalizedDir;
              if (navigator.serviceWorker?.controller) {
                navigator.serviceWorker.controller.postMessage({
                  type: 'set-eds-project-root',
                  root: projectRoot,
                });
              }
              // In EDS mode, serve at root-relative path (not /preview/)
              // so that EDS root-relative references resolve correctly
              const edsUrl = isExtension
                ? chrome.runtime.getURL(`/${entry}`)
                : `http://localhost:3000/${entry}`;

              appTabId = null;
              let newTargetId: string;
              try {
                newTargetId = await browser.createPage(edsUrl);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { content: `Failed to create preview tab: ${msg}`, isError: true };
              }

              return {
                content: `EDS preview: serving ${directory} at root\nTab: ${newTargetId}\nURL: ${edsUrl}\nProject root set on preview SW — /styles/, /scripts/, /blocks/ resolve from VFS.\nUse snapshot, screenshot, evaluate, click etc. to interact with the page.`
              };
            }

            // Standard (non-EDS) preview: serve under /preview/ path
            const previewPath = `/preview${normalizedDir}${normalizedDir.endsWith('/') ? '' : '/'}${entry}`;

            const previewUrl = isExtension
              ? chrome.runtime.getURL(previewPath)
              : `http://localhost:3000${previewPath}`;

            // Reset app tab cache — the new preview tab shares the extension origin
            // and could be misidentified without a fresh lookup
            appTabId = null;

            // Open in a new tab
            let newTargetId: string;
            try {
              newTargetId = await browser.createPage(previewUrl);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return { content: `Failed to create preview tab: ${msg}`, isError: true };
            }

            return {
              content: `Serving ${directory} in tab ${newTargetId}\nURL: ${previewUrl}\nUse snapshot, screenshot, evaluate, click etc. to interact with the page.`
            };
          }

          default:
            return { content: `Unknown action: ${action}`, isError: true };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Error', { action, error: message });
        return { content: `Browser error: ${message}`, isError: true };
      }
    },
  };
}
