/**
 * Generate scoop creation configs for page migration.
 *
 * Usage (in slicc JavaScript tool):
 *   const configs = generateScoopConfigs(decomposition, headHtml, sourceUrl, projectPath);
 *   // Returns array of { name, model, prompt } ready for scoop_scoop
 *
 * @param {object} decomposition - The decomposition.json content (parsed)
 * @param {string} headHtml - The full content of head.html
 * @param {string} sourceUrl - The source page URL
 * @param {string} projectPath - The EDS project path in VFS (e.g., "/shared/vibemigrated")
 * @returns {Array<{name: string, model: string, prompt: string}>}
 */
function generateScoopConfigs(decomposition, headHtml, sourceUrl, projectPath) {
  const configs = [];

  for (const fragment of decomposition.fragments) {
    for (const child of fragment.children || []) {
      if (child.type === 'default-content') continue;

      const blocks = child.type === 'section'
        ? (child.children || []).filter(c => c.type === 'block')
        : [child];

      for (const block of blocks) {
        const isHeader = block.name === 'nav-bar' || block.name === 'header'
          || block.name === 'navigation' || fragment.path === '/nav';
        const isFooter = block.name === 'footer' || block.name === 'footer-links'
          || block.name === 'footer-content' || fragment.path === '/footer';

        const scoopName = block.name + '-block';
        const bounds = block.bounds
          ? `x=${block.bounds.x}, y=${block.bounds.y}, width=${block.bounds.width}, height=${block.bounds.height}`
          : 'unknown';

        let prompt;

        if (isHeader) {
          prompt = buildHeaderPrompt(block, sourceUrl, projectPath, bounds, headHtml);
        } else if (isFooter) {
          prompt = buildFooterPrompt(block, sourceUrl, projectPath, bounds, headHtml);
        } else {
          prompt = buildBlockPrompt(block, sourceUrl, projectPath, bounds, headHtml);
        }

        configs.push({
          name: scoopName,
          model: 'claude-sonnet-4-6',
          prompt,
        });
      }
    }
  }

  return configs;
}

function buildBlockPrompt(block, sourceUrl, projectPath, bounds, headHtml) {
  return `You are migrating a single block to EDS.

## Parameters
- Block name: ${block.name}
- Source URL: ${sourceUrl}
- Visual tree ID: ${block.id || 'unknown'}
- Bounds: ${bounds}
- EDS project: ${projectPath}
- Notes: ${block.notes || block.style || ''}

## head.html Content
${headHtml}

## Instructions
Read and execute the migrate-block skill at your workspace:
Read the skill file first, then follow every step exactly.
Your preview MUST use head.html content.
Do NOT inline CSS or JS as a substitute for the EDS framework.`;
}

function buildHeaderPrompt(block, sourceUrl, projectPath, bounds, headHtml) {
  return `You are migrating the website header/navigation to EDS.

## Parameters
- Source URL: ${sourceUrl}
- EDS project: ${projectPath}
- Bounds: ${bounds}
- Notes: ${block.notes || block.style || ''}

## head.html Content
${headHtml}

## Instructions
Read and execute the migrate-header skill at your workspace.
This is a HEADER migration, not a regular block. Follow the header skill
exactly — it handles nav.plain.html generation, section-metadata styles,
dropdown detection, and header-specific CSS patterns.`;
}

function buildFooterPrompt(block, sourceUrl, projectPath, bounds, headHtml) {
  return `You are migrating a single block to EDS.

## Parameters
- Block name: ${block.name}
- Source URL: ${sourceUrl}
- Visual tree ID: ${block.id || 'unknown'}
- Bounds: ${bounds}
- EDS project: ${projectPath}
- Special: This is the FOOTER block. Output footer.plain.html, not ${block.name}.plain.html. See "Footer Block — Special Case" in the migrate-block skill.
- Notes: ${block.notes || block.style || ''}

## head.html Content
${headHtml}

## Instructions
Read and execute the migrate-block skill at your workspace.
Follow every step exactly. Your preview MUST use head.html content.
Do NOT inline CSS or JS as a substitute for the EDS framework.`;
}

// Export for use in slicc's JavaScript tool
if (typeof module !== 'undefined') module.exports = { generateScoopConfigs };
