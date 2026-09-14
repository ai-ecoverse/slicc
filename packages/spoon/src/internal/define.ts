export function define(tag: string, ctor: CustomElementConstructor): void {
  if (typeof customElements === 'undefined' || customElements == null) return;
  if (!customElements.get(tag)) {
    customElements.define(tag, ctor);
  }
}
