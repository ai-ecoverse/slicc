import { spawn, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { app, BrowserWindow, nativeTheme, session } from 'electron';

import {
  buildElectronOverlayAppUrl,
  buildElectronOverlayEntryUrl,
  buildElectronOverlayInjectionCall,
  buildElectronServerSpawnConfig,
  getElectronOverlayEntryDistPath,
  getElectronServeOrigin,
  parseElectronFloatFlags,
} from './electron-runtime.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const FLAGS = parseElectronFloatFlags(process.argv.slice(2));
const SERVE_ORIGIN = getElectronServeOrigin(FLAGS.servePort);
const OVERLAY_APP_URL = buildElectronOverlayAppUrl(SERVE_ORIGIN);
const ELECTRON_PARTITION = 'persist:slicc-electron-float';

app.commandLine.appendSwitch('remote-debugging-port', String(FLAGS.cdpPort));

let cliServerProcess: ChildProcess | null = null;
let quitting = false;

function pipeChildOutput(child: ChildProcess, label: string): void {
  child.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[${label}:out] ${data}`);
  });
  child.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[${label}:err] ${data}`);
  });
}

async function waitForServerReady(origin: string, retries = 60, delayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetch(origin);
      if (response.ok || response.status < 500) return;
    } catch {
      // Retry until the server starts listening.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
  }

  throw new Error(`Electron float server did not become ready at ${origin}`);
}

async function loadOverlayBundleSource(): Promise<string> {
  if (FLAGS.dev) {
    const response = await fetch(buildElectronOverlayEntryUrl(SERVE_ORIGIN));
    if (!response.ok) {
      throw new Error(
        `Failed to fetch electron overlay entry: ${response.status} ${response.statusText}`
      );
    }
    return await response.text();
  }

  return await readFile(getElectronOverlayEntryDistPath(PROJECT_ROOT), 'utf8');
}

async function injectOverlay(window: BrowserWindow): Promise<void> {
  const bundleSource = await loadOverlayBundleSource();
  // Detect the app's effective theme and set SLICC's theme to match
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const themeScript = `try{localStorage.setItem('slicc-theme',${JSON.stringify(theme)})}catch(e){}`;
  await window.webContents.executeJavaScript(`${themeScript}\n${bundleSource}`, true);
  await window.webContents.executeJavaScript(
    buildElectronOverlayInjectionCall({ appUrl: OVERLAY_APP_URL }),
    true
  );
}

function wireOverlayReinjection(window: BrowserWindow): void {
  const reinject = () => {
    void injectOverlay(window).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[electron-float] Overlay injection failed:', message);
    });
  };

  window.webContents.on('did-finish-load', reinject);
  window.webContents.on('did-navigate-in-page', reinject);
}

function configureElectronSession(): void {
  const electronSession = session.fromPartition(ELECTRON_PARTITION);
  electronSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders ?? {}) };
    delete responseHeaders['content-security-policy'];
    delete responseHeaders['Content-Security-Policy'];
    delete responseHeaders['content-security-policy-report-only'];
    delete responseHeaders['Content-Security-Policy-Report-Only'];
    callback({ responseHeaders });
  });
}

async function createFloatWindow(targetUrl: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    autoHideMenuBar: true,
    title: 'slicc electron float',
    webPreferences: {
      partition: ELECTRON_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: true,
    },
  });

  wireOverlayReinjection(window);

  window.webContents.setWindowOpenHandler(({ url }) => {
    void createFloatWindow(url);
    return { action: 'deny' };
  });

  try {
    await window.loadURL(targetUrl);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[electron-float] Failed to load ${targetUrl}: ${message}`);
    await window.loadURL('about:blank');
  }

  return window;
}

function startCliServer(): ChildProcess {
  const spawnConfig = buildElectronServerSpawnConfig(PROJECT_ROOT, {
    dev: FLAGS.dev,
    cdpPort: FLAGS.cdpPort,
    nodePath: process.env['npm_node_execpath'] ?? 'node',
  });

  const child = spawn(spawnConfig.command, spawnConfig.args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(FLAGS.servePort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pipeChildOutput(child, 'electron-server');

  child.on('exit', (code) => {
    if (quitting) return;
    console.error(`[electron-float] CLI server exited unexpectedly with code ${code}`);
    app.quit();
  });

  return child;
}

async function stopCliServer(): Promise<void> {
  if (!cliServerProcess) return;

  const child = cliServerProcess;
  cliServerProcess = null;

  await new Promise<void>((resolvePromise) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolvePromise();
    };

    child.once('exit', finish);
    child.kill('SIGTERM');

    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore final cleanup failures.
        }
      }
      finish();
    }, 3000);
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  configureElectronSession();

  cliServerProcess = startCliServer();
  await waitForServerReady(SERVE_ORIGIN);

  await createFloatWindow(FLAGS.targetUrl);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createFloatWindow(FLAGS.targetUrl);
    }
  });
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  void stopCliServer();
});

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[electron-float] Fatal error:', message);
  void stopCliServer().finally(() => {
    app.exit(1);
  });
});
