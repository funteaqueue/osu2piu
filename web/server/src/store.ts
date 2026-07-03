import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import type { ChartJson, Project } from './types.js';

const MAX_REVISIONS = 20;

export function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '').trim().replace(/\.+$/, '');
}

export function projectDir(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad project id');
  return path.join(PROJECTS_DIR, id);
}

export async function listProjects(): Promise<Project[]> {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  const entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects: Project[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      projects.push(await loadProject(e.name));
    } catch {
      /* skip broken dirs */
    }
  }
  projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return projects;
}

export async function loadProject(id: string): Promise<Project> {
  const raw = await fsp.readFile(path.join(projectDir(id), 'project.json'), 'utf8');
  return JSON.parse(raw) as Project;
}

export async function saveProject(project: Project): Promise<void> {
  const dir = projectDir(project.id);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'project.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify(project));
  await fsp.rename(tmp, path.join(dir, 'project.json'));
}

export async function deleteProject(id: string): Promise<void> {
  await fsp.rm(projectDir(id), { recursive: true, force: true });
}

export function newProjectId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Extract audio + background from the stored .osz into media/; returns the
 *  extracted (sanitized) file names. */
export async function extractMedia(
  id: string,
  audioFile: string,
  background: string,
): Promise<{ audio: string; bg: string }> {
  const dir = projectDir(id);
  const zip = new AdmZip(path.join(dir, 'song.osz'));
  const mediaDir = path.join(dir, 'media');
  await fsp.mkdir(mediaDir, { recursive: true });

  const byLower = new Map(zip.getEntries().map((e) => [e.entryName.toLowerCase(), e]));
  const pull = (name: string): string => {
    const entry = name ? byLower.get(name.toLowerCase()) : undefined;
    if (!entry) return '';
    const out = safeName(path.basename(entry.entryName));
    fs.writeFileSync(path.join(mediaDir, out), entry.getData());
    return out;
  };
  return { audio: pull(audioFile), bg: pull(background) };
}

export function mediaPath(id: string, file: string): string {
  const p = path.join(projectDir(id), 'media', path.basename(file));
  return p;
}

// ------------------------------------------------------------- revisions

function revisionsDir(id: string, chartId: string): string {
  if (!/^[a-z0-9-]+$/i.test(chartId)) throw new Error('bad chart id');
  return path.join(projectDir(id), 'revisions', chartId);
}

export interface RevisionInfo {
  name: string;
  savedAt: string;
  label: string;
}

export async function pushRevision(
  id: string,
  chart: ChartJson,
  label: string,
): Promise<void> {
  const dir = revisionsDir(id, chart.id);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.writeFile(
    path.join(dir, `${stamp}.json`),
    JSON.stringify({ savedAt: new Date().toISOString(), label, chart }),
  );
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  while (files.length > MAX_REVISIONS) {
    await fsp.rm(path.join(dir, files.shift()!));
  }
}

export async function listRevisions(id: string, chartId: string): Promise<RevisionInfo[]> {
  const dir = revisionsDir(id, chartId);
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return [];
  }
  const out: RevisionInfo[] = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      out.push({ name: f.replace(/\.json$/, ''), savedAt: meta.savedAt, label: meta.label });
    } catch {
      /* ignore */
    }
  }
  return out;
}

export async function loadRevision(
  id: string,
  chartId: string,
  name: string,
): Promise<ChartJson> {
  if (!/^[\w-]+$/.test(name)) throw new Error('bad revision name');
  const raw = await fsp.readFile(path.join(revisionsDir(id, chartId), `${name}.json`), 'utf8');
  return JSON.parse(raw).chart as ChartJson;
}
