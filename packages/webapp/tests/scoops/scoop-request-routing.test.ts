/**
 * Every scoop request that needs a human lands in the OWNING cone (#2312).
 *
 * Users never talk to a scoop, so its transcript has no place to answer from:
 * `sudo_request` cards and interactive `tool_ui` dips are addressed to the
 * cone that owns the scoop — with several cones live, that is the owner, not
 * "the cone" and not the default root.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ScoopApprovalRouter,
  type ScoopApprovalRouterDeps,
} from '../../src/scoops/scoop-approval-router.js';
import { ScoopLifecycleManager } from '../../src/scoops/scoop-lifecycle-manager.js';
import type { ChannelMessage, RegisteredScoop } from '../../src/scoops/types.js';
import type { SudoRequest } from '../../src/sudo/types.js';
import { rootOwnerOf } from '../../src/work-unit/policy.js';

function unit(jid: string, parentJid: string | null): RegisteredScoop {
  return {
    jid,
    name: jid,
    folder: `${jid}-folder`,
    parentJid,
    requiresTrigger: false,
    assistantLabel: jid,
    addedAt: '2026-01-01T00:00:00.000Z',
  };
}

const coneA = unit('cone_a', null);
const coneB = unit('cone_b', null);
const scoopOfB = unit('scoop_b1', 'cone_b');
const roster = new Map([
  [coneA.jid, coneA],
  [coneB.jid, coneB],
  [scoopOfB.jid, scoopOfB],
]);

/** The orchestrator's `approverFor` / `findApprover` rule, in one place. */
const ownerRoot = (jid: string): RegisteredScoop | undefined =>
  rootOwnerOf(roster.values(), roster.get(jid)) ?? coneA;

describe('sudo requests from a scoop', () => {
  it('delivers the card to the cone that owns the scoop, not to another cone or the scoop', async () => {
    const delivered: ChannelMessage[] = [];
    const emitted: Array<Record<string, unknown>> = [];
    const deps: ScoopApprovalRouterDeps = {
      getScoops: () => roster,
      findApprover: (jid) => (jid === undefined ? undefined : ownerRoot(jid)),
      getSudoManager: () => null,
      getLickManager: () =>
        ({ emitEvent: (e: Record<string, unknown>) => emitted.push(e) }) as never,
      handleMessage: async (msg) => {
        delivered.push(msg);
      },
      onMessageUpdate: vi.fn(),
      getMessagesForScoop: async () => [],
      saveMessage: vi.fn(async () => {}),
    };
    const router = new ScoopApprovalRouter(deps);
    const request: SudoRequest = { kind: 'command', detail: 'rm -rf /workspace/build' };

    void router.enqueueSudoRequest(scoopOfB.jid, request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delivered.map((m) => m.chatJid)).toEqual(['cone_b']);
    expect(delivered[0]!.channel).toBe('sudo-request');
    expect(delivered[0]!.lickState).toBe('pending');
    // The chip is addressed the same way, so the lick lands in B too.
    expect(emitted[0]!.targetScoop).toBe(coneB.name);
    // Nothing was addressed to the other cone or to the scoop itself.
    expect(delivered.some((m) => m.chatJid === 'cone_a')).toBe(false);
    expect(delivered.some((m) => m.chatJid === scoopOfB.jid)).toBe(false);
  });
});

describe('interactive tool_ui from a scoop', () => {
  it('is rendered in the owning cone, while a cone’s own card stays with it', () => {
    const toolUi: Array<[string, string, string | undefined]> = [];
    const toolUiDone: Array<[string, string | undefined]> = [];
    const manager = new ScoopLifecycleManager({
      getScoops: () => roster,
      approverFor: (jid: string) => ownerRoot(jid),
      getSharedFs: () => ({}),
      getSessionStore: () => null,
      getProcessManager: () => null,
      getSudoManager: () => null,
      callbacks: {
        onStatusChange: vi.fn(),
        onToolUI: (
          jid: string,
          _tool: string,
          requestId: string,
          _html: string,
          display?: string
        ) => toolUi.push([jid, requestId, display]),
        onToolUIDone: (jid: string, _requestId: string, display?: string) =>
          toolUiDone.push([jid, display]),
      },
      idleTimers: { start: vi.fn(), clear: vi.fn() },
      messageRouter: {
        ensureQueue: vi.fn(),
        forgetScoop: vi.fn(),
        flushOnIdle: vi.fn(async () => {}),
      },
    } as never);

    const callbacksFor = (jid: string) =>
      (
        manager as unknown as {
          buildContextCallbacks(
            jid: string,
            scoop: RegisteredScoop
          ): {
            onToolUI(toolName: string, requestId: string, html: string): void;
            onToolUIDone(requestId: string): void;
          };
        }
      ).buildContextCallbacks(jid, roster.get(jid) as RegisteredScoop);

    callbacksFor(scoopOfB.jid).onToolUI('mount', 'req-1', '<p>approve?</p>');
    callbacksFor(scoopOfB.jid).onToolUIDone('req-1');
    callbacksFor(coneA.jid).onToolUI('mount', 'req-2', '<p>approve?</p>');

    // The ORIGIN is never rewritten — it is the stream identity the rest of
    // the pipeline keys on, and the scoop's own `response_done` / `turn_end`
    // still arrive under it (Codex P1). The owner rides along as a separate
    // display target, and only when it actually differs.
    expect(toolUi).toEqual([
      ['scoop_b1', 'req-1', 'cone_b'],
      ['cone_a', 'req-2', undefined],
    ]);
    expect(toolUiDone).toEqual([['scoop_b1', 'cone_b']]);
  });
});
