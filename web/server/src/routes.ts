import AdmZip from 'adm-zip';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ENGINE_URL, NOTESKIN_DIR, PUBLISH_DIR } from './config.js';
import { engineConvert, engineExport, engineHealth, engineRegenerate } from './engine.js';
import {
  deleteProject, extractMedia, listProjects, listRevisions, loadProject,
  loadRevision, mediaPath, newProjectId, projectDir, pushRevision,
  safeName, saveProject,
} from './store.js';
import type { ChartJson, Note, Project, RegenerateBody } from './types.js';

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export default async function routes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const engine = await engineHealth();
    return { status: 'ok', engine };
  });

  // ---------------------------------------------------------- noteskin
  // serves sprites from a StepMania pump noteskin dir (lane order DL UL C UR DR)

  const NOTESKIN_DIRS = ['DownLeft', 'UpLeft', 'Center', 'UpRight', 'DownRight'];
  const NOTESKIN_PREFIX: Record<string, string> = {
    tap: 'Tap Note 6x1',
    receptor: 'Ready Receptor 3x1',
    holdbody: 'Hold Body Active',
    holdcap: 'Hold BottomCap Active',
  };
  let noteskinFiles: Map<string, string> | null | undefined;

  function noteskinMap(): Map<string, string> | null {
    if (noteskinFiles !== undefined) return noteskinFiles;
    noteskinFiles = null;
    if (NOTESKIN_DIR && fs.existsSync(NOTESKIN_DIR)) {
      const entries = fs.readdirSync(NOTESKIN_DIR).filter((f) => f.toLowerCase().endsWith('.png'));
      const map = new Map<string, string>();
      for (const [kind, prefix] of Object.entries(NOTESKIN_PREFIX)) {
        NOTESKIN_DIRS.forEach((dir, lane) => {
          const hit = entries.find((f) => f.startsWith(`${dir} ${prefix}`));
          if (hit) map.set(`${kind}-${lane}`, hit);
        });
      }
      // a usable skin needs at least every tap + receptor sprite
      if (NOTESKIN_DIRS.every((_, l) => map.has(`tap-${l}`) && map.has(`receptor-${l}`))) {
        noteskinFiles = map;
      }
    }
    return noteskinFiles;
  }

  app.get('/api/noteskin/manifest', async () => {
    const map = noteskinMap();
    return { available: map != null, keys: map ? [...map.keys()] : [] };
  });

  app.get<{ Params: { key: string } }>('/api/noteskin/:key', async (req, reply) => {
    const file = noteskinMap()?.get(req.params.key);
    if (!file) return reply.code(404).send({ error: 'no such sprite' });
    reply.header('cache-control', 'public, max-age=3600');
    return reply.type('image/png').send(fs.createReadStream(path.join(NOTESKIN_DIR, file)));
  });

  // reference metrics: thin proxy to the engine's corpus index
  app.get<{ Params: { '*': string } }>('/api/reference/*', async (req, reply) => {
    const suffix = req.params['*'];
    const qs = req.raw.url?.split('?')[1];
    const res = await fetch(`${ENGINE_URL}/reference/${suffix}${qs ? `?${qs}` : ''}`);
    return reply.code(res.status).send(await res.json());
  });

  // ---------------------------------------------------------- projects

  app.post('/api/projects', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no .osz uploaded' });
    const data = await file.toBuffer();
    const seedField = (file.fields.seed as { value?: string } | undefined)?.value;
    const seed = seedField != null && seedField !== '' ? Number(seedField) : null;

    const converted = await engineConvert(data, file.filename, seed);

    const id = newProjectId();
    await fsp.mkdir(projectDir(id), { recursive: true });
    await fsp.writeFile(path.join(projectDir(id), 'song.osz'), data);
    const media = await extractMedia(id, converted.song.audioFile, converted.song.background);
    const project: Project = {
      id,
      createdAt: new Date().toISOString(),
      seed,
      song: { ...converted.song, audioFile: media.audio, background: media.bg },
      charts: converted.charts,
    };
    await saveProject(project);
    return project;
  });

  app.get('/api/projects', async () => {
    const projects = await listProjects();
    return projects.map((p) => ({
      id: p.id,
      createdAt: p.createdAt,
      song: {
        title: p.song.title,
        artist: p.song.artist,
        creator: p.song.creator,
        background: p.song.background,
      },
      charts: p.charts.map((c) => ({
        id: c.id, name: c.name, level: c.level,
        notes: c.notes.length, stats: c.stats,
      })),
    }));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    try {
      return await loadProject(req.params.id);
    } catch {
      return reply.code(404).send({ error: 'project not found' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    await deleteProject(req.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------- charts

  app.put<{ Params: { id: string; chartId: string }; Body: Partial<ChartJson> }>(
    '/api/projects/:id/charts/:chartId',
    async (req, reply) => {
      const project = await loadProject(req.params.id);
      const idx = project.charts.findIndex((c) => c.id === req.params.chartId);
      if (idx < 0) return reply.code(404).send({ error: 'chart not found' });
      const current = project.charts[idx];
      const body = req.body ?? {};
      const next: ChartJson = {
        ...current,
        name: typeof body.name === 'string' ? body.name : current.name,
        level: Number.isFinite(body.level) ? Number(body.level) : current.level,
        notes: Array.isArray(body.notes) ? sanitizeNotes(body.notes) : current.notes,
        stats: body.stats ?? current.stats,
      };
      project.charts[idx] = next;
      await saveProject(project);
      return next;
    },
  );

  app.post<{ Params: { id: string; chartId: string }; Body: RegenerateBody }>(
    '/api/projects/:id/charts/:chartId/regenerate',
    async (req, reply) => {
      const project = await loadProject(req.params.id);
      const idx = project.charts.findIndex((c) => c.id === req.params.chartId);
      if (idx < 0) return reply.code(404).send({ error: 'chart not found' });
      const current = project.charts[idx];
      const body = req.body ?? {};
      const regenerated = await engineRegenerate(project.song, current, body);
      const region = body.startRow != null || body.endRow != null
        ? `rows ${body.startRow ?? 0}–${body.endRow ?? 'end'}`
        : 'full';
      await pushRevision(req.params.id, current, `before regenerate (${region})`);
      project.charts[idx] = regenerated;
      await saveProject(project);
      return regenerated;
    },
  );

  app.get<{ Params: { id: string; chartId: string } }>(
    '/api/projects/:id/charts/:chartId/revisions',
    async (req) => listRevisions(req.params.id, req.params.chartId),
  );

  app.post<{ Params: { id: string; chartId: string; name: string } }>(
    '/api/projects/:id/charts/:chartId/revisions/:name/restore',
    async (req, reply) => {
      const project = await loadProject(req.params.id);
      const idx = project.charts.findIndex((c) => c.id === req.params.chartId);
      if (idx < 0) return reply.code(404).send({ error: 'chart not found' });
      const revision = await loadRevision(req.params.id, req.params.chartId, req.params.name);
      await pushRevision(req.params.id, project.charts[idx], 'before restore');
      project.charts[idx] = revision;
      await saveProject(project);
      return revision;
    },
  );

  // ---------------------------------------------------------- media

  app.get<{ Params: { id: string } }>('/api/projects/:id/audio', async (req, reply) => {
    const project = await loadProject(req.params.id);
    const file = mediaPath(req.params.id, project.song.audioFile);
    if (!project.song.audioFile || !fs.existsSync(file)) {
      return reply.code(404).send({ error: 'no audio' });
    }
    const size = (await fsp.stat(file)).size;
    const mime = AUDIO_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    reply.header('accept-ranges', 'bytes').type(mime);
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return reply.code(416).header('content-range', `bytes */${size}`).send();
      }
      return reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${size}`)
        .header('content-length', end - start + 1)
        .send(fs.createReadStream(file, { start, end }));
    }
    return reply.header('content-length', size).send(fs.createReadStream(file));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/background', async (req, reply) => {
    const project = await loadProject(req.params.id);
    const file = mediaPath(req.params.id, project.song.background);
    if (!project.song.background || !fs.existsSync(file)) {
      return reply.code(404).send({ error: 'no background' });
    }
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    return reply.type(mime).send(fs.createReadStream(file));
  });

  // ---------------------------------------------------------- export / publish

  app.get<{ Params: { id: string } }>('/api/projects/:id/export', async (req, reply) => {
    const project = await loadProject(req.params.id);
    const { folder, files } = await buildSongFolder(project);
    const zip = new AdmZip();
    for (const [name, data] of files) zip.addFile(`${folder}/${name}`, data);
    return reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${folder}.zip"`)
      .send(zip.toBuffer());
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/publish', async (req, reply) => {
    if (!PUBLISH_DIR) return reply.code(400).send({ error: 'PUBLISH_DIR not configured' });
    const project = await loadProject(req.params.id);
    const { folder, files } = await buildSongFolder(project);
    const dest = path.join(PUBLISH_DIR, folder);
    await fsp.mkdir(dest, { recursive: true });
    for (const [name, data] of files) {
      await fsp.writeFile(path.join(dest, name), data);
    }
    return { ok: true, path: dest };
  });
}

async function buildSongFolder(
  project: Project,
): Promise<{ folder: string; files: [string, Buffer][] }> {
  const folder = safeName(`${project.song.artist} - ${project.song.title}`) || project.id;
  const ssc = await engineExport(project);
  const files: [string, Buffer][] = [[`${folder}.ssc`, Buffer.from(ssc, 'utf8')]];
  for (const media of [project.song.audioFile, project.song.background]) {
    if (!media) continue;
    const p = mediaPath(project.id, media);
    if (fs.existsSync(p)) files.push([media, await fsp.readFile(p)]);
  }
  return { folder, files };
}

function sanitizeNotes(notes: Note[]): Note[] {
  const out: Note[] = [];
  for (const n of notes) {
    if (!Number.isInteger(n.row) || n.row < 0) continue;
    const panels = [...new Set((n.panels ?? []).filter((p) => Number.isInteger(p) && p >= 0 && p <= 4))];
    if (!panels.length || panels.length > 2) continue;
    const holdEndRow = Number.isInteger(n.holdEndRow) && (n.holdEndRow as number) > n.row
      ? (n.holdEndRow as number)
      : null;
    const tier = n.origin?.tier ?? 'manual';
    out.push({
      row: n.row,
      panels: panels.sort((a, b) => a - b),
      holdEndRow,
      origin: {
        tier: ['exact', 'downgrade', 'fallback', 'jump', 'manual'].includes(tier) ? tier : 'manual',
        sourceMeter: typeof n.origin?.sourceMeter === 'number' ? n.origin.sourceMeter : null,
      },
    });
  }
  return out.sort((a, b) => a.row - b.row);
}
