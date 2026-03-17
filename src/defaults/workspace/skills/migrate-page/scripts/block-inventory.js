/**
 * Scan an EDS project's blocks/ directory for available blocks.
 *
 * Runs in Slicc's JavaScript tool context (fs globals available).
 *
 * Usage:
 *   const blocks = await scanBlockInventory('/shared/repo-name');
 *   return JSON.stringify(blocks);
 */
async function scanBlockInventory(projectPath) {
  var blocksDir = projectPath + '/blocks';
  var entries = [];

  var dirEntries;
  try {
    dirEntries = await fs.readDir(blocksDir);
  } catch (e) {
    return entries;
  }

  for (var i = 0; i < dirEntries.length; i++) {
    var entry = dirEntries[i];
    if (entry.type !== 'directory') continue;

    var name = entry.name;
    var blockDir = blocksDir + '/' + name;

    var files;
    try {
      files = await fs.readDir(blockDir);
    } catch (e) {
      continue;
    }

    var hasJs = files.some(function(f) { return f.name === name + '.js'; });
    var hasCss = files.some(function(f) { return f.name === name + '.css'; });

    if (!hasJs && !hasCss) continue;

    var jsSize;
    var cssSize;

    if (hasJs) {
      var jsContent = await fs.readFile(blockDir + '/' + name + '.js', { encoding: 'utf-8' });
      jsSize = jsContent.length;
    }

    if (hasCss) {
      var cssContent = await fs.readFile(blockDir + '/' + name + '.css', { encoding: 'utf-8' });
      cssSize = cssContent.length;
    }

    entries.push({ name: name, hasJs: hasJs, hasCss: hasCss, jsSize: jsSize, cssSize: cssSize });
  }

  return entries;
}

if (typeof module !== 'undefined') module.exports = { scanBlockInventory };
