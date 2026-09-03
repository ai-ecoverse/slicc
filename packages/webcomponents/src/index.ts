// @slicc/webcomponents — public barrel (generated; see register.ts).

// The launcher overlay lives in its own self-contained package (`@ai-ecoverse/spoon`)
// so the one artifact every runtime embeds has an isolated source graph. Re-exported
// here for back-compat with existing `@slicc/webcomponents` consumers and `?ui=wc`.
export {
  DEFAULT_LAUNCHER_CORNER,
  DEFAULT_LAUNCHER_FOLLOWER_STATUS,
  LAUNCHER_CORNERS,
  LAUNCHER_FOLLOWER_STATUS_ATTR,
  LAUNCHER_FOLLOWER_STATUSES,
  type LauncherCorner,
  type LauncherFollowerStatus,
  type LauncherMoveDetail,
  type LauncherToggleDetail,
  normalizeLauncherCorner,
  normalizeLauncherFollowerStatus,
  resolveLauncherCorner,
  SliccLauncher,
  shouldSnapLauncher,
} from '@ai-ecoverse/spoon';
export { SliccAddMenu } from './add-menu/slicc-add-menu.js';
export { SliccSoundboard } from './audio/slicc-soundboard.js';
export {
  type CueRecipe,
  playSoundscapeCue,
  RECIPES,
  type SoundscapeCue,
} from './audio/soundscape-cues.js';
export { SliccActionCard } from './chat/slicc-action-card.js';
export { SliccActionRow } from './chat/slicc-action-row.js';
export { SliccAgentMessage } from './chat/slicc-agent-message.js';
export { SliccChatTable } from './chat/slicc-chat-table.js';
export { SliccChatThread } from './chat/slicc-chat-thread.js';
export { SliccDelegationLine } from './chat/slicc-delegation-line.js';
export { SliccDip } from './chat/slicc-dip.js';
export { SliccErrorCard } from './chat/slicc-error-card.js';
export { SliccHandoffCard } from './chat/slicc-handoff-card.js';
export { SliccLickCard } from './chat/slicc-lick-card.js';
export { SliccToolCluster } from './chat/slicc-tool-cluster.js';
export { SliccUserMessage } from './chat/slicc-user-message.js';
export { HOLD_TO_ENABLE_MS, SliccComposer } from './composer/slicc-composer.js';
export {
  type CameraMediaProvider,
  type CaptureDeviceChangeDetail,
  type CaptureMode,
  type CaptureResult,
  type RecorderFactory,
  SliccComposerCapture,
} from './composer/slicc-composer-capture.js';
export { SliccComposerMeta } from './composer/slicc-composer-meta.js';
export { SliccInputCard } from './composer/slicc-input-card.js';
export { type KeyPress, SliccKeyHud } from './composer/slicc-key-hud.js';
export { type QueuedMessage, SliccQueuedStack } from './composer/slicc-queued-stack.js';
export {
  type ComposerSpeech,
  createBuiltinComposerSpeech,
  type MicrophoneInfo,
  type SpeechDownloadProgress,
  type SpeechEngineStatus,
  type SpeechSession,
  type SpeechSessionOptions,
} from './composer/speech.js';
export { SliccDock } from './dock/slicc-dock.js';
export { SliccDockItem } from './dock/slicc-dock-item.js';
export { SliccTabOverlay } from './dock/slicc-tab-overlay.js';
export { SliccFreezer } from './freezer/slicc-freezer.js';
export { SliccFreezerCard } from './freezer/slicc-freezer-card.js';
export { SliccFreezerNew } from './freezer/slicc-freezer-new.js';
export { SliccFrostShader } from './freezer/slicc-frost-shader.js';
export { SliccShader } from './freezer/slicc-shader.js';
export { define } from './internal/define.js';
export { escapeHtml } from './internal/html.js';
export { hasIcon, iconSvg } from './internal/icons.js';
export {
  MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN,
  MACHINE_WRITTEN_MEMORY_MARKDOWN,
  MACHINE_WRITTEN_MEMORY_PATH,
  type MachineWrittenMemoryFixtureTarget,
  type MachineWrittenMemoryVariant,
  mountMachineWrittenMemoryFixture,
} from './memory/machine-written-memory-fixture.js';
export {
  mountRedactedRealWorldMemoryFixture,
  REDACTED_REAL_WORLD_MEMORY_MARKDOWN,
  REDACTED_REAL_WORLD_MEMORY_PATH,
  type RedactedRealWorldMemoryFixtureTarget,
} from './memory/redacted-real-world-memory-fixture.js';
export { SliccMemoryPanel } from './memory/slicc-memory-panel.js';
export { SliccMemrow } from './memory/slicc-memrow.js';
export { SliccMemtag } from './memory/slicc-memtag.js';
export { SliccPaletteCell } from './memory/slicc-palette-cell.js';
export { SliccPaletteGrid } from './memory/slicc-palette-grid.js';
export {
  mountSyntheticMemoryFixture,
  SYNTHETIC_MEMORY_MARKDOWN,
  SYNTHETIC_MEMORY_PATH,
  type SyntheticMemoryFixtureTarget,
} from './memory/synthetic-memory-fixture.js';
export { SliccAvatarMenu } from './nav/slicc-avatar-menu.js';
export { SliccNav } from './nav/slicc-nav.js';
export {
  type MenuItem,
  type OverflowMenuOptions,
  SliccOverflowMenu,
} from './overflow-menu/slicc-overflow-menu.js';
export { SliccCameraDialog } from './overlay/slicc-camera-dialog.js';
export { SliccDialog } from './overlay/slicc-dialog.js';
export {
  type FilesystemPermissionProvider,
  type HidPermissionProvider,
  type PermissionDenyDetail,
  type PermissionGrant,
  type PermissionKind,
  type PermissionPromptOptions,
  type PermissionPromptResult,
  type PermissionProviders,
  type PermissionRequestOptions,
  type ScreenSharePermissionProvider,
  type SerialPermissionProvider,
  SliccPermissions,
  type UsbPermissionProvider,
} from './overlay/slicc-permissions.js';
export { SliccTooltip } from './overlay/slicc-tooltip.js';
export { liveArrangement } from './panel/center-ops.js';
export {
  type Arrangement,
  type CenterNode,
  cloneLayout,
  DEFAULT_ZONE_AXIS,
  type DockEdge,
  type DockSpec,
  emptyLayout,
  type FloatingSpec,
  isPanelLocked,
  isSplitNode,
  LAYOUT_SCHEMA_VERSION,
  type LayoutDocument,
  type LayoutEnvironment,
  type LayoutVariant,
  layoutPanelIds,
  moveToZone,
  type PanelOverride,
  parseLayoutDocument,
  type ResolvedLayout,
  removeFromZones,
  resolveLayout,
  type SplitDirection,
  sizeToFlex,
  type VariantCondition,
  variantMatches,
  walkCenter,
  ZONE_NAMES,
  type ZoneName,
  type ZonesSpec,
  zoneAxis,
  zoneOfPanel,
  zonesFromCenter,
} from './panel/layout-schema.js';
export {
  getPanel,
  hasPanel,
  listPanels,
  listPanelsByOrigin,
  type PanelRegistration,
  type PanelRegistryChangeDetail,
  type PanelSource,
  panelRegistryEvents,
  registerPanel,
  registerPanelElement,
  unregisterPanel,
} from './panel/panel-registry.js';
export { type LayoutChangeDetail, SliccLayout } from './panel/slicc-layout.js';
export {
  isPanelAnchor,
  PANEL_MARKER_ATTR,
  type PanelAnchor,
  type PanelMeta,
  type PanelPresentation,
  type PanelSize,
  type PanelVisibilityDetail,
  panelMetaOf,
  SliccPanel,
} from './panel/slicc-panel.js';
export type {
  FloatbarConnection,
  FloatbarFloatKind,
  FloatbarStatus,
  FloatbarTrayRole,
} from './primitives/floatbar-status.js';
export {
  connectionLabel,
  defaultFloatLabel,
  floatKindIcon,
  floatKindLabel,
  statusTipFragment,
  trayRoleLabel,
} from './primitives/floatbar-status.js';
export { SliccAvatar } from './primitives/slicc-avatar.js';
export { SliccBlobChip } from './primitives/slicc-blob-chip.js';
export {
  type CostOverlayModel,
  type CostOverlayScoop,
  SliccCostOverlay,
} from './primitives/slicc-cost-overlay.js';
export { SliccDaySeparator } from './primitives/slicc-day-separator.js';
export { SliccFloatbar } from './primitives/slicc-floatbar.js';
export { type FollowerHudRow, SliccFollowerHud } from './primitives/slicc-follower-hud.js';
export { SliccGooglyEyes } from './primitives/slicc-googly-eyes.js';
export { SliccIconButton } from './primitives/slicc-icon-button.js';
export { SliccImagePreview } from './primitives/slicc-image-preview.js';
export { SliccPane } from './primitives/slicc-pane.js';
export { SliccPressButton } from './primitives/slicc-press-button.js';
export { SliccSendButton } from './primitives/slicc-send-button.js';
export { SliccSnowflake } from './primitives/slicc-snowflake.js';
export { SliccSwatch } from './primitives/slicc-swatch.js';
export { SliccTag } from './primitives/slicc-tag.js';
export {
  type QuickLookOptions,
  SliccQuickLook,
} from './quick-look/slicc-quick-look.js';
export { registerAllSliccComponents } from './register.js';
export { SliccChatpane } from './shell/slicc-chatpane.js';
export { SliccShell } from './shell/slicc-shell.js';
export { SliccAgentAvatar } from './switcher/slicc-agent-avatar.js';
export {
  type AgentState,
  arcDash,
  type ScoopDescriptor,
  type ScoopSelectDetail,
  SliccAgentTabs,
} from './switcher/slicc-agent-tabs.js';
export { SliccScoopOverflow } from './switcher/slicc-scoop-overflow.js';
export { SliccTheme } from './theme/slicc-theme.js';
export { SliccThemeToggle } from './theme/slicc-theme-toggle.js';
export * from './theme/tokens.js';
export {
  CHAT_SURFACE_ID,
  type DockNode,
  type DockTreeSpec,
  labelForSurface,
  SliccDockTree,
  // Aliased: the panel system exports the plain `ZoneName` now. This is the
  // dock-tree's own zone vocabulary, which happens to use the same five words.
  type ZoneName as DockZoneName,
} from './workbench/slicc-dock-tree.js';
export { SliccFileTree } from './workbench/slicc-file-tree.js';
export {
  type MonitorAccent,
  type MonitorAlert,
  type MonitorMeterMarker,
  type MonitorModel,
  type MonitorProcessRow,
  type MonitorProcessTable,
  type MonitorRow,
  type MonitorSection,
  type MonitorSeries,
  type MonitorSeriesPoint,
  type MonitorStatus,
  type MonitorVital,
  SliccMonitor,
} from './workbench/slicc-monitor.js';
export { SliccSurface } from './workbench/slicc-surface.js';
export { SliccTerminal } from './workbench/slicc-terminal.js';
