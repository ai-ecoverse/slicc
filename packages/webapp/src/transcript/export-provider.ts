import { TranscriptExportError } from '@slicc/shared-ts';
import type { TranscriptExportService } from './export-service.js';

let provider: TranscriptExportService | null = null;

export function registerTranscriptExportService(service: TranscriptExportService): () => void {
  provider = service;
  return () => {
    if (provider === service) provider = null;
  };
}

export function getTranscriptExportService(): TranscriptExportService {
  if (!provider) throw new TranscriptExportError('session-not-found');
  return provider;
}
