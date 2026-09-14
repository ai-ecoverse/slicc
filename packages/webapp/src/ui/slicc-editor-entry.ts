import './slicc-editor.js';
import { StreamLanguage } from '@codemirror/language';

declare global {
  interface Window {
    __SLICC_CM6__?: {
      StreamLanguage: typeof StreamLanguage;
    };
  }
}

window.__SLICC_CM6__ = { StreamLanguage };
