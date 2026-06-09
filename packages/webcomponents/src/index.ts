// @slicc/webcomponents — public barrel (generated; see register.ts).
//
// Importing a component module self-registers its custom element (internal/define.ts).
// Re-export each class for typed construction plus the theme utilities. Call
// registerAllSliccComponents() to register the full set for side effects.

export { define } from './internal/define.js';
export { escapeHtml } from './internal/html.js';
export { SliccAvatar } from './primitives/slicc-avatar.js';
export { SliccCollapseBtn } from './primitives/slicc-collapse-btn.js';
export { SliccDaySeparator } from './primitives/slicc-day-separator.js';
export { SliccFloatbar } from './primitives/slicc-floatbar.js';
export { SliccGooglyEyes } from './primitives/slicc-googly-eyes.js';
export { SliccIconButton } from './primitives/slicc-icon-button.js';
export { SliccLogo } from './primitives/slicc-logo.js';
export { SliccPane } from './primitives/slicc-pane.js';
export { SliccPaneTag } from './primitives/slicc-pane-tag.js';
export { SliccSendButton } from './primitives/slicc-send-button.js';
export { SliccSnowflake } from './primitives/slicc-snowflake.js';
export { SliccSwatch } from './primitives/slicc-swatch.js';
export { SliccTag } from './primitives/slicc-tag.js';
export { registerAllSliccComponents } from './register.js';
export { SliccTheme } from './theme/slicc-theme.js';
export { SliccThemeToggle } from './theme/slicc-theme-toggle.js';
export * from './theme/tokens.js';
