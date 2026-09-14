import { createElement as h, useCallback, useEffect, useState } from 'react';
import { useStorybookApi, useStorybookState } from 'storybook/manager-api';
import {
  deriveSubsystem,
  ensurePermission,
  type FeedbackRecord,
  type FsDirHandle,
  getDirectoryPicker,
  writeComment,
} from './fs-access.js';
import { loadHandle, saveHandle } from './idb.js';

type Status = { kind: 'idle' | 'saved' | 'error'; text: string };
const IDLE: Status = { kind: 'idle', text: '' };

const wrap = { padding: '12px 16px', fontSize: '13px', lineHeight: 1.5 } as const;
const row = { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' } as const;
const muted = { opacity: 0.7 } as const;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useStoryContext() {
  const state = useStorybookState();
  const api = useStorybookApi();
  const data = api.getCurrentStoryData() as
    | { id?: string; title?: string; importPath?: string }
    | undefined;
  const importPath = data?.importPath ?? '';
  return {
    storyId: data?.id ?? state.storyId ?? '',
    storyTitle: data?.title ?? '',
    importPath,
    subsystem: deriveSubsystem(importPath),
  };
}

function statusEl(status: Status) {
  if (status.kind === 'idle') {
    return null;
  }
  const color = status.kind === 'saved' ? '#1a7f37' : '#cf222e';
  return h('div', { style: { color, marginTop: '8px' } }, status.text);
}

function chromiumOnlyEl() {
  return h(
    'div',
    { style: wrap },
    h('strong', null, 'Chromium-only'),
    h(
      'p',
      { style: muted },
      'The feedback folder needs the File System Access API (window.showDirectoryPicker), available in Chromium-based browsers only.'
    )
  );
}

interface PanelBodyProps {
  connected: boolean;
  folderName: string;
  needsReconnect: boolean;
  connect: () => void;
  reconnect: () => void;
  comment: string;
  setComment: (value: string) => void;
  busy: boolean;
  submit: () => void;
  storyId: string;
  storyTitle: string;
  subsystem: string;
  status: Status;
}

function folderRowEl(p: PanelBodyProps) {
  if (p.connected) {
    return h('div', { style: row }, h('span', null, `\uD83D\uDCC1 ${p.folderName || '(folder)'}`));
  }
  return h(
    'div',
    { style: row },
    h(
      'button',
      { type: 'button', onClick: p.needsReconnect ? p.reconnect : p.connect },
      p.needsReconnect ? `Reconnect "${p.folderName}"` : 'Connect feedback folder'
    )
  );
}

function panelBody(p: PanelBodyProps) {
  return h(
    'div',
    { style: wrap },
    folderRowEl(p),
    h(
      'div',
      { style: { ...muted, marginBottom: '8px' } },
      h('div', null, `Story: ${p.storyTitle || p.storyId || '(no story selected)'}`),
      h('div', null, `Subsystem: ${p.subsystem}`)
    ),
    h('textarea', {
      value: p.comment,
      placeholder: 'Leave a comment for this story…',
      onChange: (e: { target: { value: string } }) => p.setComment(e.target.value),
      style: { width: '100%', minHeight: '90px', boxSizing: 'border-box', padding: '6px' },
    }),
    h(
      'div',
      { style: { ...row, marginTop: '8px' } },
      h(
        'button',
        {
          type: 'button',
          onClick: p.submit,
          disabled: !p.connected || !p.comment.trim() || p.busy,
        },
        p.busy ? 'Saving…' : 'Submit'
      )
    ),
    statusEl(p.status)
  );
}

export function FeedbackPanel() {
  const picker = getDirectoryPicker();
  const { storyId, storyTitle, importPath, subsystem } = useStoryContext();
  const [handle, setHandle] = useState<FsDirHandle | null>(null);
  const [folderName, setFolderName] = useState<string>('');
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(IDLE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = (await loadHandle()) as FsDirHandle | undefined;
        if (cancelled || !stored) {
          return;
        }
        setHandle(stored);
        setFolderName(stored.name);
        const perm = await ensurePermission(stored, false);
        if (!cancelled) {
          setNeedsReconnect(perm !== 'granted');
        }
      } catch (err) {
        if (!cancelled) {
          setStatus({ kind: 'error', text: `Could not restore folder: ${message(err)}` });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    if (!picker) {
      return;
    }
    setStatus(IDLE);
    try {
      const dir = await picker({ mode: 'readwrite' });
      await saveHandle(dir as unknown as FileSystemDirectoryHandle);
      setHandle(dir);
      setFolderName(dir.name);
      setNeedsReconnect(false);
    } catch (err) {
      setStatus({ kind: 'error', text: `Connect failed: ${message(err)}` });
    }
  }, [picker]);

  const reconnect = useCallback(async () => {
    if (!handle) {
      return;
    }
    setStatus(IDLE);
    try {
      const perm = await ensurePermission(handle, true);
      setNeedsReconnect(perm !== 'granted');
      if (perm !== 'granted') {
        setStatus({ kind: 'error', text: 'Permission denied for the feedback folder.' });
      }
    } catch (err) {
      setStatus({ kind: 'error', text: `Reconnect failed: ${message(err)}` });
    }
  }, [handle]);

  const connected = !!handle && !needsReconnect;

  const submit = useCallback(async () => {
    if (!handle || !connected || !comment.trim()) {
      return;
    }
    setBusy(true);
    setStatus(IDLE);
    const record: FeedbackRecord = {
      storyId,
      storyTitle,
      subsystem,
      importPath,
      comment: comment.trim(),
      createdAt: new Date().toISOString(),
    };
    try {
      const filename = await writeComment(handle, record);
      setComment('');
      setStatus({ kind: 'saved', text: `Saved \u2713  ${filename}` });
    } catch (err) {
      setStatus({ kind: 'error', text: `Write failed: ${message(err)}` });
    } finally {
      setBusy(false);
    }
  }, [handle, connected, comment, storyId, storyTitle, subsystem, importPath]);

  if (!picker) {
    return chromiumOnlyEl();
  }
  return panelBody({
    connected,
    folderName,
    needsReconnect,
    connect,
    reconnect,
    comment,
    setComment,
    busy,
    submit,
    storyId,
    storyTitle,
    subsystem,
    status,
  });
}
