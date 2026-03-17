// da.jsh — Adobe Document Authoring CLI
// Accepts full EDS URLs: https://main--repo--org.aem.page/path
// Auth via oauth-token adobe (user OAuth, no manual config needed)

const DA_ADMIN_BASE = 'https://admin.da.live';
const AEM_ADMIN_BASE = 'https://admin.hlx.page';

// ── URL Parsing ────────────────────────────────────────────────

function parseEdsUrl(url) {
  const m = url.match(/^https?:\/\/([^-]+)--([^-]+)--([^.]+)\.(aem|hlx)\.(page|live)\/?(.*)$/);
  if (!m) return null;
  return { ref: m[1], repo: m[2], org: m[3], path: m[6] || '' };
}

function resolveTarget(args) {
  // Find the first positional arg (not a flag)
  let urlOrPath = null;
  let org = null, repo = null, ref = 'main';
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--org' && args[i + 1]) { org = args[++i]; continue; }
    if (args[i] === '--repo' && args[i + 1]) { repo = args[++i]; continue; }
    if (args[i] === '--ref' && args[i + 1]) { ref = args[++i]; continue; }
    if (args[i] === '--output' || args[i] === '-o') { i++; continue; }
    if (!args[i].startsWith('--')) positional.push(args[i]);
  }

  urlOrPath = positional[0] || null;
  if (!urlOrPath) return null;

  // Try parsing as EDS URL
  const eds = parseEdsUrl(urlOrPath);
  if (eds) {
    return { org: eds.org, repo: eds.repo, ref: eds.ref, path: eds.path };
  }

  // Fall back to flags
  if (org && repo) {
    const path = urlOrPath.replace(/^\//, '');
    return { org, repo, ref, path };
  }

  return null;
}

function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return null;
}

// ── Auth ───────────────────────────────────────────────────────

async function getToken() {
  const r = await exec('oauth-token adobe');
  const token = r.stdout.trim();
  if (!token || r.exitCode !== 0) {
    process.stderr.write('da: not authenticated. Run: oauth-token adobe\n');
    process.exit(1);
  }
  return token;
}

// ── HTTP ───────────────────────────────────────────────────────

async function daFetch(method, url, token, extraArgs) {
  const args = [
    'curl', '-sS', '-X', method,
    '-H', `Authorization: Bearer ${token}`,
  ];
  if (extraArgs) args.push(...extraArgs);
  args.push(url);
  // Build command string with proper quoting
  const cmd = args.map(a => {
    if (a.includes(' ') || a.includes('"') || a.includes("'") || a.includes('(') || a.includes(')')) {
      return "'" + a.replace(/'/g, "'\\''") + "'";
    }
    return a;
  }).join(' ');
  const r = await exec(cmd);
  if (r.exitCode !== 0) {
    throw new Error(r.stderr || `HTTP ${method} failed`);
  }
  return r.stdout;
}

// ── Path normalization ─────────────────────────────────────────

function normalizeDaPath(pagePath) {
  let p = pagePath.replace(/^\//, '').replace(/\.html$/, '');
  if (p.endsWith('/')) p += 'index';
  return p + '.html';
}

// ── Subcommands ────────────────────────────────────────────────

async function cmdList(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: da list <eds-url-or-path> [--org <org> --repo <repo>]\n');
    process.exit(1);
  }
  const token = await getToken();
  const dirPath = target.path.replace(/\/$/, '');
  const url = `${DA_ADMIN_BASE}/list/${target.org}/${target.repo}/${dirPath}`;
  const body = await daFetch('GET', url, token);

  let entries;
  try { entries = JSON.parse(body); } catch { entries = []; }
  if (!Array.isArray(entries) || entries.length === 0) {
    process.stdout.write('(empty)\n');
    return;
  }
  for (const e of entries) {
    const type = e.ext ? e.ext : 'dir';
    process.stdout.write(`${type.padEnd(6)} ${e.path || e.name || ''}\n`);
  }
}

async function cmdGet(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: da get <eds-url-or-path> [--output <vfs-path>]\n');
    process.exit(1);
  }
  const token = await getToken();
  const path = normalizeDaPath(target.path);
  const url = `${DA_ADMIN_BASE}/source/${target.org}/${target.repo}/${path}`;
  const html = await daFetch('GET', url, token);

  const outputPath = getFlag(args, '--output') || getFlag(args, '-o');
  if (outputPath) {
    await fs.writeFile(outputPath, html);
    process.stdout.write(`Saved to ${outputPath} (${html.length} bytes)\n`);
  } else {
    process.stdout.write(html);
  }
}

async function cmdPut(args) {
  const target = resolveTarget(args);
  // Second positional arg is the VFS file
  const positional = args.filter(a => !a.startsWith('--'));
  const vfsFile = positional[1] || null;

  if (!target || !vfsFile) {
    process.stderr.write('Usage: da put <eds-url-or-path> <vfs-file>\n');
    process.exit(1);
  }

  const filePath = vfsFile.startsWith('/') ? vfsFile : process.cwd() + '/' + vfsFile;
  const html = await fs.readFile(filePath);
  const token = await getToken();
  const daPath = normalizeDaPath(target.path);
  const url = `${DA_ADMIN_BASE}/source/${target.org}/${target.repo}/${daPath}`;

  // Write HTML to a temp file, then use curl -F to upload
  const tmpPath = '/tmp/_da_put_' + Date.now() + '.html';
  await fs.writeFile(tmpPath, html);
  await daFetch('PUT', url, token, ['-F', `data=@${tmpPath};type=text/html`]);
  await fs.rm(tmpPath);

  process.stdout.write(`Saved: ${daPath}\n`);
}

async function cmdPreview(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: da preview <eds-url-or-path>\n');
    process.exit(1);
  }
  const token = await getToken();
  const path = target.path.replace(/^\//, '').replace(/\.html$/, '');
  const url = `${AEM_ADMIN_BASE}/preview/${target.org}/${target.repo}/${target.ref}/${path}`;
  const body = await daFetch('POST', url, token);

  let data;
  try { data = JSON.parse(body); } catch { data = {}; }
  const previewUrl = (data.preview && data.preview.url) ||
    `https://${target.ref}--${target.repo}--${target.org}.aem.page/${path}`;
  process.stdout.write(`Preview: ${previewUrl}\n`);
}

async function cmdPublish(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: da publish <eds-url-or-path>\n');
    process.exit(1);
  }
  const token = await getToken();
  const path = target.path.replace(/^\//, '').replace(/\.html$/, '');
  const url = `${AEM_ADMIN_BASE}/live/${target.org}/${target.repo}/${target.ref}/${path}`;
  const body = await daFetch('POST', url, token);

  let data;
  try { data = JSON.parse(body); } catch { data = {}; }
  const liveUrl = (data.live && data.live.url) ||
    `https://${target.ref}--${target.repo}--${target.org}.aem.live/${path}`;
  process.stdout.write(`Published: ${liveUrl}\n`);
}

async function cmdUpload(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const vfsFile = positional[0] || null;
  // The second positional is the EDS URL or DA path
  const targetArgs = positional.slice(1);

  if (!vfsFile || targetArgs.length === 0) {
    process.stderr.write('Usage: da upload <vfs-file> <eds-url-or-path>\n');
    process.exit(1);
  }

  const target = resolveTarget(targetArgs.concat(
    args.filter(a => a.startsWith('--'))
  ));
  if (!target) {
    process.stderr.write('Usage: da upload <vfs-file> <eds-url-or-path> [--org <org> --repo <repo>]\n');
    process.exit(1);
  }

  const filePath = vfsFile.startsWith('/') ? vfsFile : process.cwd() + '/' + vfsFile;
  const token = await getToken();
  const daPath = target.path.replace(/^\//, '');

  // Guess MIME type from extension
  const ext = filePath.split('.').pop().toLowerCase();
  const mimeMap = {
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
    'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp',
    'pdf': 'application/pdf', 'mp4': 'video/mp4',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  const url = `${DA_ADMIN_BASE}/source/${target.org}/${target.repo}/${daPath}`;
  await daFetch('PUT', url, token, ['-F', `data=@${filePath};type=${mime}`]);

  process.stdout.write(`Uploaded: ${filePath} -> ${daPath}\n`);
}

function cmdHelp() {
  process.stdout.write(`da -- Document Authoring CLI

Usage: da <command> <eds-url-or-path> [options]

All commands accept full EDS URLs:
  https://main--repo--org.aem.page/path
Or use --org/--repo flags with a plain path.

Commands:
  list <url>                  List pages in a DA directory
  get <url> [--output <path>] Get page HTML from DA
  put <url> <vfs-file>        Write HTML to DA (from VFS file)
  preview <url>               Trigger AEM preview
  publish <url>               Trigger AEM publish
  upload <vfs-file> <url>     Upload a VFS file to DA (media)
  help                        Show this help

Authentication:
  Uses oauth-token adobe (auto-triggers login if needed).
  No manual configuration required.

Examples:
  da list https://main--myrepo--myorg.aem.page/
  da get https://main--myrepo--myorg.aem.page/products/overview
  da get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
  da put https://main--myrepo--myorg.aem.page/page /workspace/page.html
  da preview https://main--myrepo--myorg.aem.page/page
  da publish https://main--myrepo--myorg.aem.page/page
  da upload /workspace/image.png https://main--myrepo--myorg.aem.page/media_123.png

  # Or with flags:
  da list /products --org myorg --repo myrepo
`);
}

// ── Main ───────────────────────────────────────────────────────

const args = process.argv.slice(1); // argv[0] is script name in jsh
const command = args[0] || 'help';
const subArgs = args.slice(1);

switch (command) {
  case 'list':
  case 'ls':
    await cmdList(subArgs);
    break;
  case 'get':
    await cmdGet(subArgs);
    break;
  case 'put':
    await cmdPut(subArgs);
    break;
  case 'preview':
    await cmdPreview(subArgs);
    break;
  case 'publish':
    await cmdPublish(subArgs);
    break;
  case 'upload':
    await cmdUpload(subArgs);
    break;
  case 'help':
  case '--help':
  case '-h':
    cmdHelp();
    break;
  default:
    process.stderr.write(`da: '${command}' is not a da command. See 'da help'.\n`);
    process.exit(1);
}
