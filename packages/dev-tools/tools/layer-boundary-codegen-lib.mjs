const GENERATED_PLUGIN_PREFIX = '.biome-plugins/generated/';

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  for (const [index, item] of value.entries()) requireString(item, `${label}[${index}]`);
}

function segmentsForLayer(name) {
  const segments = name.split('/');
  requireStringArray(segments, `stack layer ${name} segments`);
  return segments;
}

function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  requireString(slug, `rule slug for ${name}`);
  return slug;
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function createContent(denySegments, message) {
  const alternation = denySegments.map(escapeRegex).join('|');
  return [
    'or {',
    '    `import $_ from $source`,',
    '    JsImportNamedClause(source = $source),',
    '    `export $_ from $source`,',
    '    `import($source)`,',
    '    `require($source)`',
    '} where {',
    `    $source <: r".*(?:\\.\\./)+(?:${alternation})/.*",`,
    '    register_diagnostic(',
    '        span = $source,',
    `        message = ${JSON.stringify(message)},`,
    '        severity = "error"',
    '    )',
    '}',
    '',
  ].join('\n');
}

function createDescriptor(kind, name, includes, denySegments, message) {
  const ruleId = `${kind}-${slugify(name)}`;
  return {
    fileName: `${ruleId}.grit`,
    content: createContent(denySegments, message),
    includes: [...includes],
    kind,
    message,
    ruleId,
  };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new TypeError('config must be an object');
  if (!Array.isArray(config.stack)) throw new TypeError('config.stack must be an array');
  if (!Array.isArray(config.zones)) throw new TypeError('config.zones must be an array');
}

export function generateLayerBoundaryPlugins(config) {
  validateConfig(config);
  const plugins = [];

  for (const [index, layer] of config.stack.entries()) {
    requireString(layer?.name, `stack[${index}].name`);
    requireStringArray(layer.includes, `stack[${index}].includes`);
    const forbidden = config.stack.slice(index + 1).flatMap(({ name }) => segmentsForLayer(name));
    if (forbidden.length === 0) continue;
    const message = `${layer.name}/ must not import higher layers: ${forbidden
      .map((segment) => `${segment}/`)
      .join(', ')}.`;
    plugins.push(createDescriptor('layer', layer.name, layer.includes, forbidden, message));
  }

  for (const [index, zone] of config.zones.entries()) {
    requireString(zone?.name, `zones[${index}].name`);
    requireStringArray(zone.includes, `zones[${index}].includes`);
    requireStringArray(zone.denySegments, `zones[${index}].denySegments`);
    requireString(zone.message, `zones[${index}].message`);
    plugins.push(
      createDescriptor('zone', zone.name, zone.includes, zone.denySegments, zone.message)
    );
  }

  plugins.sort((left, right) => left.fileName.localeCompare(right.fileName));
  const fileNames = plugins.map(({ fileName }) => fileName);
  if (new Set(fileNames).size !== fileNames.length) {
    throw new TypeError('layer-boundary rule names must produce unique file names');
  }
  return plugins;
}

function pluginPath(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.path === 'string') return entry.path;
  return '';
}

function isGeneratedPlugin(entry) {
  return pluginPath(entry).replace(/^\.\//, '').startsWith(GENERATED_PLUGIN_PREFIX);
}

function findArrayEnd(content, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index++) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return index + 1;
  }
  throw new SyntaxError('biome.json plugins array is not closed');
}

function pluginsArraySpan(content) {
  const property = /(^|\n)([ \t]*)"plugins"\s*:/m.exec(content);
  if (!property) throw new SyntaxError('biome.json must contain a plugins array');
  const start = content.indexOf('[', property.index + property[0].length);
  if (start === -1) throw new SyntaxError('biome.json plugins must be an array');
  return { start, end: findArrayEnd(content, start), indent: property[2] };
}

function formatPluginEntry(entry) {
  if (typeof entry === 'string') return JSON.stringify(entry);
  const fields = [`"path": ${JSON.stringify(entry.path)}`];
  if (entry.includes) {
    const includes = `[${entry.includes.map((value) => JSON.stringify(value)).join(', ')}]`;
    fields.push(`"includes": ${includes}`);
  }
  return [
    '{',
    ...fields.map((field, index) => `  ${field}${index < fields.length - 1 ? ',' : ''}`),
    '}',
  ].join('\n');
}

function formatArray(value, indent) {
  const entries = value.map((entry) => formatPluginEntry(entry).replace(/\n/g, '\n  '));
  const formatted = [
    '[',
    ...entries.map((entry, index) => `  ${entry}${index < entries.length - 1 ? ',' : ''}`),
    ']',
  ].join('\n');
  return formatted.replace(/\n/g, `\n${indent}`);
}

export function patchBiomeConfigPlugins(content, generatedPlugins) {
  const config = JSON.parse(content);
  if (!Array.isArray(config.plugins)) throw new TypeError('biome.json plugins must be an array');
  const manualPlugins = config.plugins.filter((entry) => !isGeneratedPlugin(entry));
  const generatedEntries = generatedPlugins.map(({ fileName, includes }) => ({
    path: `./${GENERATED_PLUGIN_PREFIX}${fileName}`,
    includes: [...includes],
  }));
  const nextPlugins = [...manualPlugins, ...generatedEntries];
  const { start, end, indent } = pluginsArraySpan(content);
  return `${content.slice(0, start)}${formatArray(nextPlugins, indent)}${content.slice(end)}`;
}
