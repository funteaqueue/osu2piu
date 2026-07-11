import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import MetricsPanel from '../components/MetricsPanel';
import { notesMetrics } from '../metrics';
import Notefield from '../notefield/Notefield';
import { TIER_COLORS, TIER_HINTS } from '../notefield/sprites';
import {
  DEFAULT_BINDS, PlaySession, buildKeyMap, keyLabel, loadBinds, saveBinds,
} from '../play';

const PANEL_GLYPHS = ['↙', '↖', '●', '↗', '↘'];
import { useEditor } from '../store';
import { ROWS_PER_BEAT, SongTiming } from '../timing';
import type { Project, RevisionInfo } from '../types';

const SNAPS = [
  { label: '4th', rows: 12 },
  { label: '8th', rows: 6 },
  { label: '12th', rows: 4 },
  { label: '16th', rows: 3 },
  { label: '24th', rows: 2 },
  { label: '48th', rows: 1 },
];
const RATES = [0.5, 0.75, 1, 1.25, 1.5];

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

export default function ChartPage() {
  const { id = '', chartId = '' } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const editor = useEditor();
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const clockRef = useRef({ media: 0, perf: 0, playing: false, rate: 1 });

  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [curTime, setCurTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [pxPerBeat, setPxPerBeat] = useState(110);
  const [scrollDir, setScrollDir] = useState<'rise' | 'fall'>('rise');
  const [provenance, setProvenance] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [snapRows, setSnapRows] = useState(6);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [revisions, setRevisions] = useState<RevisionInfo[]>([]);
  const [revision, setRevision] = useState('');
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [playMode, setPlayMode] = useState(false);
  const [inputOffsetMs, setInputOffsetMs] = useState(() =>
    Number(localStorage.getItem('o2p-input-offset') ?? 0));
  const playRef = useRef<PlaySession | null>(null);
  const playModeRef = useRef(false);
  const [binds, setBinds] = useState<string[]>(loadBinds);
  const [rebinding, setRebinding] = useState<number | null>(null);
  const keyMapRef = useRef(buildKeyMap(binds));
  keyMapRef.current = useMemo(() => buildKeyMap(binds), [binds]);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1_000_000));
  const [levelOverride, setLevelOverride] = useState('');
  const [holdMult, setHoldMult] = useState(1);
  const [jumpMult, setJumpMult] = useState(1);
  const [maxMatch, setMaxMatch] = useState('');
  const [overwriteManual, setOverwriteManual] = useState(false);

  const timing = useMemo(
    () => (project ? new SongTiming(project.song.bpms, project.song.offsetSeconds) : null),
    [project],
  );
  const videoStartTime = useMemo(
    () => (project?.song.video && timing ? timing.timeAt(project.song.videoStartBeat || 0) : 0),
    [project, timing],
  );

  // ------------------------------------------------------------ loading

  useEffect(() => {
    api.getProject(id)
      .then((p) => {
        setProject(p);
        useEditor.getState().load(p, chartId);
      })
      .catch((e) => setLoadError(String((e as Error).message ?? e)));
    void api.listRevisions(id, chartId).then(setRevisions).catch(() => undefined);
  }, [id, chartId]);

  // ------------------------------------------------------------ clock

  const getTime = useCallback(() => {
    const c = clockRef.current;
    if (!c.playing) return c.media;
    return c.media + ((performance.now() - c.perf) / 1000) * c.rate;
  }, []);

  const syncClock = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    clockRef.current = {
      media: audio.currentTime,
      perf: performance.now(),
      playing: !audio.paused,
      rate: audio.playbackRate,
    };
  }, []);

  const syncVideo = useCallback((play = false) => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio || !video) return;
    const target = audio.currentTime - videoStartTime;
    video.playbackRate = audio.playbackRate;
    if (target < 0) {
      video.pause();
      if (video.currentTime !== 0) video.currentTime = 0;
      return;
    }
    if (Math.abs(video.currentTime - target) > 0.25) video.currentTime = target;
    if (play && !audio.paused) void video.play().catch(() => undefined);
  }, [videoStartTime]);

  const seek = useCallback((t: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
    syncClock();
    syncVideo(!audio.paused);
    setCurTime(audio.currentTime);
  }, [syncClock, syncVideo]);

  useEffect(() => {
    const iv = setInterval(() => setCurTime(getTime()), 200);
    return () => clearInterval(iv);
  }, [getTime]);

  // A/B loop
  useEffect(() => {
    if (loopA == null || loopB == null || loopB <= loopA) return;
    const iv = setInterval(() => {
      if (clockRef.current.playing && getTime() > loopB) seek(loopA);
    }, 60);
    return () => clearInterval(iv);
  }, [loopA, loopB, getTime, seek]);

  // ------------------------------------------------------------ transport

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      setEditMode(false);
      void audio.play();
    } else {
      audio.pause();
    }
  }, []);

  const firstNoteTime = useMemo(() => {
    const notes = editor.notes;
    if (!notes.length || !timing) return 0;
    return timing.rowTime(notes[0].row);
  }, [editor.notes, timing]);

  const liveMetrics = useMemo(
    () => (timing ? notesMetrics(editor.notes, timing) : null),
    [editor.notes, timing],
  );

  const enterEdit = useCallback((on: boolean) => {
    if (on) audioRef.current?.pause();
    setEditMode(on);
  }, []);

  // ------------------------------------------------------------ play mode
  // Deliberately lightweight: while the music plays, tapping a panel key
  // starts judging from that moment. Pause / seek / Esc quietly clears it.

  // capture the next key press while rebinding a panel; Esc cancels.
  // If the key is already on another panel, the two panels swap keys.
  useEffect(() => {
    if (rebinding == null) return;
    const capture = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRebinding(null); return; }
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      const key = e.key.toLowerCase();
      setBinds((prev) => {
        const next = [...prev];
        const taken = next.indexOf(key);
        if (taken >= 0 && taken !== rebinding) next[taken] = next[rebinding];
        next[rebinding] = key;
        saveBinds(next);
        return next;
      });
      setRebinding(null);
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [rebinding]);

  const endPlaySession = useCallback(() => {
    if (!playRef.current) return;
    playRef.current = null;
    playModeRef.current = false;
    setPlayMode(false);
  }, []);

  // ------------------------------------------------------------ autosave

  const dirty = editor.dirty;
  useEffect(() => {
    if (!dirty) return;
    setSaveState('saving');
    const t = setTimeout(() => {
      const { notes, level, name } = useEditor.getState();
      api.saveChart(id, chartId, { notes, level, name })
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'));
    }, 800);
    return () => clearTimeout(t);
  }, [dirty, id, chartId]);

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      // tap-along judging: a panel key while the music plays starts (or
      // feeds) a play session
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const panel = keyMapRef.current[e.key.toLowerCase()];
        const audio = audioRef.current;
        if (panel !== undefined && audio && !audio.paused && !useEditorEditModeRef.current) {
          e.preventDefault();
          if (!e.repeat) {
            if (!playRef.current && timing) {
              playRef.current = new PlaySession(
                useEditor.getState().notes, timing, getTime() - 0.25, inputOffsetMs / 1000);
              playModeRef.current = true;
              setPlayMode(true);
            }
            playRef.current?.press(panel, getTime());
          }
          return;
        }
      }
      const t = getTime();
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') seek(t - 5);
      else if (e.key === 'ArrowRight') seek(t + 5);
      else if (e.key === 'Tab') { e.preventDefault(); enterEdit(!useEditorEditModeRef.current); }
      else if (e.key === '[') setLoopA(t);
      else if (e.key === ']') setLoopB(t);
      else if (e.key === '\\') { setLoopA(null); setLoopB(null); }
      else if (e.key === 'Home') seek(Math.max(0, firstNoteTime - 1));
      else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); useEditor.getState().undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); useEditor.getState().redo(); }
      else if (e.key === 'Delete') useEditor.getState().deleteSelection();
      else if (e.key === 'Escape') { endPlaySession(); useEditor.getState().setSelection(null); }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!playModeRef.current) return;
      const panel = keyMapRef.current[e.key.toLowerCase()];
      if (panel !== undefined) playRef.current?.release(panel, getTime());
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [getTime, seek, togglePlay, enterEdit, firstNoteTime, timing, inputOffsetMs, endPlaySession]);
  const useEditorEditModeRef = useRef(editMode);
  useEditorEditModeRef.current = editMode;

  // ------------------------------------------------------------ regenerate

  const refreshRevisions = useCallback(() => {
    void api.listRevisions(id, chartId).then(setRevisions).catch(() => undefined);
  }, [id, chartId]);

  const regenerate = useCallback(async () => {
    setRegenBusy(true);
    setRegenError(null);
    const sel = useEditor.getState().selection;
    try {
      const chart = await api.regenerate(id, chartId, {
        startRow: sel?.startRow ?? null,
        endRow: sel?.endRow ?? null,
        seed,
        options: {
          ...(levelOverride !== '' ? { level: Number(levelOverride) } : {}),
          ...(holdMult !== 1 ? { holdMult } : {}),
          ...(jumpMult !== 1 ? { jumpMult } : {}),
          ...(maxMatch !== '' ? { maxMatch: Number(maxMatch) } : {}),
          ...(overwriteManual ? { overwriteManual } : {}),
        },
      });
      useEditor.getState().replaceChart(chart);
      refreshRevisions();
    } catch (e) {
      setRegenError((e as Error).message);
    } finally {
      setRegenBusy(false);
    }
  }, [id, chartId, seed, levelOverride, holdMult, jumpMult, maxMatch, overwriteManual, refreshRevisions]);

  const restore = useCallback(async () => {
    if (!revision) return;
    const chart = await api.restoreRevision(id, chartId, revision);
    useEditor.getState().replaceChart(chart);
    refreshRevisions();
  }, [id, chartId, revision, refreshRevisions]);

  // ------------------------------------------------------------ render

  if (loadError) return <div className="page"><p className="error-text">{loadError}</p></div>;
  if (!project || !timing || editor.chartId !== chartId) {
    return <div className="page"><p className="muted">loading…</p></div>;
  }

  const sel = editor.selection;
  const chart = project.charts.find((c) => c.id === chartId);

  return (
    <div className="editor-page">
      <audio
        ref={audioRef}
        src={api.audioUrl(id)}
        preload="auto"
        onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration); e.currentTarget.preservesPitch = true; }}
        onPlay={() => { syncClock(); syncVideo(true); setPlaying(true); }}
        onPause={() => { syncClock(); videoRef.current?.pause(); setPlaying(false); endPlaySession(); }}
        onSeeked={() => { syncClock(); syncVideo(!audioRef.current?.paused); endPlaySession(); }}
        onTimeUpdate={() => { syncClock(); syncVideo(true); }}
        onRateChange={() => { syncClock(); syncVideo(true); }}
        onEnded={endPlaySession}
      />

      <div className="editor-head">
        <Link to={`/p/${id}`}>← {project.song.title}</Link>
        <input
          className="title"
          value={editor.name}
          onChange={(e) => editor.setName(e.target.value)}
          style={{ width: 160 }}
          title="chart name"
        />
        <label className="muted">lvl</label>
        <input
          type="number" min={1} max={28} value={editor.level}
          onChange={(e) => editor.setLevel(Number(e.target.value))}
          style={{ width: 58 }}
        />
        <span className="muted">{editor.notes.length} notes</span>
        {editor.errors.length
          ? <span className="error-text">⚠ {editor.errors.length} validation issue{editor.errors.length > 1 ? 's' : ''}</span>
          : <span className="ok-text">✓ valid</span>}
        <span style={{ flex: 1 }} />
        <span className="muted">
          {saveState === 'saving' && 'saving…'}
          {saveState === 'saved' && 'saved'}
          {saveState === 'error' && <span className="error-text">save failed</span>}
        </span>
        <button
          className={`edit-toggle${editMode ? ' editing' : ''}`}
          onClick={() => enterEdit(!editMode)}
          title="Toggle edit mode (Tab) — click: tap · drag: hold · right-click: delete · shift+drag: select region"
        >
          {editMode ? '● EDITING' : '✎ EDIT'} <span className="kbd">Tab</span>
        </button>
        <button
          title="Download the whole song folder as .zip — every difficulty, audio and background, with your latest edits"
          onClick={() => {
            const { notes, level, name } = useEditor.getState();
            void api.saveChart(id, chartId, { notes, level, name })
              .catch(() => undefined)
              .then(() => { window.location.href = api.exportUrl(id); });
          }}
        >
          ⬇ song .zip
        </button>
        <button
          className={provenance ? 'active' : ''}
          onClick={() => setProvenance(!provenance)}
          title="Tint notes by where they came from: green = exact pattern match, blue = rhythm-only match, orange = rule-generator fallback, magenta = synthesized jump, white = your manual edits"
        >
          origin
        </button>
      </div>

      <div className="editor-main">
        <div className="field-wrap">
          {(project.song.background || project.song.video) && (
            <div
              className="preview-media"
              style={project.song.background ? { backgroundImage: `url(${api.backgroundUrl(id)})` } : undefined}
            >
              {project.song.video && (
                <video
                  ref={videoRef}
                  src={api.videoUrl(id)}
                  muted
                  playsInline
                  preload="metadata"
                  className={curTime >= videoStartTime ? 'visible' : ''}
                  onLoadedMetadata={() => syncVideo(playing)}
                />
              )}
            </div>
          )}
          <Notefield
            notes={editor.notes}
            timing={timing}
            getTime={getTime}
            pxPerBeat={pxPerBeat}
            scrollDir={scrollDir}
            provenance={provenance}
            editMode={editMode}
            playSession={playMode ? playRef.current : null}
            snapRows={snapRows}
            selection={sel}
            errors={editor.errors}
            loopA={loopA}
            loopB={loopB}
            onScrub={(deltaBeats) => {
              const beat = timing.beatAt(getTime()) + deltaBeats;
              seek(timing.timeAt(Math.max(0, beat)));
            }}
            onTap={(row, panel) => editor.toggleTap(row, panel)}
            onHold={(row, endRow, panel) => editor.addHold(row, endRow, panel)}
            onDelete={(row, panel) => editor.deleteAt(row, panel)}
            onSelect={(s) => editor.setSelection(s)}
          />
        </div>

        <div className="side-panel">
          <section>
            <h3>view</h3>
            <div className="row">
              <label>speed</label>
              <input type="range" min={40} max={280} value={pxPerBeat}
                onChange={(e) => setPxPerBeat(Number(e.target.value))} style={{ flex: 1 }} />
            </div>
            <div className="row">
              <label>scroll</label>
              <button onClick={() => setScrollDir(scrollDir === 'rise' ? 'fall' : 'rise')}>
                {scrollDir === 'rise' ? '↑ rise (game)' : '↓ fall'}
              </button>
            </div>
            <div className="row">
              <label>snap</label>
              <select value={snapRows} onChange={(e) => setSnapRows(Number(e.target.value))}>
                {SNAPS.map((s) => <option key={s.rows} value={s.rows}>{s.label}</option>)}
              </select>
            </div>
            <div className="row">
              <label title="if your hits always judge early/late, adjust this">input offset</label>
              <input
                type="number" step={5} value={inputOffsetMs}
                onChange={(e) => {
                  const v = Number(e.target.value) || 0;
                  setInputOffsetMs(v);
                  localStorage.setItem('o2p-input-offset', String(v));
                }}
                style={{ width: 70 }}
              />
              <span className="muted">ms</span>
            </div>
            {provenance && (
              <div className="legend-list">
                {Object.entries(TIER_COLORS).map(([tier, color]) => (
                  <div key={tier} className="legend-row">
                    <span className="dot" style={{ background: color }} />
                    <b>{tier}</b>
                    <span className="muted">{TIER_HINTS[tier]}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3>selection</h3>
            {sel ? (
              <>
                <div className="muted" style={{ marginBottom: 8 }}>
                  rows {sel.startRow}–{sel.endRow} · beats {(sel.startRow / ROWS_PER_BEAT).toFixed(1)}–{(sel.endRow / ROWS_PER_BEAT).toFixed(1)}
                </div>
                <div className="row">
                  <button onClick={() => editor.nudgeSelection(-1)}>nudge −1</button>
                  <button onClick={() => editor.nudgeSelection(1)}>nudge +1</button>
                  <button className="danger" onClick={() => editor.deleteSelection()}>delete notes</button>
                </div>
                <div className="row">
                  <button onClick={() => editor.setSelection(null)}>clear <span className="kbd">Esc</span></button>
                </div>
              </>
            ) : (
              <div className="muted">in edit mode, shift+drag over the field to select a region.</div>
            )}
          </section>

          <section>
            <h3>regenerate {sel ? 'region' : 'whole chart'}</h3>
            <div className="row">
              <label>seed</label>
              <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} style={{ width: 96 }} />
              <button title="reroll" onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))}>🎲</button>
            </div>
            <div className="row">
              <label>level</label>
              <input type="number" placeholder="auto" value={levelOverride}
                onChange={(e) => setLevelOverride(e.target.value)} style={{ width: 70 }} />
            </div>
            <div className="row">
              <label>holds ×{holdMult.toFixed(1)}</label>
              <input type="range" min={0} max={2} step={0.1} value={holdMult}
                onChange={(e) => setHoldMult(Number(e.target.value))} style={{ flex: 1 }} />
            </div>
            <div className="row">
              <label>jumps ×{jumpMult.toFixed(1)}</label>
              <input type="range" min={0} max={2} step={0.1} value={jumpMult}
                onChange={(e) => setJumpMult(Number(e.target.value))} style={{ flex: 1 }} />
            </div>
            <div className="row">
              <label>max match</label>
              <input type="number" placeholder="12" min={3} max={12} value={maxMatch}
                onChange={(e) => setMaxMatch(e.target.value)} style={{ width: 70 }} />
            </div>
            <div className="row">
              <label>
                <input type="checkbox" checked={overwriteManual}
                  onChange={(e) => setOverwriteManual(e.target.checked)} /> overwrite manual
              </label>
            </div>
            <button className="primary" disabled={regenBusy} onClick={() => void regenerate()}>
              {regenBusy ? 'regenerating…' : `regenerate ${sel ? 'region' : 'chart'}`}
            </button>
            {regenError && <p className="error-text">{regenError}</p>}
          </section>

          <section>
            <h3>revisions</h3>
            {revisions.length ? (
              <div className="row">
                <select value={revision} onChange={(e) => setRevision(e.target.value)} style={{ flex: 1 }}>
                  <option value="">choose…</option>
                  {revisions.map((r) => (
                    <option key={r.name} value={r.name}>
                      {new Date(r.savedAt).toLocaleTimeString()} — {r.label}
                    </option>
                  ))}
                </select>
                <button disabled={!revision} onClick={() => void restore()}>restore</button>
              </div>
            ) : <div className="muted">none yet — created on each regenerate.</div>}
          </section>

          <section>
            <h3>metrics</h3>
            {liveMetrics && (
              <MetricsPanel
                metrics={liveMetrics}
                level={editor.level}
                columnLabel={editor.name || 'this chart'}
              />
            )}
            {chart?.stats.coverage != null && (
              <div className="muted" style={{ marginTop: 6 }}>
                pattern coverage {Math.round(chart.stats.coverage * 100)}%
              </div>
            )}
          </section>

          <section>
            <h3>play keys</h3>
            <div className="row" style={{ gap: 6 }}>
              {binds.map((key, panel) => (
                <button
                  key={panel}
                  className={rebinding === panel ? 'active' : ''}
                  style={{ minWidth: 52, padding: '5px 6px' }}
                  title={`rebind the ${PANEL_GLYPHS[panel]} panel — click, then press a key`}
                  onClick={() => setRebinding(rebinding === panel ? null : panel)}
                >
                  {PANEL_GLYPHS[panel]}{' '}
                  <span className="kbd">{rebinding === panel ? '…' : keyLabel(key)}</span>
                </button>
              ))}
            </div>
            <div className="row">
              <span className="muted" style={{ fontSize: 12 }}>
                {rebinding != null
                  ? 'press a key (Esc cancels); a taken key swaps panels'
                  : 'click a panel to rebind · numpad 7 9 5 1 3 always works'}
              </span>
              <button
                style={{ padding: '2px 8px', fontSize: 12 }}
                onClick={() => { setBinds([...DEFAULT_BINDS]); saveBinds([...DEFAULT_BINDS]); setRebinding(null); }}
              >
                reset
              </button>
            </div>
          </section>

          <section>
            <h3>what does this mean?</h3>
            <details className="tips">
              <summary>note colors (origin)</summary>
              <div>
                Every note remembers <i>how the converter made it</i>. Press{' '}
                <b>origin</b> to color notes by that:
                {Object.entries(TIER_COLORS).map(([tier, color]) => (
                  <div key={tier} className="legend-row">
                    <span className="dot" style={{ background: color }} />
                    <b>{tier}</b>
                    <span className="muted">{TIER_HINTS[tier]}</span>
                  </div>
                ))}
                Orange/magenta clusters are the weakest parts — good spots to
                select and regenerate with a new seed.
              </div>
            </details>
            <details className="tips">
              <summary>metrics</summary>
              <div>
                <b>peak density</b> — notes per second in the busiest 5 seconds.<br />
                <b>sustained</b> — average speed over the active parts; breaks
                longer than 2 s don't count.<br />
                <b>p95 speed</b> — speed of the fastest 5% of steps. The ms
                number is the time between those steps — smaller = harder bursts.<br />
                <b>fast steps</b> — share of steps that come within 115 ms of the
                previous one (real "runs").<br />
                <b>holds / jumps</b> — share of steps that are holds / two-panel
                presses.<br />
                <b>travel per step</b> — how far your feet move between steps on
                the pad. Higher = more moving around, lower = more staying in place.<br />
                <b>vs level avg</b> compares with the middle value of real PIU
                charts of the same level; <b>vs song…</b> compares with one
                specific real chart.
              </div>
            </details>
            <details className="tips">
              <summary>regenerate knobs</summary>
              <div>
                <b>seed</b> — same seed always gives the same chart; 🎲 rolls a
                new one.<br />
                <b>level</b> — force which difficulty the patterns are taken
                from (empty = automatic).<br />
                <b>holds × / jumps ×</b> — make the converter aim for more or
                fewer holds/jumps than a typical chart of this level.<br />
                <b>max match</b> — the longest piece (in steps) copied from one
                real chart. Lower = more variety, higher = better flow.<br />
                <b>overwrite manual</b> — allow regeneration to replace notes
                you placed by hand (off = they survive).<br />
                With a region selected (shift+drag in edit mode) only that part
                is regenerated — notes around it stay and the new steps connect
                to them.
              </div>
            </details>
            <details className="tips">
              <summary>tap along (play)</summary>
              <div>
                While the music plays, just press a panel key — judging starts
                from that moment and the counters appear on the field. Pause
                (<b>space</b>), seek, or <b>Esc</b> clears it quietly; there is
                no results screen.<br />
                Default keys match the pad shape: <b>Q</b> ↖ · <b>E</b> ↗ ·{' '}
                <b>S</b> center · <b>Z</b> ↙ · <b>C</b> ↘ (numpad 7 9 5 1 3
                also work). Change them in the <b>play keys</b> section.<br />
                Judgments use the StepMania engine windows XSanity is built on:
                perfect ±45 ms, great ±90, good ±135, bad ±180, else miss.
                Bad and miss break the combo. Holds must be kept pressed until
                the end.<br />
                If every hit feels early or late, set <b>input offset</b> in
                the view section (positive = you press later than the music).
              </div>
            </details>
            <details className="tips">
              <summary>workflow</summary>
              <div>
                Everything autosaves. <b>revisions</b> keeps the last 20 states
                from before each regenerate — restore anytime.<br />
                Use <b>A/B</b> to loop a tricky section while tuning it.<br />
                <b>coverage</b> (under metrics) is how much of the chart came
                from real pattern matches — higher usually plays better.<br />
                When happy, go back to the project page and{' '}
                <b>publish to Songs</b> — XSanity picks it up on rescan.
              </div>
            </details>
          </section>

          <section>
            <h3>keys</h3>
            <div className="muted" style={{ lineHeight: 1.9 }}>
              <span className="kbd">space</span> play/pause · <span className="kbd">←→</span> ±5s ·{' '}
              <span className="kbd">Tab</span> edit · <span className="kbd">[</span><span className="kbd">]</span> A/B loop ·{' '}
              <span className="kbd">\</span> clear loop · <span className="kbd">Home</span> first note ·{' '}
              <span className="kbd">ctrl+Z</span> undo · <span className="kbd">Del</span> delete selection<br />
              edit: click tap · drag hold · right-click delete · shift+drag select · wheel scrub<br />
              tap along (while music plays): {binds.map((key, panel) => (
                <span key={panel}><span className="kbd">{keyLabel(key)}</span>{PANEL_GLYPHS[panel]}{' '}</span>
              ))}· <span className="kbd">Esc</span> clears
            </div>
          </section>
        </div>
      </div>

      <div className="transport">
        <button className="primary" onClick={togglePlay} style={{ width: 74 }}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button onClick={() => seek(getTime() - 5)}>−5s</button>
        <button onClick={() => seek(getTime() + 5)}>+5s</button>
        <button onClick={() => seek(Math.max(0, firstNoteTime - 1))} title="jump to first note">⇤ first</button>
        <span className="time">{fmtTime(curTime)} / {fmtTime(duration)}</span>
        <input
          className="seek" type="range" min={0} max={duration || 1} step={0.01} value={Math.min(curTime, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <select
          value={rate}
          onChange={(e) => {
            const r = Number(e.target.value);
            setRate(r);
            if (audioRef.current) {
              audioRef.current.playbackRate = r;
              audioRef.current.preservesPitch = true;
              syncVideo(playing);
            }
          }}
        >
          {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
        </select>
        <button className={loopA != null ? 'active' : ''} onClick={() => setLoopA(loopA == null ? getTime() : null)}>A</button>
        <button className={loopB != null ? 'active' : ''} onClick={() => setLoopB(loopB == null ? getTime() : null)}>B</button>
      </div>
    </div>
  );
}
