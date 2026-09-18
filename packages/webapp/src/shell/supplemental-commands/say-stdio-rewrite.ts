import type { SimpleCommandNode, TransformPlugin, WordNode } from 'just-bash';

function wordLiteral(word: WordNode | null | undefined): string | null {
  const parts = word?.parts;
  if (parts?.length !== 1 || parts[0]?.type !== 'Literal') return null;
  return parts[0].value ?? null;
}

function flagWord(value: string): WordNode {
  return { type: 'Word', parts: [{ type: 'Literal', value }] };
}

function hasOutFlag(cmd: SimpleCommandNode): boolean {
  for (const arg of cmd.args) {
    const v = wordLiteral(arg);
    if (v === '-o' || v === '--out') return true;
  }
  return false;
}

function hasStdoutRedirect(cmd: SimpleCommandNode): boolean {
  for (const r of cmd.redirections) {
    const op = r.operator;
    const fd = r.fd;
    if (op === '&>' || op === '&>>') return true;
    if ((op === '>' || op === '>>' || op === '>|') && (fd == null || fd === 1)) return true;
  }
  return false;
}

function injectDashO(cmd: SimpleCommandNode): void {
  if (wordLiteral(cmd.name) !== 'say' || hasOutFlag(cmd)) return;
  cmd.args = [flagWord('-o'), flagWord('-'), ...cmd.args];
}

function visit(node: unknown, inCapture: boolean): void {
  if (Array.isArray(node)) {
    for (const item of node) visit(item, inCapture);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const n = node as {
    type?: string;
    commands?: unknown[];
    body?: unknown;
  };
  if (n.type === 'Pipeline' && Array.isArray(n.commands)) {
    const cmds = n.commands;
    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i] as { type?: string } | undefined;
      const piped = cmds.length > 1 && i < cmds.length - 1;
      const capture =
        inCapture ||
        piped ||
        (cmd?.type === 'SimpleCommand' && hasStdoutRedirect(cmd as SimpleCommandNode));
      if (cmd?.type === 'SimpleCommand' && capture) {
        injectDashO(cmd as SimpleCommandNode);
      }
      visit(cmd, capture);
    }
    return;
  }
  if (n.type === 'CommandSubstitution' || n.type === 'ProcessSubstitution') {
    visit(n.body, true);
    return;
  }
  for (const value of Object.values(n)) visit(value, inCapture);
}

export const sayStdioPlugin: TransformPlugin = {
  name: 'say-stdio',
  transform(context) {
    visit(context.ast, false);
    return { ast: context.ast };
  },
};
