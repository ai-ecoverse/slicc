# Adding Features to SLICC

Agent-first, implementation-focused guide to extending SLICC. Each guide shows exact file paths, code interfaces, and wiring patterns.

---

## 1. Add a Supplemental Shell Command

**When**: To register a new bash command (e.g., `convert`, `webhook`, `crontask`).

**Files to modify**:
- Create: `src/shell/supplemental-commands/my-command.ts`
- Modify: `src/shell/supplemental-commands/index.ts`

**Implementation**:

Define a command using just-bash's `defineCommand`:

```typescript
// src/shell/supplemental-commands/my-command.ts
import { defineCommand } from 'just-bash';
import type { Command, CommandContext } from 'just-bash';

export function createMyCommand(): Command {
  return defineCommand('mycommand', async (args, ctx) => {
    // args: string[] of arguments
    // ctx: CommandContext { fs, env, cwd, getRegisteredCommands }

    try {
      // Your logic here
      const result = await ctx.fs.readFile('/some/path');

      return {
        stdout: result,
        stderr: '',
        exitCode: 0,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: `Error: ${err}`,
        exitCode: 1,
      };
    }
  });
}
```

Register in `createSupplementalCommands()`:

```typescript
// src/shell/supplemental-commands/index.ts
import { createMyCommand } from './my-command.js';

export function createSupplementalCommands(options: SupplementalCommandsConfig = {}): Command[] {
  return [
    // ... existing commands ...
    createMyCommand(),
  ];
}
```

**Type signature** (`just-bash`):

```typescript
type Command = {
  name: string;
  execute: (args: string[], ctx: CommandContext) => Promise<ShellResult>;
};

type CommandContext = {
  fs: IFileSystem;
  env: Map<string, string>;
  cwd: string;
  getRegisteredCommands?: () => string[];
};

type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};
```

**Test pattern**:

```typescript
// src/shell/supplemental-commands/my-command.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createMyCommand } from './my-command.js';
import { FakeVirtualFS } from '../../fs/fake-virtual-fs.js';

describe('my-command', () => {
  let fs: FakeVirtualFS;

  beforeEach(() => {
    fs = new FakeVirtualFS();
  });

  it('should execute correctly', async () => {
    const cmd = createMyCommand();
    const result = await cmd.execute(['arg1'], {
      fs,
      env: new Map([['HOME', '/home/user']]),
      cwd: '/',
    });
    expect(result.exitCode).toBe(0);
  });
});
```

**Reference file**: `src/shell/supplemental-commands/which-command.ts`

---

## 2. Add a .jsh Script Command

**When**: To ship executable scripts as part of a skill (e.g., a custom build tool, data processor).

**Files to create**:
- Create: `src/defaults/workspace/skills/my-skill/my-script.jsh`

**Implementation**:

```javascript
// src/defaults/workspace/skills/my-skill/my-script.jsh
// The script has access to:
// - process: { argv, env, cwd(), exit(code), stdout.write(), stderr.write() }
// - console: { log, info, warn, error }
// - fs: { readFile, writeFile, readDir, mkdir, rm, stat, exists }

const args = process.argv.slice(2); // Skip 'node' and script path

if (args.length === 0) {
  console.error('Usage: my-script <input>');
  process.exit(1);
}

const inputFile = args[0];

(async () => {
  try {
    const content = await fs.readFile(inputFile);
    const processed = content.toUpperCase();

    const outputFile = inputFile.replace(/\.txt$/, '.out.txt');
    await fs.writeFile(outputFile, processed);

    console.log(`Processed: ${inputFile} → ${outputFile}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
```

**Globals API**:

| Global | Methods |
|--------|---------|
| `process` | `argv[]`, `env` (object), `cwd()`, `exit(code)`, `stdout.write()`, `stderr.write()` |
| `console` | `log()`, `info()`, `warn()`, `error()` |
| `fs` | `readFile(path)`, `readFileBinary(path)`, `writeFile(path, content)`, `writeFileBinary(path, bytes)`, `readDir(path)`, `mkdir(path)`, `rm(path)`, `stat(path)`, `exists(path)`, `fetchToFile(url, path)` |
| `require(id)` | ❌ Not supported (throws error) |
| `module`, `exports` | Available for ES module pattern |

**Discovery**:

The shell auto-discovers `*.jsh` files from `/workspace/skills/` (priority) and anywhere on the VFS. Call by basename:

```bash
my-script arg1 arg2
```

Execution modes:
- **CLI mode**: Uses `AsyncFunction` constructor, full Node.js-like globals
- **Extension mode**: Routes through sandbox iframe (CSP-compliant), via postMessage for VFS operations

**Test pattern**:

JSH scripts cannot be unit-tested in Node because they rely on extension mode detection. Test the logic separately:

```typescript
// src/shell/supplemental-commands/my-command.test.ts
import { describe, it, expect } from 'vitest';
import { executeJshFile } from '../jsh-executor.js';
import { FakeVirtualFS } from '../../fs/fake-virtual-fs.js';

describe('my-script.jsh', () => {
  it('should run the script', async () => {
    const fs = new FakeVirtualFS();
    await fs.writeFile('/test.jsh', 'console.log("hello");');

    const result = await executeJshFile('/test.jsh', [], {
      fs,
      env: new Map(),
      cwd: '/',
    });

    expect(result.stdout).toContain('hello');
    expect(result.exitCode).toBe(0);
  });
});
```

**Reference file**: `src/shell/jsh-executor.ts`, `src/shell/supplemental-commands/node-command.ts`

---

## 3. Add a Core Agent Tool

**When**: To add a tool available to the agent (e.g., a new `read_database` tool).

**Files to create/modify**:
- Create: `src/tools/my-tool.ts`
- Modify: `src/scoops/scoop-context.ts` (wiring)

**Implementation**:

```typescript
// src/tools/my-tool.ts
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool:my');

export function createMyTool(dependency: SomeDependency): ToolDefinition {
  return {
    name: 'my_tool',
    description: 'Does something useful. Parameters: x (required), y (optional).',
    inputSchema: {
      type: 'object',
      properties: {
        x: {
          type: 'string',
          description: 'The first parameter',
        },
        y: {
          type: 'number',
          description: 'Optional second parameter',
        },
      },
      required: ['x'],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const x = input['x'] as string;
      const y = input['y'] as number | undefined;

      log.debug('Execute', { x, y });

      try {
        // Your logic
        const result = await doSomething(x, y, dependency);

        return {
          content: `Result: ${result}`,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Error', { x, error: message });
        return {
          content: `Error: ${message}`,
          isError: true,
        };
      }
    },
  };
}
```

**Interface**:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown; // Allow additional schema fields
}

interface ToolResult {
  content: string;
  isError?: boolean;
}
```

**Wire into ScoopContext**:

```typescript
// src/scoops/scoop-context.ts — in the init() method
const legacyTools = [
  // ... existing tools ...
  createMyTool(dependency),
];
```

**Test pattern**:

```typescript
// src/tools/my-tool.test.ts
import { describe, it, expect } from 'vitest';
import { createMyTool } from './my-tool.js';

describe('my_tool', () => {
  it('should execute with valid input', async () => {
    const tool = createMyTool(mockDependency);
    const result = await tool.execute({ x: 'test' });
    expect(result.content).toContain('Result');
    expect(result.isError).toBeFalsy();
  });
});
```

**Reference file**: `src/tools/bash-tool.ts`, `src/tools/file-tools.ts`

---

## 4. Extend Browser Automation Shell Commands

**When**: To add or change browser automation behavior, tab workflows, or preview-serving commands.

**Files to modify**:
- Modify: `src/shell/supplemental-commands/playwright-command.ts`
- Modify: `src/shell/supplemental-commands/serve-command.ts`
- Modify: `src/shell/supplemental-commands/shared.ts` (shared preview/path helpers)
- Update guidance if needed: `src/defaults/workspace/skills/playwright-cli/SKILL.md`

**Implementation**:

- Keep browser automation shell-first through `playwright-cli` / `playwright` / `puppeteer`.
- Reuse shared preview helpers for VFS URLs instead of manually constructing `/preview/...` paths.
- Use `serve <dir>` for app directories (default `index.html`, optional `--entry`) and `open` for single files, URLs, downloads, or inline image viewing.
- Preserve the current tab + snapshot model in `playwright-command.ts` when adding stateful browser actions.

**Test pattern**:

- Add colocated tests next to the command you changed (for example `playwright-command.test.ts` or `serve-command.test.ts`).
- Put pure helper coverage in `shared.test.ts`.
- Prefer focused command-level assertions over large integration fixtures.

**Reference files**: `src/shell/supplemental-commands/playwright-command.ts`, `src/shell/supplemental-commands/serve-command.ts`, `src/shell/supplemental-commands/sprinkle-command.ts`

---

## 5. Add a NanoClaw Tool

**When**: To add a messaging or multi-scoop management tool.

**Files to modify**:
- Modify: `src/scoops/nanoclaw-tools.ts`

**Implementation**:

```typescript
// src/scoops/nanoclaw-tools.ts — in createNanoClawTools()
export function createNanoClawTools(config: NanoClawToolsConfig): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ... existing tools (send_message, feed_scoop, etc.) ...

  // Cone only: my_special_tool
  if (scoop.isCone && config.onMySpecialCallback) {
    tools.push({
      name: 'my_special_tool',
      description: 'Description of what this tool does.',
      inputSchema: {
        type: 'object',
        properties: {
          param1: {
            type: 'string',
            description: 'First parameter',
          },
        },
        required: ['param1'],
      },
      execute: async (input) => {
        const { param1 } = input as { param1: string };
        try {
          const result = await config.onMySpecialCallback(param1);
          return { content: result };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Failed: ${msg}`, isError: true };
        }
      },
    });
  }

  return tools;
}
```

**Interface**:

```typescript
interface NanoClawToolsConfig {
  scoop: RegisteredScoop;
  onSendMessage: (text: string, sender?: string) => void;
  getScoops: () => RegisteredScoop[];
  // Cone-only callbacks:
  onFeedScoop?: (scoopJid: string, prompt: string) => Promise<void>;
  onScoopScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;
  onDropScoop?: (scoopJid: string) => Promise<void>;
  onSetGlobalMemory?: (content: string) => Promise<void>;
  getGlobalMemory?: () => Promise<string>;
}

interface RegisteredScoop {
  jid: string; // Unique ID
  name: string;
  folder: string;
  isCone: boolean;
  assistantLabel: string;
}
```

**Cone vs Universal**:

- **Cone-only**: Guarded by `if (scoop.isCone && callback)` — e.g., `feed_scoop`, `scoop_scoop`, `drop_scoop`
- **Universal**: Available to all scoops — e.g., `send_message`

**Add callback to ScoopContextCallbacks**:

```typescript
// src/scoops/scoop-context.ts
export interface ScoopContextCallbacks {
  // ... existing callbacks ...
  onMySpecialCallback?: (param: string) => Promise<string>;
}
```

**Wire in Orchestrator**:

```typescript
// src/scoops/orchestrator.ts
const nanoClawConfig: NanoClawToolsConfig = {
  // ... existing config ...
  onMySpecialCallback: async (param) => {
    // Implementation
  },
};
```

**Test pattern**:

```typescript
// src/scoops/nanoclaw-tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createNanoClawTools } from './nanoclaw-tools.js';

describe('my_special_tool', () => {
  it('should execute correctly', async () => {
    const mockCallback = vi.fn().mockResolvedValue('result');
    const tools = createNanoClawTools({
      scoop: { isCone: true, folder: 'test' },
      onMySpecialCallback: mockCallback,
      // ... other config ...
    });

    const tool = tools.find(t => t.name === 'my_special_tool');
    expect(tool).toBeDefined();
    const result = await tool!.execute({ param1: 'test' });
    expect(result.content).toContain('result');
  });
});
```

**Reference file**: `src/scoops/nanoclaw-tools.ts`

---

## 6. Add a UI Panel

**When**: To add a new tab or section in the UI (e.g., a settings panel, network monitor).

**Files to create/modify**:
- Create: `src/ui/my-panel.ts`
- Modify: `src/ui/layout.ts`, `src/ui/main.ts`

**Implementation**:

```typescript
// src/ui/my-panel.ts
export class MyPanel {
  private container: HTMLElement;
  private contentEl!: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  private render(): void {
    this.container.className = 'my-panel';

    const header = document.createElement('div');
    header.className = 'my-panel__header';
    header.textContent = 'My Panel';
    this.container.appendChild(header);

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'my-panel__content';
    this.container.appendChild(this.contentEl);
  }

  setSelectedScoop(jid: string | null): void {
    // Called when scoop changes
    this.refresh();
  }

  async refresh(): Promise<void> {
    // Update panel content
    this.contentEl.textContent = 'Loading...';

    try {
      // Fetch data
      const data = await this.fetchData();
      this.contentEl.textContent = JSON.stringify(data);
    } catch (err) {
      this.contentEl.textContent = `Error: ${err}`;
    }
  }

  private async fetchData(): Promise<unknown> {
    // Your logic
    return {};
  }
}
```

**Wire into Layout** (Standalone mode):

```typescript
// src/ui/layout.ts
import { MyPanel } from './my-panel.js';

export interface LayoutPanels {
  chat: ChatPanel;
  terminal: TerminalPanel;
  fileBrowser: FileBrowserPanel;
  memory: MemoryPanel;
  myPanel: MyPanel; // Add new panel
  scoops: ScoopsPanel;
}

export class Layout {
  private myPanelContainer!: HTMLElement;

  constructor(root: HTMLElement, isExtension = false) {
    // ... existing code ...
  }

  private createSplitLayout(): void {
    // ... existing code ...

    // Create my-panel in bottom section
    this.myPanelContainer = document.createElement('div');
    this.panels.myPanel = new MyPanel(this.myPanelContainer);
  }

  setSelectedScoop(scoop: RegisteredScoop | null): void {
    // ... existing code ...
    this.panels.myPanel.setSelectedScoop(scoop?.jid ?? null);
  }
}
```

**Wire into Layout** (Extension/Tabbed mode):

```typescript
// src/ui/layout.ts — in createTabbedLayout()
const tabIds: TabId[] = ['chat', 'terminal', 'files', 'memory', 'myPanel'];

// Create tab button and container
const myPanelBtn = document.createElement('button');
myPanelBtn.className = 'layout__tab-btn';
myPanelBtn.textContent = 'My Panel';
tabsContainer.appendChild(myPanelBtn);

const myPanelContainer = document.createElement('div');
myPanelContainer.className = 'layout__tab-content';
this.tabContainers.set('myPanel', myPanelContainer);
this.panels.myPanel = new MyPanel(myPanelContainer);
```

**CSS**:

```css
/* src/ui/styles.css */
.my-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.my-panel__header {
  padding: 10px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  font-weight: bold;
}

.my-panel__content {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}
```

**Test pattern**:

Panel tests are DOM-heavy; test interactions and state manually in extension/standalone mode rather than in vitest:

```typescript
// src/ui/my-panel.test.ts — only test non-DOM logic
import { describe, it, expect, vi } from 'vitest';

describe('MyPanel', () => {
  it('should initialize', () => {
    const container = document.createElement('div');
    const panel = new MyPanel(container);
    expect(container.querySelector('.my-panel')).toBeDefined();
  });
});
```

**Reference file**: `src/ui/memory-panel.ts`, `src/ui/layout.ts`

---

## 7. Add a Skill

**When**: To ship reusable agent instructions as a markdown file.

**Files to create**:
- Create: `src/defaults/workspace/skills/my-skill/SKILL.md`
- Optional: `src/defaults/workspace/skills/my-skill/helper.jsh` (executable script)

**Implementation**:

```markdown
---
name: my-skill
description: Teaches the agent how to do X
---

# My Skill

You are an expert in [domain]. Your role is to [responsibility].

## Key Principles

1. Always [principle 1]
2. Consider [principle 2]

## Example

When the user asks for X, follow this approach:
- Step 1: [description]
- Step 2: [description]
- Step 3: [description]

Use the `bash` tool to run commands. Use `read_file` to inspect files.

## Output Format

Always provide:
- A brief summary
- Code blocks (when applicable)
- Relevant file paths
```

**How it works**:

Skills are auto-discovered from native `/workspace/skills/` plus any accessible `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` directories anywhere in the reachable VFS during scoop initialization. Headers are shown by default; full content is loaded on demand.

**With executable script**:

```bash
# src/defaults/workspace/skills/my-skill/SKILL.md
## Command: my-skill-cmd

Run `my-skill-cmd arg1` to process files:

```

```javascript
// src/defaults/workspace/skills/my-skill/my-skill-cmd.jsh
const args = process.argv.slice(2);
console.log(`Processing: ${args.join(', ')}`);
```

**Discovery**:

During `ScoopContext.init()`, SLICC starts from `/workspace/skills/` (cone) or `/scoops/{folder}/workspace/skills/` (scoop), then also considers any accessible `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` roots elsewhere in that runtime's reachable VFS. The agent's system prompt includes discovered skill headers and can request full content via `read_file`.

Only native `/workspace/skills/` entries are install-managed by SLICC. Compatibility-discovered `.agents` and `.claude` skills remain read-only unless you explicitly copy/package them into the native skills directory.

**Test pattern**:

Skills are narrative instructions; test by verifying they load correctly:

```typescript
// src/scoops/skills.test.ts
import { describe, it, expect } from 'vitest';
import { loadSkills } from './skills.js';
import { VirtualFS } from '../fs/index.js';

describe('loadSkills', () => {
  it('should load a skill with metadata', async () => {
    const fs = new VirtualFS();
    // Write a skill file
    await fs.writeFile(
      '/workspace/skills/test/SKILL.md',
      '---\nname: test-skill\ndescription: Test\n---\nContent'
    );

    const skills = await loadSkills(fs, '/workspace/skills');
    expect(skills[0].metadata.name).toBe('test-skill');
  });
});
```

**Reference file**: `src/scoops/skills.ts`, `src/defaults/workspace/skills/`

---

## 8. Add a Provider

Providers come from three sources:
- **Pi-ai auto-discovery**: `getProviders()` returns all pi-ai providers automatically — no files needed. Filtered by `providers.build.json` (`include: ["*"]` = all, `exclude: ["*"]` = none).
- **Built-in extensions**: `src/providers/built-in/*.ts` — only for providers needing custom `register()` functions (e.g., bedrock-camp). Also filtered by `providers.build.json`.
- **External**: `providers/*.ts` (project root, mostly gitignored) — always included, never filtered. For custom OAuth providers, corporate proxies, etc. Some providers (e.g., `adobe.ts`) are explicitly un-gitignored and tracked in version control.

Built-in and external modules export `config: ProviderConfig` and optionally `register(): void`.

### 8a. Add an API-Key Provider

**When**: To support a new LLM provider that uses an API key (e.g., Groq, Hugging Face).

**Most providers need no files at all.** Pi-ai auto-discovers its providers via `getProviders()`, and `provider-settings.ts` generates a fallback config (display name derived from ID, `requiresApiKey: true`, `requiresBaseUrl: false`). The provider appears in the Settings UI automatically.

**Only create a file in `src/providers/built-in/`** if the provider needs a custom `register()` function (e.g., custom stream functions). See `src/providers/built-in/bedrock-camp.ts` for an example.

**For external providers** (typically gitignored), create `providers/my-provider.ts`:

```typescript
// providers/my-provider.ts
import type { ProviderConfig } from '../src/providers/types.js';

export const config: ProviderConfig = {
  id: 'my-provider',
  name: 'My Provider',
  description: 'Models via My Provider API',
  requiresApiKey: true,
  apiKeyPlaceholder: 'your-api-key-here',
  apiKeyEnvVar: 'MY_PROVIDER_API_KEY',
  requiresBaseUrl: false,
};

// Optional: register custom stream functions with pi-ai
export function register(): void {
  // registerApiProvider({ api: 'my-provider' as Api, stream: ..., streamSimple: ... });
}
```

External providers in `providers/` are always included (never filtered by `providers.build.json`).

### 8b. Add an OAuth Provider (Corporate Proxy / SSO)

**When**: To support a provider that authenticates via OAuth (implicit grant or PKCE) — typically a corporate LLM proxy behind SSO.

**Files to create**:
- `providers/my-corp.ts` (external, gitignored)
- `providers/my-corp-config.json` (optional, for client ID / endpoints)

**Implementation**:

```typescript
// providers/my-corp.ts
import type { ProviderConfig, OAuthLauncher } from '../src/providers/types.js';
import { registerApiProvider, streamAnthropic } from '@mariozechner/pi-ai';
import type { Api, Model, Context } from '@mariozechner/pi-ai';
import { saveOAuthAccount, getAccounts } from '../src/ui/provider-settings.js';

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

// Load config from a gitignored JSON file
const configFiles = import.meta.glob('/providers/my-corp-config.json', {
  eager: true, import: 'default',
}) as Record<string, { clientId: string; proxyEndpoint: string; redirectUri?: string; extensionRedirectUri?: string }>;
const corpConfig = configFiles['/providers/my-corp-config.json'] ?? { clientId: '', proxyEndpoint: '' };

export const config: ProviderConfig = {
  id: 'my-corp',
  name: 'My Corp',
  description: 'Claude via corporate proxy — login with SSO',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,

  onOAuthLogin: async (launcher: OAuthLauncher, onSuccess: () => void) => {
    // Build the redirect URI based on runtime
    const redirectUri = isExtension
      ? (corpConfig.extensionRedirectUri ?? `https://${(chrome as any).runtime.id}.chromiumapp.org/`)
      : (corpConfig.redirectUri ?? `${window.location.origin}/auth/callback`);

    const params = new URLSearchParams({
      client_id: corpConfig.clientId,
      response_type: 'token',
      redirect_uri: redirectUri,
      scope: 'openid profile',
    });
    const authorizeUrl = `https://sso.mycorp.com/authorize?${params}`;

    // Launch the OAuth flow — launcher handles CLI popup vs extension chrome.identity
    const redirectUrl = await launcher(authorizeUrl);
    if (!redirectUrl) return; // User cancelled or timed out

    // Extract token from redirect URL (provider-specific: implicit grant has token in fragment)
    const fragment = new URLSearchParams(redirectUrl.slice(redirectUrl.indexOf('#') + 1));
    const accessToken = fragment.get('access_token');
    if (!accessToken) return;

    // Save the OAuth account — this makes the provider "logged in"
    saveOAuthAccount({
      providerId: 'my-corp',
      accessToken,
      tokenExpiresAt: Date.now() + parseInt(fragment.get('expires_in') ?? '86400', 10) * 1000,
    });
    onSuccess(); // Re-render the accounts list
  },

  onOAuthLogout: async () => {
    // Optionally revoke the token with your IdP
    saveOAuthAccount({ providerId: 'my-corp', accessToken: '' });
  },
};

// Register custom stream function that proxies through the corporate endpoint
export function register(): void {
  registerApiProvider({
    api: 'my-corp-anthropic' as Api,
    stream: (model: Model<Api>, context: Context, options: any = {}) => {
      const account = getAccounts().find(a => a.providerId === 'my-corp');
      const proxyModel = { ...model, baseUrl: corpConfig.proxyEndpoint, api: 'anthropic-messages' as Api };
      return streamAnthropic(proxyModel as any, context, { ...options, apiKey: account?.accessToken });
    },
  });
}
```

**How the OAuth flow works**:

1. User clicks "Login with My Corp" in the Settings dialog
2. `provider-settings.ts` calls `config.onOAuthLogin(launcher, onSuccess)`
3. The provider builds its authorize URL and calls `launcher(authorizeUrl)`
4. The generic `OAuthLauncher` (from `src/providers/oauth-service.ts`) handles transport:
   - **CLI**: Opens popup → IDP login → redirects to `http://localhost:5710/auth/callback` → callback page postMessages the redirect URL back → popup closes
   - **Extension**: Sends `oauth-request` to service worker → `chrome.identity.launchWebAuthFlow` → returns redirect URL with token in fragment
5. The provider extracts the token from the redirect URL and calls `saveOAuthAccount()`
6. `onSuccess()` re-renders the accounts list showing the logged-in state

**Key files**:
- `src/providers/types.ts` — `ProviderConfig` (with `onOAuthLogin`, `onOAuthLogout`), `OAuthLauncher` type
- `src/providers/oauth-service.ts` — `createOAuthLauncher()` factory (CLI popup vs extension chrome.identity)
- `src/ui/provider-settings.ts` — Calls `config.onOAuthLogin(launcher, onSuccess)` when login button clicked
- `src/cli/index.ts` — `/auth/callback` route (reads query params + fragment, postMessages to opener)
- `src/extension/service-worker.ts` — `handleOAuthRequest()` (generic `chrome.identity.launchWebAuthFlow`)

**Dual-mode redirect URIs**:

| Mode | Redirect URI | Registration |
|------|-------------|-------------|
| CLI | `http://localhost:5710/auth/callback` | Register with your OAuth provider/IdP |
| Extension | `https://<extension-id>.chromiumapp.org/` | Register with your OAuth provider/IdP |

**Type**:

```typescript
interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  apiKeyPlaceholder?: string;
  apiKeyEnvVar?: string;
  requiresBaseUrl: boolean;      // shown for non-OAuth; also shown for OAuth providers when true
  baseUrlPlaceholder?: string;
  baseUrlDescription?: string;
  isOAuth?: boolean;
  onOAuthLogin?: (launcher: OAuthLauncher, onSuccess: () => void) => Promise<void>;
  onOAuthLogout?: () => Promise<void>;
  /** Return the model IDs this provider supports (resolved against Anthropic registry). */
  getModelIds?: () => Array<{ id: string; name?: string }>;
}

type OAuthLauncher = (authorizeUrl: string) => Promise<string | null>;
```

**`requiresBaseUrl` for OAuth providers**: By default, the base URL field is hidden for OAuth providers. Set `requiresBaseUrl: true` to show it — useful for providers where the proxy endpoint is configurable at runtime. The base URL is saved to the account before `onOAuthLogin` is called, so the provider can read it via `getBaseUrlForProvider()`. The `saveOAuthAccount()` function preserves the existing `baseUrl` through re-logins.

**`getModelIds`**: When present, `getProviderModels()` uses this instead of returning all Anthropic models. Each ID is resolved against the Anthropic model registry; unknown IDs get fallback model objects with sensible defaults (`input: ['text', 'image']`, `baseUrl: ''`, etc.). Use this to restrict the model dropdown to models the proxy actually supports.

**Model ID pitfall**: Use pi-ai alias IDs (e.g., `claude-opus-4-6`) not dated IDs (e.g., `claude-opus-4-6-20250626`). In the browser bundle, `getModel()` returns `undefined` for unknown IDs instead of throwing, and `{ ...undefined }` silently produces `{}`. The alias resolves to a full model from the registry with all required fields.

**Base URL validation**: When `requiresBaseUrl: true` is set on an OAuth provider and no build-time default exists (empty `proxyEndpoint` in config), the login button validates that a URL was entered. Users cannot proceed without providing a proxy endpoint.

**Test pattern**:

OAuth flow is runtime-dependent (browser popups, chrome.identity). Test the provider's token extraction and account saving logic in isolation:

```typescript
import { describe, it, expect } from 'vitest';

describe('my-corp provider', () => {
  it('extracts token from redirect URL', () => {
    const url = 'https://sso.mycorp.com/callback#access_token=abc123&expires_in=3600';
    const fragment = new URLSearchParams(url.slice(url.indexOf('#') + 1));
    expect(fragment.get('access_token')).toBe('abc123');
  });
});
```

**Reference files**: `src/providers/oauth-service.ts`, `src/providers/types.ts`, `src/ui/provider-settings.ts`

---

## Integration Checklist

When adding a feature:

- [ ] Core logic implemented with error handling
- [ ] Test file colocated (`feature.test.ts` next to `feature.ts`)
- [ ] Pure-logic tests added (avoid DOM/chrome.* testing in vitest unless necessary)
- [ ] Extension mode compatibility verified (CSP, chrome.runtime.getURL, sandbox iframe if needed)
- [ ] Dual-mode tested (CLI + extension)
- [ ] Logging added (`createLogger('namespace')`)
- [ ] CLAUDE.md updated if architectural pattern is new
- [ ] No sensitive data logged or stored in localStorage unencrypted

---

## Build & Test

```bash
# Type-check both browser and CLI
npm run typecheck

# Run tests
npm run test

# Watch mode for TDD
npm run test:watch

# Standalone dev
npm run dev:full

# Extension dev
npm run build:extension
# Then load dist/extension in chrome://extensions
```

---

## 14. Add Interactive Tool UI (Approval Dialogs, Forms)

**When**: A shell command or tool needs user interaction before proceeding (e.g., permission approval, file picker, form input). Tool UI solves the "user gesture" problem — browser APIs like `showDirectoryPicker()` require a user click, but agent-driven tool calls have no gesture context.

**Files to modify**:
- Your command file (e.g., `src/fs/mount-commands.ts`)
- Import from: `src/tools/tool-ui.ts`

**How it works**:

1. Tool execution sets up a context with `onUpdate` callback (handled automatically by `tool-adapter.ts`)
2. Shell commands call `showToolUIFromContext()` to render interactive HTML in the chat
3. User clicks a button → callback runs with user gesture context → can call restricted APIs
4. Promise resolves with user's action/data

**Implementation** (from mount command):

```typescript
import { getToolExecutionContext, showToolUIFromContext } from '../tools/tool-ui.js';

async function execute(args: string[]): Promise<ShellResult> {
  // Check if running in agent context (no user gesture)
  const toolContext = getToolExecutionContext();
  
  if (toolContext) {
    // Agent-driven: show approval UI
    const result = await showToolUIFromContext({
      html: `
        <div class="tool-ui">
          <p>The agent wants to access <code>${targetPath}</code></p>
          <div class="tool-ui__actions">
            <button class="tool-ui__btn tool-ui__btn--primary" data-action="approve">
              Approve
            </button>
            <button class="tool-ui__btn tool-ui__btn--secondary" data-action="deny">
              Deny
            </button>
          </div>
        </div>
      `,
      onAction: async (action) => {
        if (action === 'approve') {
          // Runs with user gesture! Can call showDirectoryPicker(), etc.
          const handle = await window.showDirectoryPicker();
          return { approved: true, handle };
        }
        return { approved: false };
      },
    });
    
    if (!result?.approved) {
      return { stdout: '', stderr: 'User denied', exitCode: 1 };
    }
    // Use result.handle...
  } else {
    // Terminal/user-driven: has gesture, call API directly
    const handle = await window.showDirectoryPicker();
  }
}
```

**HTML conventions**:

- Wrap content in `<div class="tool-ui">`
- Use `data-action="actionName"` on buttons for click handling
- Use `data-action-data='{"key":"value"}'` for additional data (JSON)
- Available button classes: `.tool-ui__btn--primary`, `.tool-ui__btn--secondary`
- Forms: add `data-action="submit"` to form, fields become action data

**Key functions** (`src/tools/tool-ui.ts`):

```typescript
// Get current tool execution context (null if not in a tool)
getToolExecutionContext(): ToolExecutionContext | null

// Show UI and wait for user action (returns null if no context)
showToolUIFromContext(request: {
  html: string;
  onAction?: (action: string, data?: unknown) => Promise<unknown> | unknown;
}): Promise<unknown | null>

// Lower-level: show UI with explicit onUpdate callback
showToolUI(request: ToolUIRequest, onUpdate: OnUpdateCallback): Promise<unknown>
```

**Lifecycle**:

1. Tool calls `showToolUIFromContext()` → UI appears in chat (tool call auto-expands)
2. User clicks button with `data-action` → `onAction` callback fires with gesture context
3. Callback return value resolves the `showToolUIFromContext()` promise
4. UI is automatically cleaned up when tool execution ends

**Extension vs CLI mode**:

- CLI mode: HTML rendered directly in DOM with click handlers
- Extension mode: HTML rendered in CSP-exempt sandbox iframe, actions posted via `postMessage`

Both modes handle `data-action` clicks and form submissions identically.

---

## Common Patterns

**Error handling**: Wrap async operations in try/catch. Return `{ content: errorMsg, isError: true }` for tools.

**Logging**: Import `createLogger('namespace')` from `src/core/logger.js`. Logs are filtered by level (DEBUG in dev, ERROR in prod).

**VFS access**: All core layers have access to VirtualFS. Scoops get RestrictedFS (path-based ACL).

**Shell commands**: Prefer shell commands (bash tool) for new capabilities. Dedicated tools only if the capability needs binary data (browser screenshots, network recording).

**Browser automation**: Use `playwright-cli` / `playwright` / `puppeteer` for tab control. Use `serve <dir>` for app directories and `open` for single preview files.

---

## Resources

- **pi-mono architecture**: https://github.com/badlogic/pi-mono
- **just-bash**: https://github.com/jotaen/just-bash
- **Isomorphic-git**: https://isomorphic-git.org/
- **LightningFS**: https://github.com/steverice/lightning-fs
