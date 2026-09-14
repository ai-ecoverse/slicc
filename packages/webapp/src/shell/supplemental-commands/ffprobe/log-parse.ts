export interface ProbeStream {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
}

export interface ProbeFormat {
  filename?: string;
  format_name?: string;
  duration?: string;
  start_time?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
}

export interface ProbeInfo {
  format: ProbeFormat;
  streams: ProbeStream[];
}

const CHANNEL_LAYOUTS: Record<string, number> = {
  mono: 1,
  stereo: 2,
  '2.1': 3,
  '3.0': 3,
  '3.1': 4,
  '4.0': 4,
  quad: 4,
  '4.1': 5,
  '5.0': 5,
  '5.1': 6,
  '6.0': 6,
  '6.1': 7,
  '7.0': 7,
  '7.1': 8,
};

export function durationToSeconds(raw: string): string | undefined {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) return undefined;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return undefined;
  return (hours * 3600 + minutes * 60 + seconds).toFixed(6);
}

export function channelsFromLayout(token: string): number | undefined {
  const layout = token.trim().toLowerCase();
  if (Object.hasOwn(CHANNEL_LAYOUTS, layout)) return CHANNEL_LAYOUTS[layout];

  const bare = /^([0-9.]+|[a-z0-9_+-]+)\(/.exec(layout);
  if (bare && Object.hasOwn(CHANNEL_LAYOUTS, bare[1])) return CHANNEL_LAYOUTS[bare[1]];
  const n = /^(\d+)\s+channels?$/.exec(layout);
  if (n) return Number(n[1]);
  return undefined;
}

function fpsToRate(fps: string): string {
  const n = Number(fps);
  if (!Number.isFinite(n)) return fps;
  if (Number.isInteger(n)) return `${n}/1`;

  const milli = Math.round(n * 1000);
  return `${milli}/1000`;
}

function bitrateToBits(kbps: string): string | undefined {
  const n = Number(kbps);
  if (!Number.isFinite(n)) return undefined;
  return String(Math.round(n * 1000));
}

function parseCodecHead(rest: string): {
  codec_name?: string;
  profile?: string;
  codec_tag_string?: string;
  remainder: string;
} {
  const head = /^([A-Za-z0-9_]+)(.*)$/.exec(rest);
  if (!head) return { remainder: rest };
  let remainder = head[2];
  let profile: string | undefined;
  let codecTagString: string | undefined;

  const profileMatch = /^\s*\(([^)/]+)\)/.exec(remainder);
  if (profileMatch && !profileMatch[1].includes('/')) {
    profile = profileMatch[1].trim();
    remainder = remainder.slice(profileMatch[0].length);
  }

  const tagMatch = /^\s*\(([A-Za-z0-9]+)\s*\/\s*0x[0-9a-fA-F]+\)/.exec(remainder);
  if (tagMatch) {
    codecTagString = tagMatch[1];
    remainder = remainder.slice(tagMatch[0].length);
  }
  return { codec_name: head[1], profile, codec_tag_string: codecTagString, remainder };
}

function parseVideoDetails(remainder: string, stream: ProbeStream): void {
  const pix = /,\s*([A-Za-z0-9_]+)(?:\([^)]*\))?,\s*(\d+)x(\d+)/.exec(remainder);
  if (pix) {
    stream.pix_fmt = pix[1];
    stream.width = Number(pix[2]);
    stream.height = Number(pix[3]);
  }
  const sarDar = /\[SAR\s+(\S+)\s+DAR\s+(\S+)\]/.exec(remainder);
  if (sarDar) {
    stream.sample_aspect_ratio = sarDar[1];
    stream.display_aspect_ratio = sarDar[2];
  }
  const br = /,\s*(\d+(?:\.\d+)?)\s*kb\/s/.exec(remainder);
  if (br) stream.bit_rate = bitrateToBits(br[1]);
  const fps = /,\s*(\d+(?:\.\d+)?)\s*fps/.exec(remainder);
  if (fps) {
    stream.r_frame_rate = fpsToRate(fps[1]);
    stream.avg_frame_rate = stream.r_frame_rate;
  }
}

function parseAudioDetails(remainder: string, stream: ProbeStream): void {
  const rate = /,\s*(\d+)\s*Hz/.exec(remainder);
  if (rate) stream.sample_rate = rate[1];
  const layout = /Hz,\s*([^,]+)/.exec(remainder);
  if (layout) {
    const token = layout[1].trim();
    stream.channel_layout = token;
    stream.channels = channelsFromLayout(token);
  }
  const br = /,\s*(\d+(?:\.\d+)?)\s*kb\/s/.exec(remainder);
  if (br) stream.bit_rate = bitrateToBits(br[1]);
}

function parseStreamLine(line: string): ProbeStream | null {
  const m =
    /^\s*Stream #(\d+):(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*(Video|Audio|Subtitle|Data|Attachment):\s*(.+)$/i.exec(
      line
    );
  if (!m) return null;
  const codecType = m[3].toLowerCase();
  const stream: ProbeStream = {
    index: Number(m[2]),
    codec_type: codecType,
  };
  const { codec_name, profile, codec_tag_string, remainder } = parseCodecHead(m[4]);
  if (codec_name) stream.codec_name = codec_name;
  if (profile) stream.profile = profile;
  if (codec_tag_string) stream.codec_tag_string = codec_tag_string;
  if (codecType === 'video') parseVideoDetails(remainder, stream);
  else if (codecType === 'audio') parseAudioDetails(remainder, stream);
  return stream;
}

function applyDurationLine(format: ProbeFormat, line: string): boolean {
  const duration =
    /^\s*Duration:\s*([^,]+),\s*start:\s*([^,]+),\s*bitrate:\s*(\d+(?:\.\d+)?)\s*kb\/s/.exec(line);
  if (!duration) return false;
  format.duration = durationToSeconds(duration[1]);
  format.start_time = Number(duration[2]).toFixed(6);
  format.bit_rate = bitrateToBits(duration[3]);
  return true;
}

function consumeTagLine(
  format: ProbeFormat,
  pendingTags: Record<string, string>,
  line: string
): 'keep' | 'end' {
  const tag = /^\s{2,}([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
  if (tag && !/^(Duration|Stream)\b/.test(tag[1])) {
    pendingTags[tag[1]] = tag[2].trim();
    return 'keep';
  }
  if (Object.keys(pendingTags).length > 0) format.tags = pendingTags;
  return 'end';
}

export function parseFfmpegProbeLog(log: string, fallbackFilename?: string): ProbeInfo | null {
  const lines = log.split(/\r?\n/);
  let format: ProbeFormat | null = null;
  const streams: ProbeStream[] = [];
  let inInput = false;
  let pendingTags: Record<string, string> | undefined;

  for (const line of lines) {
    const input = /^Input #(\d+),\s*(.+?),\s*from\s+'([^']*)':\s*$/.exec(line);
    if (input) {
      inInput = true;
      format = {
        format_name: input[2].trim(),
        filename: input[3] || fallbackFilename,
      };
      pendingTags = undefined;
      continue;
    }
    if (!inInput || !format) continue;

    if (/^\s*Metadata:\s*$/.test(line)) {
      pendingTags = {};
      continue;
    }
    if (pendingTags) {
      if (consumeTagLine(format, pendingTags, line) === 'keep') continue;
      pendingTags = undefined;
    }

    if (applyDurationLine(format, line)) continue;

    const stream = parseStreamLine(line);
    if (stream) {
      if (format.duration && stream.duration === undefined) {
        stream.duration = format.duration;
      }
      streams.push(stream);
    }
  }

  if (!format) return null;
  return { format, streams };
}
