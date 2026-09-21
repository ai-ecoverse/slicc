/**
 * Theme, layout, and computer-tab panel-RPC handlers.
 */
import type { PanelRpcHandlers } from '../../kernel/panel-rpc.js';

export function buildThemeHandler() {
  return {
    'theme-apply': async ({
      themeJson,
      action,
    }: {
      themeJson?: string;
      action: 'apply' | 'reset';
    }) => {
      const {
        importTheme,
        saveCustomTheme,
        setActiveTheme,
        clearActiveTheme,
        applyThemeOverrides,
      } = await import('../theme-engine.js');
      if (action === 'reset') {
        clearActiveTheme();
        applyThemeOverrides();
        return { applied: null };
      }
      if (themeJson) {
        const theme = importTheme(themeJson);
        saveCustomTheme(theme);
        setActiveTheme(theme.id);
        applyThemeOverrides();
        return { applied: theme.id };
      }
      return { applied: null };
    },
  };
}

// Parity note: this handler set is installed page-side ONLY via
// `setupStandalonePanelRpc` ← `wireWcTray` ← `wc-live.ts` (gated on
// `options.standalone && options.instanceId`). The extension's kernel
// worker + orchestrator run in the hosted-leader tab, which boots through
// `bootLeaderFloat` (runtimeMode `hosted-leader`, standalone opts + instanceId
// set) — so the `layout` command reaches this handler by the SAME path as
// standalone. Extension parity is therefore automatic (no separate install).
export function buildLayoutHandler() {
  return {
    'layout-apply': async (
      msg: import('../../shell/supplemental-commands/layout-command.js').LayoutApplyMsg
    ) => {
      const { getLayoutApplier } = await import('../wc/layout-apply-registry.js');
      const applier = getLayoutApplier();
      if (!applier) return { applied: false, error: 'no layout is mounted' };
      // Document verbs answer with text/errors the shell prints; the older
      // dock-tree verbs return nothing, which still means "applied".
      const result = await applier(msg);
      return result ?? { applied: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function pageBrowser(): import('../../cdp/browser-api.js').BrowserAPI {
  const g = globalThis as { __slicc_browser?: import('../../cdp/browser-api.js').BrowserAPI };
  if (!g.__slicc_browser) throw new Error('no browser API on this page');
  return g.__slicc_browser;
}

export function buildComputerTabHandlers() {
  return {
    'computer-tab-screenshot': async (payload) => {
      const { screenshotTab } = await import('../../computers/adapters/tab.js');
      return screenshotTab(pageBrowser(), payload.targetId, {
        maxWidth: payload.maxWidth,
        format: payload.format,
      });
    },
    'computer-tab-input': async (payload) => {
      const { inputTab } = await import('../../computers/adapters/tab.js');
      await inputTab(pageBrowser(), payload.targetId, payload.events);
      return { ok: true as const };
    },
  } satisfies Partial<PanelRpcHandlers>;
}
