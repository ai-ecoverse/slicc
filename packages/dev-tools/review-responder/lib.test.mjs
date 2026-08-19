import { describe, expect, it } from 'vitest';
import {
  buildResponseMarker,
  DEFAULT_SELF_LOGIN,
  decideResponse,
  dropReason,
  formatDrops,
  formatFeedbackDigest,
  isSelfOutput,
  lastResponseAt,
  normalizeFeedback,
  parseRespondedShas,
  partitionFeedback,
  SUMMARY_MARKER,
} from './lib.mjs';

const REPO = 'ai-ecoverse/slicc';
const SELF = DEFAULT_SELF_LOGIN;

/** An in-scope, open, same-repo PR with one piece of foreign feedback. */
function baseInput(overrides = {}) {
  return {
    state: 'open',
    isDraft: false,
    headRefName: 'automation/boy-scout/sudo-fs',
    headRepoFullName: REPO,
    repoFullName: REPO,
    feedback: [{ author: 'chatgpt-codex-connector[bot]', createdAt: '2026-01-02T10:00:00Z' }],
    lastRespondedSha: null,
    headSha: 'abc1234def5678',
    lastResponseAt: null,
    ...overrides,
  };
}

describe('decideResponse', () => {
  it('responds when there is foreign feedback and no response yet', () => {
    const out = decideResponse(baseInput());
    expect(out.shouldRespond).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.reason).toMatch(/no response from us yet/i);
  });

  it('skips a PR that is not open', () => {
    const out = decideResponse(baseInput({ state: 'closed' }));
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toMatch(/not open/i);
    expect(out.items).toEqual([]);
  });

  it('skips when state is missing entirely', () => {
    expect(decideResponse({}).shouldRespond).toBe(false);
    expect(decideResponse().shouldRespond).toBe(false);
  });

  it('skips a draft PR', () => {
    const out = decideResponse(baseInput({ isDraft: true }));
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toMatch(/draft/i);
  });

  it('skips a fork head', () => {
    const out = decideResponse(baseInput({ headRepoFullName: 'someone/slicc' }));
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toContain('someone/slicc');
  });

  it('skips a deleted fork head (null head repo)', () => {
    const out = decideResponse(baseInput({ headRepoFullName: null }));
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toMatch(/deleted fork/i);
  });

  it('skips a head branch outside automation/', () => {
    const out = decideResponse(baseInput({ headRefName: 'feature/my-thing' }));
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toMatch(/not an automation\/\* branch/i);
  });

  it('skips when the only feedback is our own thread reply', () => {
    const out = decideResponse(
      baseInput({
        feedback: [
          { author: SELF, kind: 'inline', inReplyToId: 77, createdAt: '2026-01-02T10:00:00Z' },
        ],
      })
    );
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toMatch(/other than us/i);
  });

  it('skips when the only feedback is our own marker comment', () => {
    const out = decideResponse(
      baseInput({
        feedback: [
          {
            author: SELF,
            kind: 'top-level',
            body: buildResponseMarker('abc1234'),
            createdAt: '2026-01-02T10:00:00Z',
          },
        ],
      })
    );
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toMatch(/other than us/i);
  });

  it('RESPONDS to the house reviewer, which shares our login', () => {
    // `claude-pr-review.yml` posts its verdict as a top-level comment authored by
    // `github-actions[bot]` — our own login. An author-based loop guard would
    // discard it and make the whole workflow blind to the house reviewer.
    const out = decideResponse(
      baseInput({
        feedback: [
          {
            author: SELF,
            kind: 'top-level',
            body: 'Reviewed. The guard is in the wrong layer.',
            createdAt: '2026-01-02T10:00:00Z',
          },
        ],
      })
    );
    expect(out.shouldRespond).toBe(true);
    expect(out.items).toHaveLength(1);
  });

  it('skips when there is no feedback at all', () => {
    const out = decideResponse(baseInput({ feedback: [] }));
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toMatch(/other than us/i);
  });

  it('skips when we already responded at this SHA and nothing is newer', () => {
    const out = decideResponse(
      baseInput({
        lastRespondedSha: 'abc1234def5678',
        lastResponseAt: '2026-01-02T12:00:00Z',
      })
    );
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toMatch(/already responded at head SHA abc1234/i);
  });

  it('matches the responded SHA case-insensitively', () => {
    const out = decideResponse(
      baseInput({
        headSha: 'ABC1234DEF5678',
        lastRespondedSha: 'abc1234def5678',
        lastResponseAt: '2026-01-02T12:00:00Z',
      })
    );
    expect(out.shouldRespond).toBe(false);
  });

  it('responds again at the same SHA when a second round of comments arrived', () => {
    const out = decideResponse(
      baseInput({
        lastRespondedSha: 'abc1234def5678',
        lastResponseAt: '2026-01-02T12:00:00Z',
        feedback: [
          { author: 'copilot-pull-request-reviewer[bot]', createdAt: '2026-01-02T10:00:00Z' },
          { author: 'copilot-pull-request-reviewer[bot]', createdAt: '2026-01-02T13:00:00Z' },
        ],
      })
    );
    expect(out.shouldRespond).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].createdAt).toBe('2026-01-02T13:00:00Z');
    expect(out.reason).toMatch(/newer comment/i);
  });

  it('skips when the branch moved but every comment predates our last response', () => {
    const out = decideResponse(
      baseInput({
        headSha: 'newsha0000000',
        lastRespondedSha: null,
        lastResponseAt: '2026-01-02T12:00:00Z',
      })
    );
    expect(out.shouldRespond).toBe(false);
    expect(out.reason).toMatch(/predate our last response/i);
  });

  it('drops our own output from items even when it is the newest', () => {
    const out = decideResponse(
      baseInput({
        feedback: [
          { author: 'chatgpt-codex-connector[bot]', createdAt: '2026-01-02T10:00:00Z' },
          { author: SELF, kind: 'inline', inReplyToId: 5, createdAt: '2026-01-02T14:00:00Z' },
        ],
      })
    );
    expect(out.shouldRespond).toBe(true);
    expect(out.items.map((item) => item.author)).toEqual(['chatgpt-codex-connector[bot]']);
  });

  it('honours a custom selfLogin', () => {
    const out = decideResponse(
      baseInput({
        selfLogin: 'my-bot',
        feedback: [
          { author: 'my-bot', kind: 'inline', inReplyToId: 1, createdAt: '2026-01-02T10:00:00Z' },
        ],
      })
    );
    expect(out.shouldRespond).toBe(false);
  });

  it('tolerates a non-array feedback value', () => {
    const out = decideResponse(baseInput({ feedback: null }));
    expect(out.shouldRespond).toBe(false);
  });
});

describe('normalizeFeedback', () => {
  it('merges all three endpoints into one chronological list', () => {
    const items = normalizeFeedback({
      reviews: [
        {
          id: 1,
          user: { login: 'chatgpt-codex-connector[bot]' },
          submitted_at: '2026-01-02T11:00:00Z',
          state: 'changes_requested',
          body: 'This defeats the spelling-based debt gate.',
        },
      ],
      reviewComments: [
        {
          id: 2,
          user: { login: 'copilot-pull-request-reviewer[bot]' },
          created_at: '2026-01-02T10:00:00Z',
          body: 'Prefer a const here.',
          path: 'packages/webapp/src/fs/sudo-fs.ts',
          line: 42,
        },
      ],
      issueComments: [
        {
          id: 3,
          user: { login: SELF },
          created_at: '2026-01-02T12:00:00Z',
          body: 'Automated review summary from the house reviewer.',
        },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(['inline', 'review', 'top-level']);
    expect(items[0].path).toBe('packages/webapp/src/fs/sudo-fs.ts');
    expect(items[0].line).toBe(42);
    expect(items[1].state).toBe('CHANGES_REQUESTED');
  });

  it('sees a house-reviewer top-level comment as the ONLY feedback', () => {
    // Regression guard for the endpoint trap: `claude-pr-review.yml` posts its
    // verdict as a top-level ISSUE comment, so a scan that reads only
    // /pulls/{n}/reviews finds nothing at all.
    const items = normalizeFeedback({
      reviews: [],
      reviewComments: [],
      issueComments: [
        {
          id: 9,
          user: { login: 'some-human' },
          created_at: '2026-01-02T10:00:00Z',
          body: 'Overall this looks good but the guard is in the wrong layer.',
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('top-level');
    expect(items[0].author).toBe('some-human');
  });

  it('drops our own inline thread replies but keeps a foreign reply', () => {
    const items = normalizeFeedback({
      reviewComments: [
        {
          id: 1,
          user: { login: SELF },
          created_at: '2026-01-02T10:00:00Z',
          body: 'You are right, fixed in the next commit.',
          path: 'a.ts',
          line: 1,
          in_reply_to_id: 99,
        },
        {
          id: 2,
          user: { login: 'codex' },
          created_at: '2026-01-02T11:00:00Z',
          body: 'Still wrong, here is why.',
          path: 'a.ts',
          line: 1,
          in_reply_to_id: 99,
        },
      ],
    });
    expect(items.map((item) => item.author)).toEqual(['codex']);
  });

  it('keeps our own login when the comment opens a new inline thread', () => {
    // The house reviewer's inline comments come from the create_inline_comment
    // MCP tool, which opens a NEW thread — no `in_reply_to_id`. Only replies are
    // ours.
    const items = normalizeFeedback({
      reviewComments: [
        {
          id: 1,
          user: { login: SELF },
          created_at: '2026-01-02T10:00:00Z',
          body: 'This back-edge points up the layer stack.',
          path: 'a.ts',
          line: 1,
        },
      ],
    });
    expect(items).toHaveLength(1);
  });

  it('drops marker-bearing comments regardless of author', () => {
    const items = normalizeFeedback({
      issueComments: [
        {
          id: 1,
          user: { login: 'some-relay-bot' },
          created_at: '2026-01-02T10:00:00Z',
          body: `Responded.\n${buildResponseMarker('abc1234')}`,
        },
        {
          id: 2,
          user: { login: 'some-relay-bot' },
          created_at: '2026-01-02T10:01:00Z',
          body: `Mirrored crash notice.\n${SUMMARY_MARKER}`,
        },
      ],
    });
    expect(items).toEqual([]);
  });

  it('drops bodyless reviews (a bare APPROVED click is not feedback)', () => {
    const items = normalizeFeedback({
      reviews: [
        {
          id: 1,
          user: { login: 'a-human' },
          submitted_at: '2026-01-02T10:00:00Z',
          state: 'approved',
          body: '',
        },
        {
          id: 2,
          user: { login: 'a-human' },
          submitted_at: '2026-01-02T10:05:00Z',
          state: 'approved',
          body: null,
        },
      ],
    });
    expect(items).toEqual([]);
  });

  it('falls back to original_line for an outdated inline comment', () => {
    const [item] = normalizeFeedback({
      reviewComments: [
        {
          id: 1,
          user: { login: 'codex' },
          created_at: '2026-01-02T10:00:00Z',
          body: 'Outdated but still valid.',
          path: 'a.ts',
          line: null,
          original_line: 7,
        },
      ],
    });
    expect(item.line).toBe(7);
  });

  it('tolerates missing and non-array inputs', () => {
    expect(normalizeFeedback()).toEqual([]);
    expect(
      normalizeFeedback({ reviews: null, reviewComments: undefined, issueComments: 3 })
    ).toEqual([]);
  });
});

describe('isSelfOutput', () => {
  it('recognises both markers at any authorship', () => {
    expect(isSelfOutput({ author: 'anyone', body: buildResponseMarker('abc1234') })).toBe(true);
    expect(isSelfOutput({ author: 'anyone', body: `x ${SUMMARY_MARKER} y` })).toBe(true);
  });

  it('recognises our own inline thread reply', () => {
    expect(isSelfOutput({ author: SELF, kind: 'inline', inReplyToId: 1, body: 'ok' })).toBe(true);
  });

  it('does not claim a foreign reply, or our own new thread / review', () => {
    expect(isSelfOutput({ author: 'codex', kind: 'inline', inReplyToId: 1, body: 'x' })).toBe(
      false
    );
    expect(isSelfOutput({ author: SELF, kind: 'inline', body: 'x' })).toBe(false);
    expect(isSelfOutput({ author: SELF, kind: 'review', body: 'x' })).toBe(false);
    expect(isSelfOutput({ author: SELF, kind: 'top-level', body: 'x' })).toBe(false);
  });

  it('tolerates junk input', () => {
    expect(isSelfOutput(undefined)).toBe(false);
    expect(isSelfOutput({})).toBe(false);
  });
});

describe('lastResponseAt / parseRespondedShas', () => {
  const marked = (sha, at, login = SELF) => ({
    user: { login },
    created_at: at,
    body: `Answered the review.\n${buildResponseMarker(sha)}`,
  });

  it('returns the newest marker comment timestamp', () => {
    expect(
      lastResponseAt([
        marked('aaaaaaa', '2026-01-01T00:00:00Z'),
        marked('bbbbbbb', '2026-01-03T00:00:00Z'),
      ])
    ).toBe('2026-01-03T00:00:00Z');
  });

  it('ignores our own comments that carry no response marker', () => {
    // `github-actions[bot]` also posts pr-fix-dispatcher markers; using one of
    // those as the watermark would silently swallow earlier feedback.
    expect(
      lastResponseAt([
        {
          user: { login: SELF },
          created_at: '2026-01-05T00:00:00Z',
          body: '<!-- pr-fix-skip:abc1234 -->',
        },
      ])
    ).toBeNull();
  });

  it('ignores marker comments authored by someone else', () => {
    expect(lastResponseAt([marked('aaaaaaa', '2026-01-01T00:00:00Z', 'impostor')])).toBeNull();
  });

  it('returns null when there are no comments', () => {
    expect(lastResponseAt([])).toBeNull();
    expect(lastResponseAt()).toBeNull();
    expect(lastResponseAt(null)).toBeNull();
  });

  it('collects every responded SHA, lowercased', () => {
    const shas = parseRespondedShas([
      marked('ABC1234', '2026-01-01T00:00:00Z'),
      marked('def5678', '2026-01-02T00:00:00Z'),
    ]);
    expect([...shas].sort()).toEqual(['abc1234', 'def5678']);
  });

  it('returns an empty set for junk input', () => {
    expect(parseRespondedShas(null).size).toBe(0);
    expect(parseRespondedShas([{ body: 'no marker here' }]).size).toBe(0);
  });
});

describe('formatFeedbackDigest', () => {
  it('renders one line per item with location and state', () => {
    const digest = formatFeedbackDigest([
      { author: 'codex', kind: 'inline', path: 'a.ts', line: 3, body: 'wrong\nlayer' },
      { author: 'copilot', kind: 'review', state: 'CHANGES_REQUESTED', body: 'nope' },
    ]);
    expect(digest.split('\n')).toEqual([
      '• codex (inline) a.ts:3 — wrong layer',
      '• copilot (review [CHANGES_REQUESTED]) — nope',
    ]);
  });

  it('truncates long bodies and tolerates junk input', () => {
    const digest = formatFeedbackDigest(
      [{ author: 'a', kind: 'review', body: 'x'.repeat(500) }],
      10
    );
    expect(digest).toBe('• a (review) — xxxxxxxxxx');
    expect(formatFeedbackDigest()).toBe('');
    expect(formatFeedbackDigest(null)).toBe('');
  });
});

describe('feedback that is not feedback', () => {
  // The house reviewer shares our login, so the trigger gate cannot exclude that
  // author — which means our OTHER dispatchers' notes reach this module and have
  // to be filtered here, by marker, where a test can hold the rule down.
  it.each([
    ['pr-fix-dispatcher skip note', '🧊 skipping this one.\n<!-- pr-fix-skip:aa3647f -->'],
    ['backlog-dispatcher skip note', '**Not dispatching this one.**\n<!-- backlog-skip:2157 -->'],
  ])('drops the %s posted under our own login', (_label, body) => {
    expect(dropReason({ author: SELF, kind: 'top-level', body })).toMatch(/bookkeeping/);
  });

  it('drops those notes even when posted by someone else', () => {
    // The marker is the evidence, not the author: a relay or a human quoting the
    // note must not be able to make it look like feedback either.
    expect(
      dropReason({ author: 'someone', kind: 'top-level', body: '<!-- pr-fix-skip:abc1234 -->' })
    ).toMatch(/bookkeeping/);
  });

  it("drops Copilot's could-not-review notice, which is an error message shaped like a review", () => {
    // Observed live on #2179. Left in, it wakes the model to answer a quota error.
    const reason = dropReason({
      author: 'copilot-pull-request-reviewer[bot]',
      kind: 'review',
      state: 'COMMENTED',
      body: 'Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.',
    });
    expect(reason).toBe('Copilot could-not-review notice');
  });

  it('drops the semantic-release publication notice', () => {
    expect(
      dropReason({
        author: SELF,
        kind: 'top-level',
        body: '🎉 This PR is included in version 6.57.4 🎉',
      })
    ).toBe('semantic-release publication notice');
  });

  it('keeps a real Copilot review that happens to mention reviewing', () => {
    expect(
      dropReason({
        author: 'copilot-pull-request-reviewer[bot]',
        kind: 'review',
        body: 'I reviewed this and line 12 leaks a handle.',
      })
    ).toBeNull();
  });

  it('reports every drop with its reason instead of silently swallowing it', () => {
    // A filter that removes everything is indistinguishable from "no feedback
    // arrived" unless it says so — the failure mode that once disabled the
    // backlog dispatcher entirely.
    const { feedback, dropped } = partitionFeedback({
      issueComments: [
        {
          user: { login: SELF },
          body: '<!-- pr-fix-skip:aa3647f -->',
          created_at: '2026-08-19T01:00:00Z',
        },
        {
          user: { login: SELF },
          body: `answered\n${buildResponseMarker('abc1234')}`,
          created_at: '2026-08-19T02:00:00Z',
        },
      ],
      reviews: [
        {
          user: { login: 'copilot-pull-request-reviewer[bot]' },
          body: 'Copilot was unable to review this pull request because of quota.',
          submitted_at: '2026-08-19T03:00:00Z',
        },
      ],
    });
    expect(feedback).toEqual([]);
    expect(dropped).toHaveLength(3);
    const report = formatDrops(dropped);
    expect(report).toContain("the responder's own output");
    expect(report).toContain('bookkeeping');
    expect(report).toContain('Copilot could-not-review notice');
  });

  it('still answers the house reviewer, whose comment shares our login and carries no marker', () => {
    // The regression this whole section protects: the reviewer most specific to
    // this codebase posts a top-level comment as `github-actions[bot]`. If any
    // author-based rule creeps back in, this is what breaks, silently.
    const { feedback, dropped } = partitionFeedback({
      issueComments: [
        {
          user: { login: SELF },
          body: '### Review\n**One nit:** the PR description is stale.',
          created_at: '2026-08-19T03:24:00Z',
        },
      ],
    });
    expect(dropped).toEqual([]);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].body).toContain('stale');

    const decision = decideResponse({
      state: 'open',
      headRefName: 'automation/boy-scout/x',
      headRepoFullName: REPO,
      repoFullName: REPO,
      feedback,
      headSha: 'abc1234',
    });
    expect(decision.shouldRespond).toBe(true);
  });

  it('does not respond when a bookkeeping note is the only thing on the PR', () => {
    const decision = decideResponse({
      state: 'open',
      headRefName: 'automation/boy-scout/x',
      headRepoFullName: REPO,
      repoFullName: REPO,
      feedback: [{ author: SELF, kind: 'top-level', body: '<!-- pr-fix-skip:aa3647f -->' }],
      headSha: 'abc1234',
    });
    expect(decision.shouldRespond).toBe(false);
    expect(decision.reason).toMatch(/No review feedback/);
  });

  it('formatDrops tolerates junk and groups by reason', () => {
    expect(formatDrops()).toBe('');
    expect(formatDrops(null)).toBe('');
    const report = formatDrops([
      { item: { author: 'a' }, reason: 'same' },
      { item: { author: 'b' }, reason: 'same' },
    ]);
    expect(report.split('\n')).toHaveLength(1);
    expect(report).toContain('2 × same');
    expect(report).toContain('a, b');
  });

  it('normalizeFeedback stays the drop-filtered view of partitionFeedback', () => {
    const input = {
      issueComments: [
        { user: { login: 'human' }, body: 'real feedback', created_at: '2026-08-19T01:00:00Z' },
        {
          user: { login: SELF },
          body: '<!-- backlog-skip:1 -->',
          created_at: '2026-08-19T02:00:00Z',
        },
      ],
    };
    expect(normalizeFeedback(input)).toEqual(partitionFeedback(input).feedback);
    expect(normalizeFeedback(input)).toHaveLength(1);
  });
});
