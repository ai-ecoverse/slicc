export class Readable {
  constructor() {
    throw new Error('stream.Readable is not available in the browser');
  }
}

export class Writable {
  constructor() {
    throw new Error('stream.Writable is not available in the browser');
  }
}

export default { Readable, Writable };
