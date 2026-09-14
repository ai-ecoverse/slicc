const LOGIN_DIP_ACTIONS = new Set(['oauth-attempt', 'connect-attempt', 'device-code-decision']);

export function isLoginDipAction(action: string): boolean {
  return LOGIN_DIP_ACTIONS.has(action);
}

const STYLE_ID = 'slicc-signin-redirect-style';
const CARD_CLASS = 'wc-signin-redirect';

export const WELCOME_HANDOFF_CARD_CLASS = `${CARD_CLASS}--welcome`;
const STYLE = `
.${CARD_CLASS}{display:flex;gap:10px;align-items:flex-start;margin:10px 12px;padding:12px 14px;
  border:1px solid var(--line);border-radius:12px;background:var(--ghost);color:var(--ink);
  font-family:var(--ui);font-size:13px;line-height:1.4;}
.${CARD_CLASS}__body{flex:1;min-width:0;}
.${CARD_CLASS}__title{font-weight:600;margin-bottom:2px;}
.${CARD_CLASS}__sub{color:var(--txt-2);}
.${CARD_CLASS}__open{appearance:none;border:1px solid var(--line);border-radius:8px;cursor:pointer;
  background:var(--canvas);color:var(--ink);font:inherit;font-weight:600;padding:6px 12px;white-space:nowrap;}
.${CARD_CLASS}__open:hover{background:var(--ghost);}
.${CARD_CLASS}__x{appearance:none;background:none;border:none;cursor:pointer;color:var(--txt-3);
  font:inherit;font-size:16px;line-height:1;padding:0 2px;}
.${CARD_CLASS}__x:hover{color:var(--ink);}
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  doc.head.appendChild(style);
}

export interface SignInRedirectOptions {
  onOpenTab: () => void;
}

interface RedirectCardContent {
  title: string;
  sub: string;
  buttonLabel: string;
  onOpenTab: () => void;

  dismissible: boolean;
}

function createRedirectCard(doc: Document, content: RedirectCardContent): HTMLElement {
  ensureStyle(doc);

  const card = doc.createElement('div');
  card.className = CARD_CLASS;
  card.setAttribute('role', 'status');

  const body = doc.createElement('div');
  body.className = `${CARD_CLASS}__body`;
  const title = doc.createElement('div');
  title.className = `${CARD_CLASS}__title`;
  title.textContent = content.title;
  const sub = doc.createElement('div');
  sub.className = `${CARD_CLASS}__sub`;
  sub.textContent = content.sub;
  body.append(title, sub);

  const open = doc.createElement('button');
  open.type = 'button';
  open.className = `${CARD_CLASS}__open`;
  open.textContent = content.buttonLabel;
  open.addEventListener('click', () => content.onOpenTab());

  card.append(body, open);

  if (content.dismissible) {
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = `${CARD_CLASS}__x`;
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => card.remove());
    card.append(dismiss);
  }
  return card;
}

export function showSignInRedirect(host: HTMLElement, opts: SignInRedirectOptions): HTMLElement {
  const doc = host.ownerDocument;

  opts.onOpenTab();

  const existing = host.querySelector<HTMLElement>(`.${CARD_CLASS}`);
  if (existing) {
    existing.scrollIntoView?.({ block: 'nearest' });
    return existing;
  }

  const card = createRedirectCard(doc, {
    title: 'Sign in from the SLICC tab',
    sub: "The side panel can't complete a provider login — we've switched you to the main SLICC tab. Finish signing in there (Settings › Providers), then come back.",
    buttonLabel: 'Open SLICC tab',
    onOpenTab: opts.onOpenTab,
    dismissible: true,
  });
  host.append(card);
  card.scrollIntoView?.({ block: 'nearest' });
  return card;
}

export function buildWelcomeHandoffCard(doc: Document, opts: SignInRedirectOptions): HTMLElement {
  const card = createRedirectCard(doc, {
    title: 'Set up SLICC in the main tab',
    sub: 'SLICC needs a model connected before it can help. Open the main SLICC tab to finish setup and sign in, then come back to the side panel.',
    buttonLabel: 'Open SLICC tab',
    onOpenTab: opts.onOpenTab,
    dismissible: false,
  });

  card.classList.add(WELCOME_HANDOFF_CARD_CLASS);
  return card;
}
