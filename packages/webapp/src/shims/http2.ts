export const constants = {};

export function createServer() {
  throw new Error('http2.createServer is not available in the browser');
}

export function connect() {
  throw new Error('http2.connect is not available in the browser');
}

export default { constants, createServer, connect };
