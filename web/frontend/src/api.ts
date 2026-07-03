import type { Chart, Note, Project, ProjectSummary, RegenOptions, RevisionInfo } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      msg = body.error ?? body.message ?? msg;
    } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => fetch('/api/projects').then((r) => json<ProjectSummary[]>(r)),

  getProject: (id: string) => fetch(`/api/projects/${id}`).then((r) => json<Project>(r)),

  deleteProject: (id: string) =>
    fetch(`/api/projects/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  upload: (file: File, seed?: number | null) => {
    const form = new FormData();
    if (seed != null) form.append('seed', String(seed));
    form.append('osz', file);
    return fetch('/api/projects', { method: 'POST', body: form }).then((r) => json<Project>(r));
  },

  saveChart: (id: string, chartId: string, patch: Partial<Chart> & { notes?: Note[] }) =>
    fetch(`/api/projects/${id}/charts/${chartId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<Chart>(r)),

  regenerate: (
    id: string,
    chartId: string,
    body: { startRow?: number | null; endRow?: number | null; seed?: number | null; options?: RegenOptions },
  ) =>
    fetch(`/api/projects/${id}/charts/${chartId}/regenerate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Chart>(r)),

  listRevisions: (id: string, chartId: string) =>
    fetch(`/api/projects/${id}/charts/${chartId}/revisions`).then((r) => json<RevisionInfo[]>(r)),

  restoreRevision: (id: string, chartId: string, name: string) =>
    fetch(`/api/projects/${id}/charts/${chartId}/revisions/${name}/restore`, { method: 'POST' })
      .then((r) => json<Chart>(r)),

  publish: (id: string) =>
    fetch(`/api/projects/${id}/publish`, { method: 'POST' }).then((r) =>
      json<{ ok: boolean; path: string }>(r),
    ),

  referenceLevel: (level: number) =>
    fetch(`/api/reference/level/${level}`).then((r) =>
      json<{ level: number; count: number; metrics: Record<string, number | null> }>(r),
    ),

  referenceSearch: (q: string, level?: number) =>
    fetch(`/api/reference/search?q=${encodeURIComponent(q)}${level != null ? `&level=${level}` : ''}`)
      .then((r) => json<{ id: number; title: string; meter: number }[]>(r)),

  referenceChart: (chartId: number) =>
    fetch(`/api/reference/chart/${chartId}`).then((r) =>
      json<{ id: number; title: string; meter: number; metrics: Record<string, number | null> }>(r),
    ),

  audioUrl: (id: string) => `/api/projects/${id}/audio`,
  backgroundUrl: (id: string) => `/api/projects/${id}/background`,
  exportUrl: (id: string) => `/api/projects/${id}/export`,
};
