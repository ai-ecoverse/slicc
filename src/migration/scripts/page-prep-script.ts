/**
 * Self-contained page preparation script for in-page evaluation.
 *
 * Runs inside a target page via BrowserAPI.evaluate(). Fixes
 * fixed-position elements that obscure content during screenshots,
 * then scrolls the page to trigger lazy-loaded images/content.
 *
 * Returns JSON stats: { fixedElementsConverted, totalHeight, stepsScrolled }
 */
export const PAGE_PREP_SCRIPT = `
  // Phase 1: Convert position:fixed elements to position:relative
  let fixedElementsConverted = 0;
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    const style = window.getComputedStyle(el);
    if (style.position === 'fixed') {
      el.style.position = 'relative';
      fixedElementsConverted++;
    }
  }

  // Phase 2: Scroll through the page to trigger lazy loading
  const scrollStep = window.innerHeight;
  const totalHeight = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  );
  let stepsScrolled = 0;

  for (let pos = 0; pos < totalHeight; pos += scrollStep) {
    window.scrollTo(0, pos);
    stepsScrolled++;
    await new Promise(function(r) { setTimeout(r, 100); });
  }

  // Scroll to absolute bottom to catch any remaining content
  window.scrollTo(0, totalHeight);
  await new Promise(function(r) { setTimeout(r, 100); });

  // Phase 3: Return to top and settle
  window.scrollTo(0, 0);
  await new Promise(function(r) { setTimeout(r, 500); });

  return { fixedElementsConverted, totalHeight, stepsScrolled };
`;
