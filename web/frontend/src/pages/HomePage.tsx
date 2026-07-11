import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { OsuSearchResult } from '../api';
import type { ProjectSummary } from '../types';

export default function HomePage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<OsuSearchResult[]>([]);
  const [videoFilter, setVideoFilter] = useState<'all' | 'with' | 'without'>('all');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<number | null>(null);
  const [importHistory, setImportHistory] = useState<string[]>([]);
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

  const search = async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    setSearchError(null);
    try {
      setSearchResults(await api.searchOsu(query.trim()));
    } catch (e) {
      setSearchError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const duration = (seconds: number | null) => seconds == null
    ? ''
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const visibleSearchResults = searchResults.filter((result) =>
    videoFilter === 'all' || (videoFilter === 'with' ? result.hasVideo : !result.hasVideo));

  const importBeatmapset = async (beatmapsetId: number) => {
    setImportingId(beatmapsetId);
    setImportHistory(['Starting import…']);
    setSearchError(null);
    try {
      const { jobId } = await api.startOsuImport(beatmapsetId);
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const job = await api.getOsuImport(jobId);
        setImportHistory(job.history);
        if (job.status === 'done' && job.projectId) {
          navigate(`/p/${job.projectId}`);
          return;
        }
        if (job.status === 'error') throw new Error(job.message);
      }
    } catch (e) {
      setSearchError((e as Error).message);
      setImportingId(null);
    }
  };

  return (
    <div className="page">
      <div className="topbar">
        <h1>osu2piu studio</h1>
        <span className="sub">osu!standard → pump-single, preview &amp; edit before it hits the pad</span>
      </div>

      <section className="osu-search card">
        <div className="search-heading">
          <div>
            <h2>Find a song on osu!</h2>
            <p>Search official osu! listings, download the .osz, then drop it below to convert.</p>
          </div>
          <span className="official-badge">official search</span>
        </div>
        <form className="search-row" onSubmit={(e) => { e.preventDefault(); void search(); }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Song title or artist"
            aria-label="Search osu! beatmaps"
          />
          <button className="primary" disabled={searching || query.trim().length < 2}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>
        {searchError && <p className="error-text">{searchError}</p>}
        {searchResults.length > 0 && (
          <div className="video-filters" aria-label="Filter by video availability">
            {([
              ['all', `All (${searchResults.length})`],
              ['with', `With video (${searchResults.filter((r) => r.hasVideo).length})`],
              ['without', `Without video (${searchResults.filter((r) => !r.hasVideo).length})`],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                className={videoFilter === value ? 'active' : ''}
                onClick={() => setVideoFilter(value)}
              >{label}</button>
            ))}
          </div>
        )}
        {importingId != null && importHistory.length > 0 && (
          <div className="import-progress" aria-live="polite">
            {importHistory.map((message, i) => (
              <div key={`${message}-${i}`} className={i === importHistory.length - 1 ? 'current' : ''}>
                {i === importHistory.length - 1 && <span className="spin">◐</span>} {message}
              </div>
            ))}
          </div>
        )}
        {searchResults.length > 0 && (
          <div className="osu-results">
            {visibleSearchResults.map((result) => (
              <article className="osu-result" key={result.id}>
                <div className="cover" style={result.cover ? { backgroundImage: `url(${result.cover})` } : undefined} />
                <div className="result-body">
                  <h3>{result.title}</h3>
                  <p>{result.artist} · mapped by {result.creator}</p>
                  <div className="result-meta">
                    <span>{result.status}</span>
                    {result.bpm != null && <span>{Math.round(result.bpm)} BPM</span>}
                    {result.duration != null && <span>{duration(result.duration)}</span>}
                    <span className={result.hasVideo ? 'has-video' : 'no-video'}>
                      {result.hasVideo ? '● video included' : '○ no video'}
                    </span>
                  </div>
                  <div className="stars">
                    {result.difficulties.map((stars, i) => (
                      <span key={`${stars}-${i}`} title={`${stars.toFixed(2)} stars`}>{stars.toFixed(1)}★</span>
                    ))}
                  </div>
                </div>
                <div className="result-actions">
                  <button
                    className="primary"
                    disabled={importingId != null}
                    onClick={() => void importBeatmapset(result.id)}
                  >
                    {importingId === result.id ? 'Importing…' : 'Convert now'}
                  </button>
                  <a className="button primary" href={result.downloadUrl} target="_blank" rel="noreferrer">Download .osz</a>
                  <a className="button" href={result.pageUrl} target="_blank" rel="noreferrer">View</a>
                </div>
              </article>
            ))}
            {visibleSearchResults.length === 0 && (
              <p className="muted">No results match this video filter.</p>
            )}
          </div>
        )}
      </section>

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
