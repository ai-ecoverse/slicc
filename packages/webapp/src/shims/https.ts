export class Agent {}

export function request() {
  throw new Error('https.request is not available in the browser');
}

export function createServer() {
  throw new Error('https.createServer is not available in the browser');
}

export default { Agent, request, createServer };
