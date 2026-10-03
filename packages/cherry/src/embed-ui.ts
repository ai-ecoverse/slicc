import type { CherryFeatures, MountSliccOptions, SliccHandle } from './index.js';
import { mountSliccImpl } from './mount.js';

export type { CherryFeatures, MountSliccOptions, SliccHandle };

export function mountSlicc(options: MountSliccOptions): SliccHandle {
  if (!options?.container && !options?.iframe) {
    throw new Error('mountSlicc: either options.container or options.iframe is required');
  }
  return mountSliccImpl(options);
}
