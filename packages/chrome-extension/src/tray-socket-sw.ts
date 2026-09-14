import type {
  ExtensionMessage,
  TraySocketCommandMessage,
  TraySocketErrorMsg,
  TraySocketMessageMsg,
  TraySocketOpenedMsg,
  TraySocketOpenMsg,
} from '../../webapp/src/kernel/messages.js';
import { postServiceWorkerMessage } from './sw-broadcast.js';

const traySockets = new Map<number, WebSocket>();

const supersededSockets = new WeakSet<WebSocket>();

export function isTraySocketCommand(
  payload: ExtensionMessage['payload']
): payload is TraySocketCommandMessage {
  return (
    payload.type === 'tray-socket-open' ||
    payload.type === 'tray-socket-send' ||
    payload.type === 'tray-socket-close'
  );
}

export async function handleTraySocketCommand(command: TraySocketCommandMessage): Promise<void> {
  switch (command.type) {
    case 'tray-socket-open':
      openTraySocket(command);
      return;
    case 'tray-socket-send': {
      const socket = traySockets.get(command.id);
      if (!socket) {
        throw new Error(`Tray socket ${command.id} is not open`);
      }
      socket.send(command.data);
      return;
    }
    case 'tray-socket-close': {
      const socket = traySockets.get(command.id);
      traySockets.delete(command.id);
      socket?.close(command.code, command.reason);
      return;
    }
  }
}

function openTraySocket(command: TraySocketOpenMsg): void {
  const previous = traySockets.get(command.id);
  if (previous !== undefined) {
    supersededSockets.add(previous);
    previous.close(1000, 'replaced');
  }
  const socket = new WebSocket(command.url);
  traySockets.set(command.id, socket);

  socket.addEventListener('open', () => {
    if (supersededSockets.has(socket)) return;
    postServiceWorkerMessage({
      type: 'tray-socket-opened',
      id: command.id,
    } satisfies TraySocketOpenedMsg);
  });
  socket.addEventListener('message', (event) => {
    if (supersededSockets.has(socket)) return;
    postServiceWorkerMessage({
      type: 'tray-socket-message',
      id: command.id,
      data: typeof event.data === 'string' ? event.data : String(event.data),
    } satisfies TraySocketMessageMsg);
  });
  socket.addEventListener('error', () => {
    if (supersededSockets.has(socket)) return;
    if (traySockets.get(command.id) === socket) {
      traySockets.delete(command.id);
    }
    postServiceWorkerMessage({
      type: 'tray-socket-error',
      id: command.id,
      error: 'Tray leader WebSocket failed in extension service worker',
    } satisfies TraySocketErrorMsg);
  });
  socket.addEventListener('close', () => {
    if (supersededSockets.has(socket)) return;
    if (traySockets.get(command.id) === socket) {
      traySockets.delete(command.id);
    }
    postServiceWorkerMessage({ type: 'tray-socket-closed', id: command.id });
  });
}
