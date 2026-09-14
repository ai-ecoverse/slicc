import type { SudoApproveRequest, SudoBackend, SudoDecision } from './types.js';

interface MessageBoxResult {
  response: number;
}

interface OffscreenPromptWindowOptions {
  show: boolean;
  width: number;
  height: number;
  webPreferences: { offscreen: boolean };
}

export interface ElectronBackendDeps {
  showMessageBox?: (options: {
    type: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    title: string;
    message: string;
    detail: string;
  }) => Promise<MessageBoxResult>;

  promptInput?: (message: string, defaultValue: string) => Promise<string | null>;
}

const BUTTONS = ['Deny', 'Allow Once', 'Always'];

export function createElectronBackend(deps: ElectronBackendDeps = {}): SudoBackend {
  const showMessageBox = deps.showMessageBox ?? defaultShowMessageBox;
  const promptInput = deps.promptInput ?? defaultPromptInput;

  return {
    name: 'electron',
    async prompt(req: SudoApproveRequest): Promise<SudoDecision> {
      const suggested = req.suggestedPattern?.trim() || req.detail.trim();
      let response: number;
      try {
        const result = await showMessageBox({
          type: 'warning',
          buttons: BUTTONS,
          defaultId: 1,
          cancelId: 0,
          title: 'SLICC sudo',

          message: req.requester
            ? `Approve ${req.kind} from ${req.requester}`
            : `Approve ${req.kind}`,
          detail: req.detail,
        });
        response = result.response;
      } catch {
        return { decision: 'deny' };
      }

      if (response === 1) return { decision: 'allow' };
      if (response !== 2) return { decision: 'deny' };

      try {
        const edited = await promptInput('Edit the "Always" allow pattern:', suggested);
        const pattern = edited && edited.trim().length > 0 ? edited.trim() : suggested;
        return { decision: 'always', pattern };
      } catch {
        return { decision: 'always', pattern: suggested };
      }
    },
  };
}

async function defaultShowMessageBox(options: {
  type: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  title: string;
  message: string;
  detail: string;
}): Promise<MessageBoxResult> {
  const electron = (await import('electron')) as unknown as {
    dialog: { showMessageBox(opts: typeof options): Promise<MessageBoxResult> };
  };
  return electron.dialog.showMessageBox(options);
}

async function defaultPromptInput(message: string, defaultValue: string): Promise<string | null> {
  const electron = (await import('electron')) as unknown as {
    BrowserWindow: new (
      opts: OffscreenPromptWindowOptions
    ) => {
      loadURL(url: string): Promise<void>;
      webContents: { executeJavaScript(code: string): Promise<unknown> };
      destroy(): void;
    };
  };
  const win = new electron.BrowserWindow({
    show: false,
    width: 480,
    height: 160,
    webPreferences: { offscreen: true },
  });
  try {
    await win.loadURL('data:text/html,<title>SLICC sudo</title>');
    const result = await win.webContents.executeJavaScript(
      `window.prompt(${JSON.stringify(message)}, ${JSON.stringify(defaultValue)})`
    );
    return typeof result === 'string' ? result : null;
  } finally {
    win.destroy();
  }
}
