export interface KernelTransport<In, Out> {
  onMessage(handler: (message: In) => void): () => void;

  send(message: Out, transfer?: Transferable[]): void;
}
