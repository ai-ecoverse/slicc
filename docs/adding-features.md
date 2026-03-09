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

## 4. Add a Browser Tool Sub-Action

**When**: To extend the `browser` tool with a new action (e.g., `get_page_cookies`, `record_video`).

**Files to modify**:
- Modify: `src/tools/browser-tool.ts`

**Implementation**:

In the `execute` switch statement:

```typescript
// src/tools/browser-tool.ts
export function createBrowserTool(browser: BrowserAPI, fs?: VirtualFS | null): ToolDefinition {
  return {
    name: 'browser',
    description: '... existing description ... new_action (description of new action)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            // ... existing actions ...
            'my_new_action',
          ],
        },
        // ... new parameters ...
        myParam: {
          type: 'string',
          description: 'Description of myParam',
        },
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = input['action'] as string;

      switch (action) {
        // ... existing cases ...

        case 'my_new_action': {
          const targetId = (input['targetId'] as string) ?? (await getActiveTab());
          if (!targetId) return { content: 'No active tab', isError: true };

          try {
            const result = await browser.myNewMethod(targetId);
            return { content: JSON.stringify(result) };
          } catch (err) {
            return { content: `Error: ${err}`, isError: true };
          }
        }

        default:
          return { content: `Unknown action: ${action}`, isError: true };
      }
    },
  };
}
```

**Pattern**:

- Check for optional `targetId`; call `getActiveTab()` if not provided
- Wrap BrowserAPI calls in try/catch
- Return `ToolResult` with JSON stringification for complex data
- Add the action to the `enum` in `inputSchema`

**Test pattern**:

```typescript
// src/tools/browser-tool.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBrowserTool } from './browser-tool.js';

describe('browser_tool', () => {
  let mockBrowser: BrowserAPI;

  beforeEach(() => {
    mockBrowser = {
      myNewMethod: vi.fn().mockResolvedValue({ success: true }),
      // ... other methods ...
    } as unknown as BrowserAPI;
  });

  it('should handle my_new_action', async () => {
    const tool = createBrowserTool(mockBrowser);
    const result = await tool.execute({
      action: 'my_new_action',
      targetId: 'tab-1',
    });
    expect(result.isError).toBeFalsy();
  });
});
```

**Reference file**: `src/tools/browser-tool.ts` (lines 200+)

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

Skills are auto-discovered from `/workspace/skills/` during scoop initialization. Headers shown by default; full content loaded on demand.

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

During `ScoopContext.init()`, skills are loaded from `/workspace/skills/` (cone) or `/scoops/{folder}/workspace/skills/` (scoop). The agent's system prompt includes skill headers and can request full content via `read_file`.

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

**When**: To support a new LLM provider (e.g., Groq, Hugging Face).

**Files to create/modify**:
- Create: `src/providers/my-provider.ts` (optional, if custom logic needed)
- Modify: `src/ui/provider-settings.ts`

**Implementation**:

Providers are managed by pi-ai (`@mariozechner/pi-ai`). Register in provider-settings:

```typescript
// src/ui/provider-settings.ts
const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  // ... existing providers ...
  'my-provider': {
    id: 'my-provider',
    name: 'My Provider',
    description: 'Models via My Provider API',
    requiresApiKey: true,
    apiKeyPlaceholder: 'your-api-key-format',
    apiKeyEnvVar: 'MY_PROVIDER_API_KEY',
    requiresBaseUrl: false,
  },
};
```

**Type**:

```typescript
interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  apiKeyPlaceholder?: string;
  apiKeyEnvVar?: string;
  requiresBaseUrl: boolean;
  baseUrlPlaceholder?: string;
  baseUrlDescription?: string;
}
```

**Custom provider implementation**:

If the provider needs custom logic (e.g., special header format, token counting):

```typescript
// src/providers/my-provider.ts
import type { Api, StreamFn } from '@mariozechner/pi-ai';

export const myProviderApi: Api = {
  models: ['model-1', 'model-2'],
  stream: async (context, options) => {
    // Custom stream implementation
  },
};
```

**Wire into getProviders()** (from pi-ai):

Provider support comes directly from pi-ai. If a custom implementation is needed, extend in `resolveCurrentModel()`:

```typescript
// src/ui/provider-settings.ts
export function resolveCurrentModel(): Model<Api> {
  const provider = getSelectedProvider();
  const modelId = getSelectedModelId();

  if (provider === 'my-provider') {
    const customApi = getMyProviderApi(); // Your custom implementation
    return { id: modelId, api: customApi, name: modelId };
  }

  return getModelDynamic(provider, modelId);
}
```

**UI updates**:

The provider selector in `showProviderSettings()` automatically includes all registered providers:

```typescript
// src/ui/provider-settings.ts
export function showProviderSettings(): void {
  const providers = getProviders(); // From pi-ai
  // UI auto-populates with all registered providers
}
```

**Test pattern**:

```typescript
// src/ui/provider-settings.test.ts
import { describe, it, expect } from 'vitest';
import { getSelectedProvider, setSelectedProvider } from './provider-settings.js';

describe('provider-settings', () => {
  it('should support my-provider', () => {
    setSelectedProvider('my-provider', 'my-api-key');
    expect(getSelectedProvider()).toBe('my-provider');
  });
});
```

**Reference file**: `src/ui/provider-settings.ts`

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

## Common Patterns

**Error handling**: Wrap async operations in try/catch. Return `{ content: errorMsg, isError: true }` for tools.

**Logging**: Import `createLogger('namespace')` from `src/core/logger.js`. Logs are filtered by level (DEBUG in dev, ERROR in prod).

**VFS access**: All core layers have access to VirtualFS. Scoops get RestrictedFS (path-based ACL).

**Shell commands**: Prefer shell commands (bash tool) for new capabilities. Dedicated tools only if the capability needs binary data (browser screenshots, network recording).

**Browser automation**: Use the `browser` tool for tab control. Multi-page apps use the preview Service Worker (serve action).

---

## Resources

- **pi-mono architecture**: https://github.com/badlogic/pi-mono
- **just-bash**: https://github.com/jotaen/just-bash
- **Isomorphic-git**: https://isomorphic-git.org/
- **LightningFS**: https://github.com/steverice/lightning-fs
