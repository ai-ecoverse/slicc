(async () => {
  var fixedElementsConverted = 0;
  var allElements = document.querySelectorAll('*');
  for (var i = 0; i < allElements.length; i++) {
    var style = window.getComputedStyle(allElements[i]);
    if (style.position === 'fixed') {
      allElements[i].style.position = 'relative';
      fixedElementsConverted++;
    }
  }

  var scrollStep = window.innerHeight || 800;
  var totalHeight = Math.max(
    (document.body && document.body.scrollHeight) || 0,
    document.documentElement.scrollHeight || 0
  ) || 800;
  var stepsScrolled = 0;

  for (var pos = 0; pos < totalHeight; pos += scrollStep) {
    window.scrollTo(0, pos);
    stepsScrolled++;
    await new Promise(function(r) { setTimeout(r, 100); });
  }

  window.scrollTo(0, totalHeight);
  await new Promise(function(r) { setTimeout(r, 100); });

  window.scrollTo(0, 0);
  await new Promise(function(r) { setTimeout(r, 500); });

  return JSON.stringify({
    fixedElementsConverted: fixedElementsConverted,
    totalHeight: totalHeight,
    stepsScrolled: stepsScrolled
  });
})()
