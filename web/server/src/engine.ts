import { ENGINE_URL } from './config.js';
import type { ChartJson, Project, RegenerateBody, SongJson } from './types.js';

class EngineError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new EngineError(res.status, `engine ${res.status}: ${text.slice(0, 500)}`);
  }
  return res;
}

export async function engineConvert(
  oszData: Buffer,
  fileName: string,
  seed: number | null,
): Promise<{ song: SongJson; charts: ChartJson[] }> {
  const form = new FormData();
  form.append('osz', new Blob([new Uint8Array(oszData)]), fileName);
  if (seed != null) form.append('seed', String(seed));
  const res = await ok(await fetch(`${ENGINE_URL}/convert`, { method: 'POST', body: form }));
  return (await res.json()) as { song: SongJson; charts: ChartJson[] };
}

export async function engineRegenerate(
  song: SongJson,
  chart: ChartJson,
  body: RegenerateBody,
): Promise<ChartJson> {
  const res = await ok(
    await fetch(`${ENGINE_URL}/regenerate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        song,
        chart,
        startRow: body.startRow ?? null,
        endRow: body.endRow ?? null,
        seed: body.seed ?? null,
        options: body.options ?? {},
      }),
    }),
  );
  return (await res.json()) as ChartJson;
}

export async function engineExport(project: Project): Promise<string> {
  const res = await ok(
    await fetch(`${ENGINE_URL}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ song: project.song, charts: project.charts }),
    }),
  );
  return res.text();
}

export async function engineHealth(): Promise<{ status: string; patterns: boolean } | null> {
  try {
    const res = await fetch(`${ENGINE_URL}/health`);
    if (!res.ok) return null;
    return (await res.json()) as { status: string; patterns: boolean };
  } catch {
    return null;
  }
}
