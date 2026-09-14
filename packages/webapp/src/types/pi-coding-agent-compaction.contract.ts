import type { generateSummary } from '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';

type Params = Parameters<typeof generateSummary>;

type _Slot4HeadersContract = Params[4] extends Record<string, string> | undefined ? true : never;

type _Slot5SignalContract = Params[5] extends AbortSignal | undefined ? true : never;

const _slot4Check: _Slot4HeadersContract = true;
const _slot5Check: _Slot5SignalContract = true;
void _slot4Check;
void _slot5Check;
