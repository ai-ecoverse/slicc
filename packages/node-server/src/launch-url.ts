import {
  buildCanonicalTrayLaunchUrl,
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrl,
} from './tray-url-shared.js';

export interface CliLaunchUrlOptions {
  serveOrigin: string;
  lead: boolean;
  leadWorkerBaseUrl?: string | null;
  envWorkerBaseUrl?: string | null;
  join: boolean;
  joinUrl?: string | null;
}

function buildTrayJoinLaunchUrl(locationHref: string, joinUrl: string): string {
  const parsedJoinUrl = parseTrayJoinUrl(joinUrl);
  if (!parsedJoinUrl) {
    throw new Error(`Invalid tray join URL: ${joinUrl}`);
  }

  return buildCanonicalTrayLaunchUrl(locationHref, parsedJoinUrl.joinUrl);
}

function buildTrayLeadLaunchUrl(locationHref: string, workerBaseUrl: string): string {
  const normalizedBase = normalizeTrayWorkerBaseUrl(workerBaseUrl);
  if (!normalizedBase) {
    throw new Error(`Invalid tray worker base URL: ${workerBaseUrl}`);
  }

  return buildCanonicalTrayLaunchUrl(locationHref, normalizedBase);
}

export function resolveCliBrowserLaunchUrl(options: CliLaunchUrlOptions): string {
  if (options.lead && options.join) {
    throw new Error('The --lead and --join launch flows are mutually exclusive.');
  }

  if (options.join) {
    if (!options.joinUrl) {
      throw new Error(
        'The --join launch flow requires a tray join URL via --join <url> or --join=<url>.'
      );
    }
    return buildTrayJoinLaunchUrl(options.serveOrigin, options.joinUrl);
  }

  if (!options.lead) {
    return options.serveOrigin;
  }

  const workerBaseUrl = normalizeTrayWorkerBaseUrl(
    options.leadWorkerBaseUrl ?? options.envWorkerBaseUrl ?? null
  );
  if (!workerBaseUrl) {
    throw new Error(
      'The --lead launch flow requires a tray worker base URL via --lead <url>, --lead=<url>, or WORKER_BASE_URL.'
    );
  }

  return buildTrayLeadLaunchUrl(options.serveOrigin, workerBaseUrl);
}
