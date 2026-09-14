export class Agent {}

export function request() {
  throw new Error('http.request is not available in the browser');
}

export function createServer() {
  throw new Error('http.createServer is not available in the browser');
}

export default { Agent, request, createServer };
