/**
 * Onboarding intro messages — deterministic-but-varied lines that
 * the webapp posts into the chat directly after the welcome wizard
 * finishes. There is NO LLM involvement here; the messages are
 * picked from a small set of stubs and combined so the flow feels
 * alive without being dependent on a configured model.
 *
 * Three lines are produced per onboarding session:
 *
 *   1. Greeting     — uses the user's name when given, otherwise
 *                     riffs on the user's choice to stay anonymous
 *                     and reminds them they can change their mind.
 *   2. Capability   — "I am sliccy. I can <role-flavoured pitch>.
 *                     I am an AI agent."
 *   3. AI confession — "But to be honest, I'm not really an AI yet.
 *                     You'll need to help me become intelligent."
 *
 * Each line is independently shuffled from a stub bag, so two
 * onboarding runs with the same profile will frequently produce a
 * different mix while staying on-brand. The `random` argument is
 * injectable so tests can pin the output.
 */

export interface OnboardingProfile {
  name?: string;
  purpose?: string;
  role?: string;
  tasks?: string[];
  apps?: string[];
  company?: string;
}

export type RandomFn = () => number;

const NAMED_GREETINGS: ReadonlyArray<(name: string) => string> = [
  (n) => `Nice to meet you, ${n}.`,
  (n) => `Hello ${n} — glad you stopped by.`,
  (n) => `Hey ${n}, welcome aboard.`,
  (n) => `${n}! Pleasure to make your acquaintance.`,
];

const ANON_GREETINGS: ReadonlyArray<string> = [
  "Nice to meet you, mysterious stranger — I'll respect the incognito.",
  'Hello, anonymous traveler. You can always tell me your name later if you change your mind.',
  "An unnamed visitor — intriguing. Whenever you'd like to introduce yourself, just say the word.",
  "Hey there, ghost — happy to keep things first-name-optional. The door's always open if you decide to drop the cloak.",
];

const PURPOSE_RIFFS: Record<string, ReadonlyArray<string>> = {
  work: ["Work mode — let's make today productive.", "On the clock? Same. Let's chip away at it."],
  school: [
    'School business — I love a good study session.',
    'Hitting the books? Glad to ride along.',
  ],
  personal: [
    'Personal project energy is the best kind.',
    'Tinkering for yourself is how the good stuff happens.',
  ],
  'side-project': ['Side projects keep the lights on creatively.', 'Two-job life — respect.'],
  exploring: [
    'Just poking around? Excellent. The best discoveries start there.',
    'Exploration mode — no agenda, no pressure.',
  ],
};

const ROLE_PITCHES: Record<string, ReadonlyArray<string>> = {
  developer: [
    'I can write code, run shell commands, drive a real browser, and ship pages.',
    'Code, terminals, browsers, repos — I live in all of them.',
  ],
  designer: [
    'I can prototype layouts, generate assets, and walk page editors with you.',
    'Pixels, components, screenshots — design ops are my jam.',
  ],
  'content-creator': [
    'I can draft copy, edit, scrape references, and stitch publish-ready pages.',
    "Words, structure, SEO, polish — say the topic and I'll get moving.",
  ],
  marketer: [
    'I can audit funnels, scrape competitors, and stand up landing pages quickly.',
    "Campaigns, analytics, creatives — plug me in and I'll go.",
  ],
  'product-pm': [
    'I can summarise research, draft specs, and crunch competitive intel.',
    'Briefs, roadmaps, comparisons — I take the boring half off your plate.',
  ],
  founder: [
    'I can prototype landing pages, automate ops, and prep investor decks.',
    "Idea → MVP → repeat. I'll do the legwork between coffee refills.",
  ],
  student: [
    'I can read papers with you, draft notes, and turn lectures into outlines.',
    'Studying together makes it bearable — let me handle the busywork.',
  ],
  researcher: [
    'I can scrape sources, summarise findings, and keep a running bibliography.',
    "Lit reviews, datasets, write-ups — I'm all in.",
  ],
  other: [
    "I'm flexible — give me a task and I'll figure out the right tools.",
    "Whatever the role, I can probably help. Tell me what's on the docket.",
  ],
};

const ROLE_PITCH_DEFAULT: ReadonlyArray<string> = [
  'I can browse the web, run commands, write code, and automate the boring parts.',
  "I'm comfortable with terminals, browsers, files, and a long backlog of skills.",
];

const CONFESSIONS: ReadonlyArray<string> = [
  "But to be honest, I'm not really an AI yet — I'm an empty shell. You'll need to help me become intelligent. Pick a model and I'll wake up:",
  "Confession time: I can't actually think yet. Wire me up to an LLM and I'll start earning my keep:",
  "Plot twist — there's no brain in here. Choose a provider so I can do more than read this script:",
  "Truthfully? I'm a very polite placeholder until you give me a model. Help me out:",
];

/** Picks a random element from the array using `rand`. */
function pick<T>(arr: ReadonlyArray<T>, rand: RandomFn): T {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

/** Title-case a tasks identifier for prose ("build-websites" → "build websites"). */
function humaniseTask(taskId: string): string {
  return taskId.replace(/-/g, ' ');
}

/** Format an Oxford-comma list of up to three items. */
function listSentence(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(', ')}, and ${last}`;
}

/**
 * Build the greeting line. With a name we mostly stick to a personal
 * greeting plus an optional purpose riff; without one we lean into
 * the anonymous angle.
 */
export function buildGreeting(profile: OnboardingProfile, rand: RandomFn = Math.random): string {
  const name = (profile.name || '').trim();
  const purposeRiffs = profile.purpose ? PURPOSE_RIFFS[profile.purpose] : undefined;

  if (name) {
    const greeting = pick(NAMED_GREETINGS, rand)(name);
    const riff = purposeRiffs ? ` ${pick(purposeRiffs, rand)}` : '';
    return `${greeting}${riff}`;
  }

  const greeting = pick(ANON_GREETINGS, rand);
  const riff = purposeRiffs ? ` ${pick(purposeRiffs, rand)}` : '';
  return `${greeting}${riff}`;
}

/** Build the capability/identity line. */
export function buildCapabilityLine(
  profile: OnboardingProfile,
  rand: RandomFn = Math.random
): string {
  const role = profile.role && ROLE_PITCHES[profile.role] ? profile.role : '';
  const pitchBag = role ? ROLE_PITCHES[role] : ROLE_PITCH_DEFAULT;
  const pitch = pick(pitchBag, rand);

  const tasks = (profile.tasks ?? []).slice(0, 3).map(humaniseTask);
  const tasksClause = tasks.length > 0 ? ` Especially handy for ${listSentence(tasks)}.` : '';

  return `I'm sliccy. ${pitch}${tasksClause} I'm an AI agent.`;
}

/** Build the confession line that leads into the provider picker. */
export function buildConfession(_profile: OnboardingProfile, rand: RandomFn = Math.random): string {
  return pick(CONFESSIONS, rand);
}

/** Convenience: produce all three intro lines as an ordered array. */
export function buildIntroMessages(
  profile: OnboardingProfile,
  rand: RandomFn = Math.random
): string[] {
  return [
    buildGreeting(profile, rand),
    buildCapabilityLine(profile, rand),
    buildConfession(profile, rand),
  ];
}

/** Test-only — surface the stub bags for assertions. */
export const __test__ = {
  NAMED_GREETINGS,
  ANON_GREETINGS,
  PURPOSE_RIFFS,
  ROLE_PITCHES,
  ROLE_PITCH_DEFAULT,
  CONFESSIONS,
  pick,
  humaniseTask,
  listSentence,
};
