export interface ConsentTool {
  name: string;
  description: string;
  cli: string;
}

export function renderConsentPage(options: {
  pendingId: string;
  generation: number;
  clientName: string;
  tools: ConsentTool[];
}): string {
  const groups = groupTools(options.tools);
  const lists = groups
    .map((group) => {
      const items = group.tools
        .map(
          (tool) => `<li><code>${escapeHtml(tool.name)}</code> ${escapeHtml(tool.description)}</li>`
        )
        .join('');
      return `<h2>${escapeHtml(group.cli)}</h2><ul>${items}</ul>`;
    })
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Allow MCP access</title>
</head>
<body>
<h1>Allow ${escapeHtml(options.clientName)} to call these tools?</h1>
<p>Accept lets this client run every CLI currently published, including each script's skill token and your signed-in browser tabs. <code>invoke</code> can run any argument the script accepts.</p>
${lists}
<form method="POST" action="/oauth/decision">
<input type="hidden" name="pending" value="${escapeHtml(options.pendingId)}">
<input type="hidden" name="generation" value="${options.generation}">
<button name="decision" value="accept">Accept</button>
<button name="decision" value="deny">Deny</button>
</form>
</body>
</html>
`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}

function groupTools(tools: ConsentTool[]): { cli: string; tools: ConsentTool[] }[] {
  const groups: { cli: string; tools: ConsentTool[] }[] = [];
  for (const tool of tools) {
    const existing = groups.find((group) => group.cli === tool.cli);
    if (existing) existing.tools.push(tool);
    else groups.push({ cli: tool.cli, tools: [tool] });
  }
  return groups;
}
