/**
 * Side-panel follower login redirect.
 *
 * The extension side-panel follower is a cross-origin iframe where a real
 * login can't complete: the welcome dip's provider connect + the session-
 * expired card both drive OAuth / device-code / provider-settings, which run
 * on the LEADER (a `window.open`/OAuth surface the panel iframe doesn't have).
 * So when the user triggers a login/auth action in the panel, we don't try to
 * run it there — we focus/open the SLICC leader tab (where the real login UI
 * lives) and surface a small "sign in from the SLICC tab" card so a side-panel-
 * only user knows where to go instead of giving up.
 */

/**
 * The dip lick actions the welcome onboarding dip (`connect-llm.shtml`) emits
 * when the user tries to connect a provider — none of which can complete in the
 * panel iframe (they run OAuth / device-code / provider-settings on the leader).
 */
const LOGIN_DIP_ACTIONS = new Set(['oauth-attempt', 'connect-attempt', 'device-code-decision']);

/** True when a dip lick action is a provider-login attempt that must run on the leader. */
export function isLoginDipAction(action: string): boolean {
  return LOGIN_DIP_ACTIONS.has(action);
}

const STYLE_ID = 'slicc-signin-redirect-style';
const CARD_CLASS = 'wc-signin-redirect';
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
  /** Focus/open the SLICC leader tab (where the real login UI lives). */
  onOpenTab: () => void;
}

interface RedirectCardContent {
  title: string;
  sub: string;
  buttonLabel: string;
  onOpenTab: () => void;
  /** Add an `×` dismiss button. The bottom-of-thread login card is dismissible;
   *  the in-place welcome hand-off card is not (dismissing would leave nothing). */
  dismissible: boolean;
}

/** Build a redirect card element (styles ensured, listeners wired, NOT attached). */
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

/**
 * Show (or reuse) the "sign in from the SLICC tab" card at the BOTTOM of `host`
 * (the chat thread), scrolled into view, and immediately focus the leader tab.
 * The card is appended — NOT prepended — because the thread is usually scrolled
 * to the latest message, so a card at the top would sit off-screen (the user
 * clicked a button and would see nothing). Idempotent: repeated calls reuse the
 * one card (and re-scroll it into view) rather than stacking duplicates.
 */
export function showSignInRedirect(host: HTMLElement, opts: SignInRedirectOptions): HTMLElement {
  const doc = host.ownerDocument;

  // Focus the leader tab up front — the login UI lives there.
  opts.onOpenTab();

  const existing = host.querySelector<HTMLElement>(`.${CARD_CLASS}`);
  if (existing) {
    // Already shown — bring it back into view (the user re-triggered it).
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

/**
 * Build the in-place "set up SLICC in the main tab" hand-off card that REPLACES
 * an onboarding welcome dip in the extension side-panel follower. The welcome /
 * connect-llm dips drive profile collection + provider connect, both of which
 * need the leader (no LLM is connected follower-side, and OAuth can't run in the
 * cross-origin panel iframe). Unlike {@link showSignInRedirect}, this does NOT
 * focus the tab on render — the user hasn't acted yet; the leader tab is only
 * focused when they click the button.
 */
export function buildWelcomeHandoffCard(doc: Document, opts: SignInRedirectOptions): HTMLElement {
  return createRedirectCard(doc, {
    title: 'Set up SLICC in the main tab',
    sub: 'SLICC needs a model connected before it can help. Open the main SLICC tab to finish setup and sign in, then come back to the side panel.',
    buttonLabel: 'Open SLICC tab',
    onOpenTab: opts.onOpenTab,
    dismissible: false,
  });
}
