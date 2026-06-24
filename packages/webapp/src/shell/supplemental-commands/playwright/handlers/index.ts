/**
 * Subcommand → handler dispatch table for the playwright-cli command family.
 */

import type { PlaywrightHandler } from '../types.js';
import { consoleHandler } from './console.js';
import {
  cookieClearHandler,
  cookieDeleteHandler,
  cookieGetHandler,
  cookieListHandler,
  cookieSetHandler,
} from './cookies.js';
import { generateLocatorHandler, highlightHandler } from './devtools.js';
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
import {
  dropHandler,
  mousedownHandler,
  mousemoveHandler,
  mouseupHandler,
  mousewheelHandler,
} from './mouse.js';
import { goBackHandler, goForwardHandler, gotoHandler, reloadHandler } from './navigation.js';
import { networkStateSetHandler } from './network.js';
import {
  requestBodyHandler,
  requestHandler,
  requestHeadersHandler,
  requestsHandler,
  responseBodyHandler,
  responseHeadersHandler,
} from './network-requests.js';
import { recordHandler, stopRecordingHandler } from './recording.js';
import { routeHandler, routeListHandler, unrouteHandler } from './routing.js';
import { framesHandler, pdfHandler, screenshotHandler, snapshotHandler } from './snapshot.js';
import { stateLoadHandler, stateSaveHandler } from './state.js';
import { localStorageHandlers, sessionStorageHandlers } from './storage.js';
import {
  openHandler,
  resizeHandler,
  tabCloseHandler,
  tabListHandler,
  tabSelectHandler,
} from './tabs.js';
import { teleportHandler } from './teleport.js';
import { uploadHandler } from './upload.js';

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
  ['tab-select', tabSelectHandler],
  ['pdf', pdfHandler],
  ['network-state-set', networkStateSetHandler],
  ['upload', uploadHandler],
  ['state-save', stateSaveHandler],
  ['state-load', stateLoadHandler],
  ['console', consoleHandler],
  ['requests', requestsHandler],
  ['request', requestHandler],
  ['request-headers', requestHeadersHandler],
  ['request-body', requestBodyHandler],
  ['response-headers', responseHeadersHandler],
  ['response-body', responseBodyHandler],
  ['mousemove', mousemoveHandler],
  ['mousedown', mousedownHandler],
  ['mouseup', mouseupHandler],
  ['mousewheel', mousewheelHandler],
  ['drop', dropHandler],
  ['route', routeHandler],
  ['route-list', routeListHandler],
  ['unroute', unrouteHandler],
  ['generate-locator', generateLocatorHandler],
  ['highlight', highlightHandler],
]);
