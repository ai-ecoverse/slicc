/**
 * Turn a cua-s1 plan into `playwright-cli` lines. Nothing here touches a tab.
 * The cone runs the lines after it has read the plan.
 */

export interface PlanEntity {
  label: string;
  value: string;
}

export interface PlanDecision {
  token: string;
  role: string;
  label: string;
  action: 'fill' | 'check' | 'click' | 'skip';
  probability: number;
  entityIndex: number | null;
}

export interface PrintedPlan {
  title: string;
  minConfidence: number;
  allowSubmit: boolean;
  entities: PlanEntity[];
  decisions: PlanDecision[];
  actions: PlanDecision[];
}

function shQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/.test(value)) return value === '' ? "''" : value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function fillValue(plan: PrintedPlan, decision: PlanDecision): string {
  if (decision.entityIndex === null) {
    throw new Error(`fill ${decision.token} has no entity`);
  }
  const entity = plan.entities[decision.entityIndex];
  if (!entity) throw new Error(`fill ${decision.token} points past the entity list`);
  return entity.value;
}

/** One shell line per ordered action. `tab` is the playwright target id. */
export function planToPlaywrightLines(plan: PrintedPlan, tab: string): string[] {
  const lines: string[] = [];
  for (const action of plan.actions) {
    const tabFlag = `--tab=${shQuote(tab)}`;
    const ref = shQuote(action.token);
    if (action.action === 'fill') {
      lines.push(`playwright-cli fill ${tabFlag} ${ref} ${shQuote(fillValue(plan, action))}`);
    } else if (action.action === 'check') {
      lines.push(`playwright-cli check ${tabFlag} ${ref}`);
    } else if (action.action === 'click') {
      lines.push(`playwright-cli click ${tabFlag} ${ref}`);
    }
  }
  return lines;
}

export function formatPlan(plan: PrintedPlan): string {
  const lines = [
    `title: ${plan.title || '(none)'}`,
    `min-confidence: ${plan.minConfidence}`,
    `allow-submit: ${plan.allowSubmit ? 'yes' : 'no'}`,
  ];
  for (const decision of plan.decisions) {
    const where = `${decision.token} ${decision.role} ${JSON.stringify(decision.label)}`;
    if (decision.action === 'fill') {
      const entity = plan.entities[decision.entityIndex ?? -1];
      const shown = entity ? `${entity.label}: ${entity.value}` : 'missing entity';
      lines.push(`fill ${where} ← ${shown}  p=${decision.probability.toFixed(2)}`);
    } else {
      lines.push(`${decision.action} ${where}  p=${decision.probability.toFixed(2)}`);
    }
  }
  if (plan.actions.length === 0) lines.push('(no action above the confidence bar)');
  return `${lines.join('\n')}\n`;
}

export function parsePrintedPlan(text: string): PrintedPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`plan is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('plan JSON must be an object');
  const plan = parsed as PrintedPlan;
  if (!Array.isArray(plan.actions) || !Array.isArray(plan.entities)) {
    throw new Error('plan JSON needs actions and entities arrays');
  }
  return plan;
}
