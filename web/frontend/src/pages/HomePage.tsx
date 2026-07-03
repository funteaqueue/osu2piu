import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ProjectSummary } from '../types';

export default function HomePage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e.message ?? e)));
  }, []);

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const oszs = [...files].filter((f) => f.name.toLowerCase().endsWith('.osz'));
    if (!oszs.length) {
      setError('drop .osz files');
      return;
    }
    setError(null);
    let last: string | null = null;
    for (const file of oszs) {
      setBusy(file.name);
      try {
        const project = await api.upload(file);
        last = project.id;
      } catch (e) {
        setError(`${file.name}: ${(e as Error).message}`);
      }
    }
    setBusy(null);
    if (last && oszs.length === 1) navigate(`/p/${last}`);
    else api.listProjects().then(setProjects).catch(() => undefined);
  }, [navigate]);

  return (
    <div className="page">
      <div className="topbar">
        <h1>osu2piu studio</h1>
        <span className="sub">osu!standard → pump-single, preview &amp; edit before it hits the pad</span>
      </div>

      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void uploadFiles(e.dataTransfer.files); }}
      >
        {busy ? (
          <span><span className="spin">◐</span> converting {busy} …</span>
        ) : (
          <>
            drop <b>.osz</b> here — or{' '}
            <label style={{ color: 'var(--accent)', cursor: 'pointer' }}>
              browse
              <input
                type="file" accept=".osz" multiple hidden
                onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
              />
            </label>
          </>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}

      <div className="project-grid">
        {projects.map((p) => (
          <Link key={p.id} to={`/p/${p.id}`} className="card project-card">
            <div
              className="bg"
              style={p.song.background ? { backgroundImage: `url(${api.backgroundUrl(p.id)})` } : undefined}
            />
            <div className="body">
              <h3>{p.song.title}</h3>
              <div className="artist">{p.song.artist} · mapped by {p.song.creator}</div>
              {[...p.charts].sort((a, b) => a.level - b.level).map((c) => (
                <span key={c.id} className="chip">{c.name} <b>{c.level}</b></span>
              ))}
            </div>
          </Link>
        ))}
      </div>
      {!projects.length && !busy && <p className="muted">no projects yet — drop an .osz above.</p>}
    </div>
  );
}
