/**
 * Extension service worker — opens the side panel when the action icon is clicked.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
