// Side-effect registration of every SLICC custom element. Each component module
// self-registers on import; this barrel imports them all so a single call
// guarantees the full set is defined. Extend the import list as components land.
import './primitives/slicc-logo.js';

/**
 * Import every component module for side-effect registration. Safe to call
 * multiple times — registration is guarded against duplicates.
 */
export function registerAllSliccComponents(): void {
  // Intentionally empty: the imports above register on module evaluation. This
  // function exists so consumers have an explicit, tree-shake-proof entry point.
}
