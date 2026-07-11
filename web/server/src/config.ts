import path from 'node:path';

export const PORT = Number(process.env.PORT ?? 8080);
export const PROJECTS_DIR = path.resolve(process.env.PROJECTS_DIR ?? 'projects');
export const ENGINE_URL = process.env.ENGINE_URL ?? 'http://127.0.0.1:8000';
export const PUBLISH_DIR = process.env.PUBLISH_DIR ?? '';
export const FRONTEND_DIST = process.env.FRONTEND_DIST
  ? path.resolve(process.env.FRONTEND_DIST)
  : '';
// a StepMania pump noteskin folder (e.g. XSanity NoteSkins/pump/default);
// when set, the notefield uses the real game sprites
export const NOTESKIN_DIR = process.env.NOTESKIN_DIR ?? '';
export const OSU_CLIENT_ID = process.env.OSU_CLIENT_ID ?? '';
export const OSU_CLIENT_SECRET = process.env.OSU_CLIENT_SECRET ?? '';
// Either the raw osu_session value or a complete Cookie header. Keep server-side.
export const OSU_SESSION_COOKIE = process.env.OSU_SESSION_COOKIE ?? '';
export const OSU_COOKIES_FILE = process.env.OSU_COOKIES_FILE ?? '';
