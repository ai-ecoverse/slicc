/**
 * Tests for the pure helpers in tool-call-view.ts.
 *
 * The DOM-touching parts (icon SVG, body renderers) are exercised
 * indirectly by chat-panel rendering tests; here we focus on the
 * grouping rule and per-call status mapping that drive the "Working"
 * cluster.
 */

import { describe, it, expect } from 'vitest';
import {
  groupToolCalls,
  clusterPreview,
  toolStatus,
  TOOL_CLUSTER_MIN,
} from '../../src/ui/tool-call-view.js';
import type { ToolCall } from '../../src/ui/types.js';

const tc = (overrides: Partial<ToolCall> & { name: string }): ToolCall => ({
  id: overrides.id ?? `tc-${overrides.name}`,
  name: overrides.name,
  input: overrides.input ?? {},
  result: overrides.result,
  isError: overrides.isError,
});

describe('groupToolCalls', () => {
  it('returns an empty array for an empty input', () => {
    expect(groupToolCalls([])).toEqual([]);
  });

  it('renders one tool call inline (single group)', () => {
    const calls = [tc({ name: 'read_file', result: 'ok' })];
    const groups = groupToolCalls(calls);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ kind: 'single', toolCall: calls[0] });
  });

  it('renders two tool calls inline (two singles)', () => {
    const calls = [tc({ name: 'read_file', result: 'a' }), tc({ name: 'bash', result: 'b' })];
    const groups = groupToolCalls(calls);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === 'single')).toBe(true);
  });

  it('collapses three or more tool calls into a single cluster', () => {
    const calls = [
      tc({ name: 'list_scoops', result: 'ok' }),
      tc({ name: 'scoop_scoop', result: 'ok' }),
      tc({ name: 'feed_scoop', result: 'ok' }),
      tc({ name: 'send_message', result: 'ok' }),
    ];
    const groups = groupToolCalls(calls);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ kind: 'cluster', toolCalls: calls });
  });

  it('uses the published TOOL_CLUSTER_MIN threshold', () => {
    expect(TOOL_CLUSTER_MIN).toBe(3);
  });

  it('does not mutate its input', () => {
    const calls = [
      tc({ name: 'read_file', result: 'a' }),
      tc({ name: 'bash', result: 'b' }),
      tc({ name: 'edit_file', result: 'c' }),
    ];
    const snapshot = JSON.stringify(calls);
    groupToolCalls(calls);
    expect(JSON.stringify(calls)).toBe(snapshot);
  });
});

describe('toolStatus', () => {
  it('classifies a pending tool call as running', () => {
    expect(toolStatus(tc({ name: 'bash' }))).toBe('running');
  });

  it('classifies a completed tool call as success', () => {
    expect(toolStatus(tc({ name: 'bash', result: 'ok' }))).toBe('success');
  });

  it('classifies an errored tool call as error', () => {
    expect(toolStatus(tc({ name: 'bash', result: 'boom', isError: true }))).toBe('error');
  });

  it('produces one status per tool call so the cluster header can render a dot per call', () => {
    const calls = [
      tc({ name: 'list_scoops', result: 'ok' }),
      tc({ name: 'scoop_scoop', result: 'fail', isError: true }),
      tc({ name: 'feed_scoop' }),
    ];
    expect(calls.map(toolStatus)).toEqual(['success', 'error', 'running']);
  });
});

describe('clusterPreview', () => {
  it('joins tool descriptor titles with commas', () => {
    const calls = [
      tc({ name: 'list_scoops' }),
      tc({ name: 'scoop_scoop' }),
      tc({ name: 'feed_scoop' }),
      tc({ name: 'send_message' }),
      tc({ name: 'drop_scoop' }),
      tc({ name: 'update_global_memory' }),
    ];
    const preview = clusterPreview(calls);
    expect(preview).toBe('list scoops, scoop, feed, message, drop, memory');
  });

  it('uses the unknown tool name verbatim when descriptor is missing', () => {
    const calls = [
      tc({ name: 'mystery_tool' }),
      tc({ name: 'mystery_tool' }),
      tc({ name: 'bash' }),
    ];
    expect(clusterPreview(calls)).toBe('mystery_tool, mystery_tool, bash');
  });

  it('truncates extremely long preview rows with an ellipsis', () => {
    const calls: ToolCall[] = Array.from({ length: 40 }, (_, i) =>
      tc({ id: `tc-${i}`, name: 'list_scoops' })
    );
    const preview = clusterPreview(calls);
    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview.endsWith('…')).toBe(true);
  });
});
