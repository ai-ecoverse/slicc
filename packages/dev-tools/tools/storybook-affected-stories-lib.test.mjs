import { describe, expect, it } from 'vitest';
import {
  classifyChangedFile,
  resolveAffectedStories,
  screenshotFileName,
} from './storybook-affected-stories-lib.mjs';

/**
 * Small fixture mirroring the shape Storybook 10 emits in
 * `storybook-static/index.json`. importPath is package-relative with a `./`
 * prefix — verified against the agent-tabs Storybook entry.
 */
const indexJson = {
  v: 5,
  entries: {
    'switcher-agenttabs--default': {
      id: 'switcher-agenttabs--default',
      title: 'Switcher/AgentTabs',
      name: 'Default',
      importPath: './src/switcher/slicc-agent-tabs.stories.ts',
      type: 'story',
    },
    'switcher-agenttabs--cone-focused': {
      id: 'switcher-agenttabs--cone-focused',
      title: 'Switcher/AgentTabs',
      name: 'Cone Focused',
      importPath: './src/switcher/slicc-agent-tabs.stories.ts',
      type: 'story',
    },
    'switcher-agenttabs--docs': {
      id: 'switcher-agenttabs--docs',
      title: 'Switcher/AgentTabs',
      name: 'Docs',
      importPath: './src/switcher/slicc-agent-tabs.stories.ts',
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
    expect(classifyChangedFile('packages/webcomponents/src/switcher/slicc-agent-tabs.ts')).toEqual({
      area: 'switcher',
      isStoryFile: false,
      importPath: './src/switcher/slicc-agent-tabs.ts',
    });
  });

  it('classifies a story file as a story file', () => {
    expect(
      classifyChangedFile('packages/webcomponents/src/switcher/slicc-agent-tabs.stories.ts')
    ).toEqual({
      area: 'switcher',
      isStoryFile: true,
      importPath: './src/switcher/slicc-agent-tabs.stories.ts',
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
    expect(
      classifyChangedFile('packages/webcomponents/tests/switcher/slicc-agent-tabs.test.ts')
    ).toBeNull();
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
      ['packages/webcomponents/src/switcher/slicc-agent-tabs.ts'],
      indexJson
    );
    expect(result.map((s) => s.storyId)).toEqual([
      'switcher-agenttabs--cone-focused',
      'switcher-agenttabs--default',
    ]);
    expect(result[0].area).toBe('switcher');
    expect(result[0].triggeredBy).toEqual([
      'packages/webcomponents/src/switcher/slicc-agent-tabs.ts',
    ]);
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

  it('multiple non-global areas produce the union of affected stories', () => {
    const result = resolveAffectedStories(
      [
        'packages/webcomponents/src/switcher/slicc-agent-tabs.ts',
        'packages/webcomponents/src/chat/slicc-agent-message.ts',
      ],
      indexJson
    );
    expect(result.map((s) => s.storyId)).toEqual([
      'chat-agent-message--default',
      'chat-user-message--default',
      'switcher-agenttabs--cone-focused',
      'switcher-agenttabs--default',
    ]);
  });

  it('global theme change selects every story (with triggeredBy recorded)', () => {
    const themeFile = 'packages/webcomponents/src/theme/tokens.css';
    const result = resolveAffectedStories([themeFile], indexJson);
    // Every renderable story in the index is selected; the docs entry stays excluded.
    expect(result.map((s) => s.storyId)).toEqual([
      'chat-agent-message--default',
      'chat-user-message--default',
      'switcher-agenttabs--cone-focused',
      'switcher-agenttabs--default',
      'theme-toggle--default',
    ]);
    for (const shot of result) {
      expect(shot.triggeredBy).toEqual([themeFile]);
    }
    // Each story keeps its own area, not the changed-file's area.
    expect(result.find((s) => s.storyId === 'switcher-agenttabs--default').area).toBe('switcher');
    expect(result.find((s) => s.storyId === 'theme-toggle--default').area).toBe('theme');
  });

  it('global internal change selects every story even though internal has no stories', () => {
    const internalFile = 'packages/webcomponents/src/internal/icons.ts';
    const result = resolveAffectedStories([internalFile], indexJson);
    expect(result.map((s) => s.storyId)).toEqual([
      'chat-agent-message--default',
      'chat-user-message--default',
      'switcher-agenttabs--cone-focused',
      'switcher-agenttabs--default',
      'theme-toggle--default',
    ]);
    for (const shot of result) {
      expect(shot.triggeredBy).toEqual([internalFile]);
    }
  });

  it('switcher (non-global) change still selects only switcher stories', () => {
    const result = resolveAffectedStories(
      ['packages/webcomponents/src/switcher/slicc-agent-tabs.ts'],
      indexJson
    );
    expect(result.map((s) => s.storyId)).toEqual([
      'switcher-agenttabs--cone-focused',
      'switcher-agenttabs--default',
    ]);
  });

  it('story file inside a global area still narrows to its own declared stories', () => {
    const result = resolveAffectedStories(
      ['packages/webcomponents/src/theme/slicc-theme-toggle.stories.ts'],
      indexJson
    );
    expect(result.map((s) => s.storyId)).toEqual(['theme-toggle--default']);
  });

  it('skips docs entries — only renderable stories are returned', () => {
    const result = resolveAffectedStories(
      ['packages/webcomponents/src/switcher/slicc-agent-tabs.stories.ts'],
      indexJson
    );
    expect(result.map((s) => s.storyId)).not.toContain('switcher-agenttabs--docs');
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
      resolveAffectedStories(['packages/webcomponents/src/switcher/slicc-agent-tabs.ts'], {
        v: 5,
        entries: {},
      })
    ).toEqual([]);
  });
});

describe('screenshotFileName', () => {
  it('joins storyId and theme with a stable extension', () => {
    expect(screenshotFileName('switcher-agenttabs--default', 'light')).toBe(
      'switcher-agenttabs--default-light.png'
    );
    expect(screenshotFileName('switcher-agenttabs--default', 'dark')).toBe(
      'switcher-agenttabs--default-dark.png'
    );
  });
});
