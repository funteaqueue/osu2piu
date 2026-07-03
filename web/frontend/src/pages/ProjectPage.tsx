import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { formatMetric, notesMetrics, type Metrics } from '../metrics';
import { SongTiming } from '../timing';
import type { Project } from '../types';

export default function ProjectPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getProject(id).then(setProject).catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  const metrics = useMemo(() => {
    if (!project) return new Map<string, Metrics>();
    const timing = new SongTiming(project.song.bpms, project.song.offsetSeconds);
    return new Map(project.charts.map((c) => [c.id, notesMetrics(c.notes, timing)]));
  }, [project]);

  if (error) return <div className="page"><p className="error-text">{error}</p></div>;
  if (!project) return <div className="page"><p className="muted">loading…</p></div>;

  const publish = async () => {
    setMessage(null);
    try {
      const res = await api.publish(id);
      setMessage(`published to ${res.path}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete project "${project.song.title}"?`)) return;
    await api.deleteProject(id);
    navigate('/');
  };

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="topbar">
        <h1><Link to="/">osu2piu</Link> / {project.song.title}</h1>
        <span className="sub">{project.song.artist} · mapped by {project.song.creator}</span>
      </div>

      {project.song.background && (
        <div
          className="card"
          style={{
            height: 140,
            backgroundImage: `url(${api.backgroundUrl(id)})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            marginBottom: 16,
          }}
        />
      )}

      <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
        <table className="stats">
          <thead>
            <tr>
              <th>difficulty</th><th>level</th><th>notes</th><th>coverage</th>
              <th>peak density</th><th>sustained</th><th>p95 speed</th>
              <th>fast steps</th><th>holds</th><th>jumps</th><th>travel/step</th><th></th>
            </tr>
          </thead>
          <tbody>
            {[...project.charts].sort((a, b) => a.level - b.level).map((c) => {
              const m = metrics.get(c.id);
              return (
                <tr key={c.id}>
                  <td><Link to={`/p/${id}/c/${c.id}`}>{c.name}</Link></td>
                  <td><b style={{ color: 'var(--accent-2)' }}>{c.level}</b></td>
                  <td>{c.notes.length}</td>
                  <td>{c.stats.coverage == null ? '—' : `${Math.round(c.stats.coverage * 100)}%`}</td>
                  <td>{formatMetric('peakNps', m?.peakNps)}</td>
                  <td>{formatMetric('avgNps', m?.avgNps)}</td>
                  <td>{formatMetric('p95Nps', m?.p95Nps)}</td>
                  <td>{formatMetric('fastShare', m?.fastShare)}</td>
                  <td>{formatMetric('holdShare', m?.holdShare)}</td>
                  <td>{formatMetric('jumpShare', m?.jumpShare)}</td>
                  <td>{formatMetric('travel', m?.travel)}</td>
                  <td><Link to={`/p/${id}/c/${c.id}`}><button>open</button></Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row">
        <a href={api.exportUrl(id)}><button>download .zip</button></a>
        <button className="primary" onClick={() => void publish()}>publish to Songs</button>
        <button className="danger" onClick={() => void remove()}>delete project</button>
      </div>
      {message && <p className="ok-text">{message}</p>}
    </div>
  );
}
