import AdmZip from 'adm-zip';
import { OSU_CLIENT_ID, OSU_CLIENT_SECRET, OSU_SESSION_COOKIE } from './config.js';

let token = '';
let tokenExpiresAt = 0;
let sessionCookie = OSU_SESSION_COOKIE;

async function accessToken(): Promise<string> {
  if (!OSU_CLIENT_ID || !OSU_CLIENT_SECRET) {
    throw new Error('osu! search is not configured');
  }
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;

  const response = await fetch('https://osu.ppy.sh/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: Number(OSU_CLIENT_ID),
      client_secret: OSU_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'public',
    }),
  });
  if (!response.ok) throw new Error(`osu! authentication failed (${response.status})`);
  const body = await response.json() as { access_token: string; expires_in: number };
  token = body.access_token;
  tokenExpiresAt = Date.now() + body.expires_in * 1000;
  return token;
}

export interface OsuSearchResult {
  id: number;
  title: string;
  artist: string;
  creator: string;
  status: string;
  cover: string;
  bpm: number | null;
  duration: number | null;
  difficulties: number[];
  hasVideo: boolean;
  pageUrl: string;
  downloadUrl: string;
}

export async function searchOsuBeatmapsets(query: string): Promise<OsuSearchResult[]> {
  const url = new URL('https://osu.ppy.sh/api/v2/beatmapsets/search');
  url.searchParams.set('q', query);
  url.searchParams.set('m', '0');
  url.searchParams.set('s', 'any');
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${await accessToken()}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`osu! search failed (${response.status})`);
  const body = await response.json() as { beatmapsets?: Array<Record<string, unknown>> };
  return (body.beatmapsets ?? []).slice(0, 20).map((raw) => {
    const beatmaps = Array.isArray(raw.beatmaps) ? raw.beatmaps as Array<Record<string, unknown>> : [];
    const standard = beatmaps.filter((b) => b.mode === 'osu' || b.mode_int === 0);
    const durations = standard.map((b) => Number(b.total_length)).filter(Number.isFinite);
    const stars = standard.map((b) => Number(b.difficulty_rating)).filter(Number.isFinite);
    const covers = (raw.covers ?? {}) as Record<string, string>;
    const id = Number(raw.id);
    return {
      id,
      title: String(raw.title ?? ''),
      artist: String(raw.artist ?? ''),
      creator: String(raw.creator ?? ''),
      status: String(raw.status ?? ''),
      cover: covers['cover@2x'] ?? covers.cover ?? covers.card ?? '',
      bpm: Number.isFinite(Number(raw.bpm)) ? Number(raw.bpm) : null,
      duration: durations.length ? Math.max(...durations) : null,
      difficulties: stars.sort((a, b) => a - b),
      hasVideo: Boolean(raw.video),
      pageUrl: `https://osu.ppy.sh/beatmapsets/${id}`,
      downloadUrl: `https://osu.ppy.sh/beatmapsets/${id}/download`,
    };
  }).filter((r) => r.difficulties.length > 0);
}

export type DownloadSource = 'official' | 'chimu' | 'beatconnect';

function cookieHeader(): string {
  if (!sessionCookie) return '';
  return sessionCookie.includes('=')
    ? sessionCookie
    : `osu_session=${sessionCookie}`;
}

export function hasOsuSessionCookie(): boolean {
  return Boolean(cookieHeader());
}

export function setOsuSessionCookie(value: string): void {
  sessionCookie = value.trim();
}

/** Extract only osu_session from a Mozilla/Netscape cookies.txt export. */
export function parseOsuCookiesTxt(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    const [domain, , , , , name, ...valueParts] = fields;
    const normalizedDomain = domain.toLowerCase().replace(/^\./, '');
    if ((normalizedDomain === 'ppy.sh' || normalizedDomain === 'osu.ppy.sh'
        || normalizedDomain.endsWith('.osu.ppy.sh'))
        && name === 'osu_session') {
      const value = valueParts.join('\t').trim();
      if (value) return value;
    }
  }
  return null;
}

function validOsz(data: Buffer): boolean {
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return false;
  try {
    const zip = new AdmZip(data);
    return zip.getEntries().some((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith('.osu'));
  } catch {
    return false;
  }
}

async function fetchOsz(url: string, headers: Record<string, string> = {}): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/octet-stream',
        'user-agent': 'osu2piu/0.1 (personal beatmap converter)',
        ...headers,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 256 * 1024 * 1024) return null;
    const data = Buffer.from(await response.arrayBuffer());
    return validOsz(data) ? data : null;
  } catch {
    return null;
  }
}

export async function downloadBeatmapset(
  id: number,
  status: (message: string) => void,
): Promise<{ data: Buffer; source: DownloadSource }> {
  status('Trying official osu! download…');
  const cookie = cookieHeader();
  if (cookie) {
    const official = await fetchOsz(`https://osu.ppy.sh/beatmapsets/${id}/download`, {
      cookie,
      referer: `https://osu.ppy.sh/beatmapsets/${id}`,
    });
    if (official) return { data: official, source: 'official' };
  }

  status('Official download unavailable; trying Chimu mirror…');
  const chimu = await fetchOsz(`https://api.chimu.moe/v1/download/${id}?n=1`);
  if (chimu) return { data: chimu, source: 'chimu' };

  status('Chimu unavailable; trying Beatconnect mirror…');
  const beatconnect = await fetchOsz(`https://beatconnect.io/b/${id}`);
  if (beatconnect) return { data: beatconnect, source: 'beatconnect' };

  throw new Error('Could not download a valid .osz from osu! or either mirror');
}
