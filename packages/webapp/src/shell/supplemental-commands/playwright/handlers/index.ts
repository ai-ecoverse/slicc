/**
 * Subcommand → handler dispatch table for the playwright-cli command family.
 */

import type { PlaywrightHandler } from '../types.js';
import {
  cookieClearHandler,
  cookieDeleteHandler,
  cookieGetHandler,
  cookieListHandler,
  cookieSetHandler,
} from './cookies.js';
import { dialogAcceptHandler, dialogDismissHandler } from './dialog.js';
import { evalFileHandler, evalHandler } from './eval.js';
import { fetchHandler } from './fetch.js';
import {
  checkHandler,
  clickHandler,
  dblclickHandler,
  dragHandler,
  fillHandler,
  hoverHandler,
  keydownHandler,
  keyupHandler,
  pressHandler,
  selectHandler,
  typeHandler,
  uncheckHandler,
} from './interaction.js';
import { goBackHandler, goForwardHandler, gotoHandler, reloadHandler } from './navigation.js';
import { recordHandler, stopRecordingHandler } from './recording.js';
import { framesHandler, screenshotHandler, snapshotHandler } from './snapshot.js';
import { localStorageHandlers, sessionStorageHandlers } from './storage.js';
import { openHandler, resizeHandler, tabCloseHandler, tabListHandler } from './tabs.js';
import { teleportHandler } from './teleport.js';

export const playwrightHandlers: Map<string, PlaywrightHandler> = new Map([
  ['teleport', teleportHandler],
  ['open', openHandler],
  ['tab-new', openHandler],
  ['fetch', fetchHandler],
  ['goto', gotoHandler],
  ['navigate', gotoHandler],
  ['snapshot', snapshotHandler],
  ['frames', framesHandler],
  ['screenshot', screenshotHandler],
  ['click', clickHandler],
  ['type', typeHandler],
  ['fill', fillHandler],
  ['eval', evalHandler],
  ['eval-file', evalFileHandler],
  ['press', pressHandler],
  ['keydown', keydownHandler],
  ['keyup', keyupHandler],
  ['go-back', goBackHandler],
  ['go-forward', goForwardHandler],
  ['reload', reloadHandler],
  ['tab-list', tabListHandler],
  ['tab-close', tabCloseHandler],
  ['close', tabCloseHandler],
  ['dblclick', dblclickHandler],
  ['hover', hoverHandler],
  ['select', selectHandler],
  ['check', checkHandler],
  ['uncheck', uncheckHandler],
  ['drag', dragHandler],
  ['resize', resizeHandler],
  ['dialog-accept', dialogAcceptHandler],
  ['dialog-dismiss', dialogDismissHandler],
  ['cookie-list', cookieListHandler],
  ['cookie-get', cookieGetHandler],
  ['cookie-set', cookieSetHandler],
  ['cookie-delete', cookieDeleteHandler],
  ['cookie-clear', cookieClearHandler],
  ['localstorage-list', localStorageHandlers.list],
  ['localstorage-get', localStorageHandlers.get],
  ['localstorage-set', localStorageHandlers.set],
  ['localstorage-delete', localStorageHandlers.del],
  ['localstorage-clear', localStorageHandlers.clear],
  ['sessionstorage-list', sessionStorageHandlers.list],
  ['sessionstorage-get', sessionStorageHandlers.get],
  ['sessionstorage-set', sessionStorageHandlers.set],
  ['sessionstorage-delete', sessionStorageHandlers.del],
  ['sessionstorage-clear', sessionStorageHandlers.clear],
  ['record', recordHandler],
  ['stop-recording', stopRecordingHandler],
]);
