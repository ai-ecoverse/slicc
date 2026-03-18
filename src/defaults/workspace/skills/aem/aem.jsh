// aem.jsh — AEM Edge Delivery Services CLI
// Accepts full EDS URLs: https://main--repo--org.aem.page/path
// Auth via oauth-token adobe (user OAuth, no manual config needed)

const DA_ADMIN_BASE = 'https://admin.da.live';
const AEM_ADMIN_BASE = 'https://admin.hlx.page';

// ── URL Parsing ────────────────────────────────────────────────

function parseAemUrl(url) {
  const m = url.match(/^https?:\/\/(.+?)--(.+?)--([^.]+)\.(aem|hlx)\.(page|live)\/?(.*)$/);
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
  const eds = parseAemUrl(urlOrPath);
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
    process.stderr.write('aem: not authenticated. Run: oauth-token adobe\n');
    process.exit(1);
  }
  return token;
}

// ── HTTP ───────────────────────────────────────────────────────

function shellQuote(a) {
  if (/[^a-zA-Z0-9_.\/:\-=]/.test(a)) {
    return "'" + a.replace(/'/g, "'\\''") + "'";
  }
  return a;
}

async function aemFetch(method, url, token, extraArgs) {
  const args = [
    'curl', '-sS', '-X', method,
    '-H', `Authorization: Bearer ${token}`,
  ];
  if (extraArgs) args.push(...extraArgs);
  args.push(url);
  const cmd = args.map(shellQuote).join(' ');
  const r = await exec(cmd);
  const body = r.stdout;
  // Check auth errors BEFORE exit code — curl returns 0 on HTTP 401
  if (body && (body.includes('"status":401') || body.includes('"status":403') ||
      body.includes('401 Unauthorized') || body.includes('Forbidden'))) {
    process.stderr.write('aem: authentication failed (token may be expired). Run: oauth-token adobe\n');
    process.exit(1);
  }
  if (r.exitCode !== 0) {
    throw new Error(r.stderr || body || `HTTP ${method} failed`);
  }
  return body;
}

// ── Path normalization ─────────────────────────────────────────

function normalizeAemPath(pagePath) {
  let p = pagePath.replace(/^\//, '').replace(/\.html$/, '');
  if (p.endsWith('/')) p += 'index';
  return p + '.html';
}

// ── Subcommands ────────────────────────────────────────────────

async function cmdList(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: aem list <eds-url-or-path> [--org <org> --repo <repo>]\n');
    process.exit(1);
  }
  const token = await getToken();
  const dirPath = target.path.replace(/\/$/, '');
  const url = `${DA_ADMIN_BASE}/list/${target.org}/${target.repo}/${dirPath}`;
  const body = await aemFetch('GET', url, token);

  let entries;
  try { entries = JSON.parse(body); } catch {
    process.stderr.write(`aem: unexpected response from API: ${body.slice(0, 200)}\n`);
    process.exit(1);
  }
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
    process.stderr.write('Usage: aem get <eds-url-or-path> [--output <vfs-path>]\n');
    process.exit(1);
  }
  const token = await getToken();
  const path = normalizeAemPath(target.path);
  const url = `${DA_ADMIN_BASE}/source/${target.org}/${target.repo}/${path}`;
  const html = await aemFetch('GET', url, token);

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
    process.stderr.write('Usage: aem put <eds-url-or-path> <vfs-file>\n');
    process.exit(1);
  }

  const filePath = vfsFile.startsWith('/') ? vfsFile : process.cwd() + '/' + vfsFile;
  const html = await fs.readFile(filePath);
  const token = await getToken();
  const aemPath = normalizeAemPath(target.path);
  const url = `${DA_ADMIN_BASE}/source/${target.org}/${target.repo}/${aemPath}`;

  // Write HTML to a temp file, then use curl -F to upload
  const tmpPath = process.cwd() + '/_aem_put_' + Date.now() + '.html';
  await fs.writeFile(tmpPath, html);
  await aemFetch('PUT', url, token, ['-F', `data=@${tmpPath};type=text/html`]);
  await fs.rm(tmpPath);

  process.stdout.write(`Saved: ${aemPath}\n`);
}

async function cmdPreview(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: aem preview <eds-url-or-path>\n');
    process.exit(1);
  }
  const token = await getToken();
  const path = target.path.replace(/^\//, '').replace(/\.html$/, '');
  const url = `${AEM_ADMIN_BASE}/preview/${target.org}/${target.repo}/${target.ref}/${path}`;
  const body = await aemFetch('POST', url, token);

  let data;
  try { data = JSON.parse(body); } catch {
    process.stderr.write(`aem: unexpected response from preview API: ${body.slice(0, 200)}\n`);
    process.exit(1);
  }
  const previewUrl = (data.preview && data.preview.url) ||
    `https://${target.ref}--${target.repo}--${target.org}.aem.page/${path}`;
  process.stdout.write(`Preview: ${previewUrl}\n`);
}

async function cmdPublish(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: aem publish <eds-url-or-path>\n');
    process.exit(1);
  }
  const token = await getToken();
  const path = target.path.replace(/^\//, '').replace(/\.html$/, '');
  const url = `${AEM_ADMIN_BASE}/live/${target.org}/${target.repo}/${target.ref}/${path}`;
  const body = await aemFetch('POST', url, token);

  let data;
  try { data = JSON.parse(body); } catch {
    process.stderr.write(`aem: unexpected response from publish API: ${body.slice(0, 200)}\n`);
    process.exit(1);
  }
  const liveUrl = (data.live && data.live.url) ||
    `https://${target.ref}--${target.repo}--${target.org}.aem.live/${path}`;
  process.stdout.write(`Published: ${liveUrl}\n`);
}

async function cmdUpload(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const vfsFile = positional[0] || null;
  // The second positional is the EDS URL or path
  const targetArgs = positional.slice(1);

  if (!vfsFile || targetArgs.length === 0) {
    process.stderr.write('Usage: aem upload <vfs-file> <eds-url-or-path>\n');
    process.exit(1);
  }

  const target = resolveTarget(targetArgs.concat(
    args.filter(a => a.startsWith('--'))
  ));
  if (!target) {
    process.stderr.write('Usage: aem upload <vfs-file> <eds-url-or-path> [--org <org> --repo <repo>]\n');
    process.exit(1);
  }

  const filePath = vfsFile.startsWith('/') ? vfsFile : process.cwd() + '/' + vfsFile;
  const token = await getToken();
  const aemPath = target.path.replace(/^\//, '');

  // Guess MIME type from extension
  const ext = filePath.split('.').pop().toLowerCase();
  const mimeMap = {
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
    'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp',
    'pdf': 'application/pdf', 'mp4': 'video/mp4',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  const url = `${DA_ADMIN_BASE}/source/${target.org}/${target.repo}/${aemPath}`;
  await aemFetch('PUT', url, token, ['-F', `data=@${filePath};type=${mime}`]);

  process.stdout.write(`Uploaded: ${filePath} -> ${aemPath}\n`);
}

function cmdHelp() {
  process.stdout.write(`aem -- AEM Edge Delivery Services CLI

Usage: aem <command> <eds-url-or-path> [options]

All commands accept full EDS URLs:
  https://main--repo--org.aem.page/path
Or use --org/--repo flags with a plain path.

Commands:
  list <url>                  List pages in a directory
  get <url> [--output <path>] Get page HTML
  put <url> <vfs-file>        Write HTML (from VFS file)
  preview <url>               Trigger AEM preview
  publish <url>               Trigger AEM publish
  upload <vfs-file> <url>     Upload a VFS file (media)
  help                        Show this help

Authentication:
  Uses oauth-token adobe (auto-triggers login if needed).
  No manual configuration required.

Examples:
  aem list https://main--myrepo--myorg.aem.page/
  aem get https://main--myrepo--myorg.aem.page/products/overview
  aem get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
  aem put https://main--myrepo--myorg.aem.page/page /workspace/page.html
  aem preview https://main--myrepo--myorg.aem.page/page
  aem publish https://main--myrepo--myorg.aem.page/page
  aem upload /workspace/image.png https://main--myrepo--myorg.aem.page/media_123.png

  # Or with flags:
  aem list /products --org myorg --repo myrepo
`);
}

// ── Main ───────────────────────────────────────────────────────

const args = process.argv.slice(2); // argv[0] is interpreter, argv[1] is script path
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
    process.stderr.write(`aem: '${command}' is not an aem command. See 'aem help'.\n`);
    process.exit(1);
}
