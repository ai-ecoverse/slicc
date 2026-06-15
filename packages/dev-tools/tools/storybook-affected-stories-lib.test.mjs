import { describe, expect, it } from 'vitest';
import {
  classifyChangedFile,
  resolveAffectedStories,
  screenshotFileName,
} from './storybook-affected-stories-lib.mjs';

/**
 * Small fixture mirroring the shape Storybook 10 emits in
 * `storybook-static/index.json`. importPath is package-relative with a `./`
 * prefix — verified against `packages/webcomponents/src/pill/slicc-pill.stories.ts`.
 */
const indexJson = {
  v: 5,
  entries: {
    'pill-pill--cone-open-idle': {
      id: 'pill-pill--cone-open-idle',
      title: 'Pill/Pill',
      name: 'Cone Open Idle',
      importPath: './src/pill/slicc-pill.stories.ts',
      type: 'story',
    },
    'pill-pill--scoop-open-idle': {
      id: 'pill-pill--scoop-open-idle',
      title: 'Pill/Pill',
      name: 'Scoop Open Idle',
      importPath: './src/pill/slicc-pill.stories.ts',
      type: 'story',
    },
    'pill-pill--docs': {
      id: 'pill-pill--docs',
      title: 'Pill/Pill',
      name: 'Docs',
      importPath: './src/pill/slicc-pill.stories.ts',
      type: 'docs',
    },
    'chat-agent-message--default': {
      id: 'chat-agent-message--default',
      title: 'Chat/Agent Message',
      name: 'Default',
      importPath: './src/chat/slicc-agent-message.stories.ts',
      type: 'story',
    },
    'chat-user-message--default': {
      id: 'chat-user-message--default',
      title: 'Chat/User Message',
      name: 'Default',
      importPath: './src/chat/slicc-user-message.stories.ts',
      type: 'story',
    },
    'theme-toggle--default': {
      id: 'theme-toggle--default',
      title: 'Theme/Toggle',
      name: 'Default',
      importPath: './src/theme/slicc-theme-toggle.stories.ts',
      type: 'story',
    },
  },
};

describe('classifyChangedFile', () => {
  it('classifies a source file under an area', () => {
    expect(classifyChangedFile('packages/webcomponents/src/pill/slicc-pill.ts')).toEqual({
      area: 'pill',
      isStoryFile: false,
      importPath: './src/pill/slicc-pill.ts',
    });
  });

  it('classifies a story file as a story file', () => {
    expect(classifyChangedFile('packages/webcomponents/src/pill/slicc-pill.stories.ts')).toEqual({
      area: 'pill',
      isStoryFile: true,
      importPath: './src/pill/slicc-pill.stories.ts',
    });
  });

  it('classifies a nested file as belonging to the top-level area', () => {
    expect(classifyChangedFile('packages/webcomponents/src/chat/parts/foo.ts')).toEqual({
      area: 'chat',
      isStoryFile: false,
      importPath: './src/chat/parts/foo.ts',
    });
  });

  it('returns null for files directly under src/ (no area)', () => {
    expect(classifyChangedFile('packages/webcomponents/src/index.ts')).toBeNull();
    expect(classifyChangedFile('packages/webcomponents/src/register.ts')).toBeNull();
  });

  it('returns null for files outside the webcomponents src tree', () => {
    expect(classifyChangedFile('packages/webcomponents/tests/pill/slicc-pill.test.ts')).toBeNull();
    expect(classifyChangedFile('packages/webcomponents/package.json')).toBeNull();
    expect(classifyChangedFile('packages/webapp/src/main.ts')).toBeNull();
    expect(classifyChangedFile('README.md')).toBeNull();
  });

  it('tolerates non-string input', () => {
    expect(classifyChangedFile(undefined)).toBeNull();
    expect(classifyChangedFile(null)).toBeNull();
    expect(classifyChangedFile(42)).toBeNull();
  });
});

describe('resolveAffectedStories', () => {
  it('source-file change selects every story in the area', () => {
    const result = resolveAffectedStories(
      ['packages/webcomponents/src/pill/slicc-pill.ts'],
      indexJson
    );
    expect(result.map((s) => s.storyId)).toEqual([
      'pill-pill--cone-open-idle',
      'pill-pill--scoop-open-idle',
    ]);
    expect(result[0].area).toBe('pill');
    expect(result[0].triggeredBy).toEqual(['packages/webcomponents/src/pill/slicc-pill.ts']);
  });

  it('story-file change selects only stories declared in that file', () => {
    const result = resolveAffectedStories(
      ['packages/webcomponents/src/chat/slicc-agent-message.stories.ts'],
      indexJson
    );
    // chat/ has two story files; only the changed one's stories should match.
    expect(result.map((s) => s.storyId)).toEqual(['chat-agent-message--default']);
  });

  it('non-webcomponents change produces no stories', () => {
    expect(
      resolveAffectedStories(
        ['packages/webapp/src/main.ts', 'README.md', '.github/workflows/ci.yml'],
        indexJson
      )
    ).toEqual([]);
  });

  it('multiple areas produces the union of affected stories', () => {
    const result = resolveAffectedStories(
      [
        'packages/webcomponents/src/pill/slicc-pill.ts',
        'packages/webcomponents/src/theme/slicc-theme.ts',
      ],
      indexJson
    );
    expect(result.map((s) => s.storyId)).toEqual([
      'pill-pill--cone-open-idle',
      'pill-pill--scoop-open-idle',
      'theme-toggle--default',
    ]);
  });

  it('skips docs entries — only renderable stories are returned', () => {
    const result = resolveAffectedStories(
      ['packages/webcomponents/src/pill/slicc-pill.stories.ts'],
      indexJson
    );
    expect(result.map((s) => s.storyId)).not.toContain('pill-pill--docs');
  });

  it('merges triggers when source AND story-file in the same area both change', () => {
    const result = resolveAffectedStories(
      [
        'packages/webcomponents/src/chat/slicc-agent-message.ts',
        'packages/webcomponents/src/chat/slicc-user-message.stories.ts',
      ],
      indexJson
    );
    // Source change selects every chat story; story-file change adds itself
    // to the trigger set for its own stories. Result is the union with merged
    // triggers, deterministically sorted.
    expect(result.map((s) => s.storyId)).toEqual([
      'chat-agent-message--default',
      'chat-user-message--default',
    ]);
    expect(result.find((s) => s.storyId === 'chat-user-message--default').triggeredBy).toEqual([
      'packages/webcomponents/src/chat/slicc-agent-message.ts',
      'packages/webcomponents/src/chat/slicc-user-message.stories.ts',
    ]);
  });

  it('tolerates an empty or missing changed-files list', () => {
    expect(resolveAffectedStories([], indexJson)).toEqual([]);
    expect(resolveAffectedStories(undefined, indexJson)).toEqual([]);
  });

  it('tolerates an empty index', () => {
    expect(
      resolveAffectedStories(['packages/webcomponents/src/pill/slicc-pill.ts'], {
        v: 5,
        entries: {},
      })
    ).toEqual([]);
  });
});

describe('screenshotFileName', () => {
  it('joins storyId and theme with a stable extension', () => {
    expect(screenshotFileName('pill-pill--cone-open-idle', 'light')).toBe(
      'pill-pill--cone-open-idle-light.png'
    );
    expect(screenshotFileName('pill-pill--cone-open-idle', 'dark')).toBe(
      'pill-pill--cone-open-idle-dark.png'
    );
  });
});
