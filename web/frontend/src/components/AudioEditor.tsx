import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { AudioSegment, Project } from '../types';

const round = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const time = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}.${String(Math.round((n % 1) * 1000)).padStart(3, '0')}`;

interface TimelineProps {
  duration: number; segments: AudioSegment[]; peaks: number[]; playhead: number;
  fade: boolean; fadeStart: number; fadeEnd: number;
  onSeek: (sourceTime: number) => void; onSegments: (segments: AudioSegment[]) => void;
  onFade: (start: number, end: number) => void;
}

function WaveformTimeline(props: TimelineProps) {
  const { duration, segments, peaks, playhead, fade, fadeStart, fadeEnd } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const outputDuration = segments.reduce((n, s) => n + s.end - s.start, 0);
  const offsets = useMemo(() => {
    let at = 0;
    return segments.map((s) => { const out = { start: at, end: at + s.end - s.start }; at = out.end; return out; });
  }, [segments]);
  const sourceToOutput = (source: number) => {
    let output = 0;
    for (const segment of segments) {
      if (source < segment.start) return output;
      if (source <= segment.end) return output + source - segment.start;
      output += segment.end - segment.start;
    }
    return output;
  };
  const outputToSource = (out: number) => {
    const i = offsets.findIndex((s) => out >= s.start && out <= s.end);
    return i < 0 ? segments.at(-1)?.end ?? 0 : segments[i].start + out - offsets[i].start;
  };

  useEffect(() => {
    const el = canvas.current; const host = wrap.current;
    if (!el || !host || !duration || !outputDuration) return;
    const rect = host.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    const height = 112;
    el.width = Math.max(1, Math.round(rect.width * dpr)); el.height = Math.round(height * dpr);
    el.style.width = `${rect.width}px`; el.style.height = `${height}px`;
    const ctx = el.getContext('2d'); if (!ctx) return;
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, rect.width, height);
    ctx.fillStyle = '#090e14'; ctx.fillRect(0, 0, rect.width, height);
    ctx.strokeStyle = '#10243a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(rect.width, height / 2); ctx.stroke();
    const mid = height / 2;
    ctx.fillStyle = '#0b2948';
    for (let x = 0; x < rect.width; x += 2) {
      const peak = peaks[Math.min(peaks.length - 1, Math.floor(x / rect.width * peaks.length))] ?? 0;
      const h = Math.max(1, peak * 48); ctx.fillRect(x, mid - h, 1.5, h * 2);
    }
    segments.forEach((segment, i) => {
      const x0 = segment.start / duration * rect.width;
      const x1 = segment.end / duration * rect.width;
      ctx.fillStyle = 'rgba(28,91,158,.08)'; ctx.fillRect(x0, 0, x1 - x0, height);
      ctx.fillStyle = '#287fe8';
      for (let x = Math.ceil(x0); x < x1; x += 2) {
        const peak = peaks[Math.min(peaks.length - 1, Math.floor(x / rect.width * peaks.length))] ?? 0;
        const h = Math.max(1, peak * 48); ctx.fillRect(x, mid - h, 1.5, h * 2);
      }
      if (i) { ctx.fillStyle = '#07101c'; ctx.fillRect(x0 - 2, 0, 4, height); }
    });
  }, [duration, outputDuration, peaks, segments, offsets]);

  const pointerTime = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width * duration, 0, duration);
  };
  const drag = (move: (outputTime: number) => void) => (e: React.PointerEvent) => {
    e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const target = e.currentTarget as HTMLElement;
    const onMove = (event: PointerEvent) => move(pointerTime(event.clientX));
    const done = () => { target.removeEventListener('pointermove', onMove); target.removeEventListener('pointerup', done); };
    target.addEventListener('pointermove', onMove); target.addEventListener('pointerup', done);
  };
  const trim = (index: number, edge: 'start' | 'end', source: number) => {
    const current = segments[index];
    const previousEnd = index > 0 ? segments[index - 1].end : 0;
    const nextStart = index < segments.length - 1 ? segments[index + 1].start : duration;
    props.onSegments(segments.map((s, i) => i !== index ? s : edge === 'start'
      ? { ...s, start: round(clamp(source, previousEnd, s.end - .05)) }
      : { ...s, end: round(clamp(source, s.start + .05, nextStart)) }));
  };

  return <div className="wave-timeline" ref={wrap} onPointerDown={(e) => props.onSeek(pointerTime(e.clientX))}>
    <canvas ref={canvas} />
    {segments.map((segment, i) => <div key={i} className="clip-overlay" style={{ left: `${segment.start / duration * 100}%`, width: `${(segment.end - segment.start) / duration * 100}%` }}>
      <button aria-label={`Trim clip ${i + 1} start`} className="trim-handle left" onPointerDown={drag((out) => trim(i, 'start', out))} />
      <button aria-label={`Trim clip ${i + 1} end`} className="trim-handle right" onPointerDown={drag((out) => trim(i, 'end', out))} />
    </div>)}
    {fade && <div className="fade-region" style={{ left: `${outputToSource(fadeStart) / duration * 100}%`, width: `${(outputToSource(fadeEnd) - outputToSource(fadeStart)) / duration * 100}%` }}>
      <span>FADE OUT</span>
      <button aria-label="Move fade start" className="fade-handle start" onPointerDown={drag((source) => props.onFade(round(clamp(sourceToOutput(source), 0, fadeEnd - .05)), fadeEnd))} />
      <button aria-label="Move full fade" className="fade-handle end" onPointerDown={drag((source) => props.onFade(fadeStart, round(clamp(sourceToOutput(source), fadeStart + .05, outputDuration))))} />
    </div>}
    <div className="timeline-playhead" style={{ left: `${playhead / duration * 100}%` }}><i /></div>
  </div>;
}

export default function AudioEditor({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const previewFrame = useRef<number | null>(null);
  const [duration, setDuration] = useState(0); const [segments, setSegments] = useState<AudioSegment[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]); const [playhead, setPlayhead] = useState(0);
  const [fade, setFade] = useState(false); const [fadeStart, setFadeStart] = useState(0); const [fadeEnd, setFadeEnd] = useState(0);
  const [busy, setBusy] = useState(false); const [playing, setPlaying] = useState(false); const [progress, setProgress] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const outputDuration = useMemo(() => segments.reduce((n, s) => n + s.end - s.start, 0), [segments]);

  useEffect(() => {
    if (!outputDuration || !fade) return;
    if (fadeEnd > outputDuration) setFadeEnd(round(outputDuration));
    if (fadeStart >= outputDuration) setFadeStart(round(Math.max(0, outputDuration - Math.min(5, outputDuration))));
  }, [outputDuration, fade, fadeStart, fadeEnd]);

  useEffect(() => {
    api.audioEditor(project.id).then(async ({ duration: d, edit }) => {
      setDuration(d); setSegments(edit?.segments ?? [{ start: 0, end: d }]); setFade(edit?.fadeStart != null && edit?.fadeEnd != null);
      setFadeStart(edit?.fadeStart ?? Math.max(0, (edit?.outputDuration ?? d) - 5)); setFadeEnd(edit?.fadeEnd ?? (edit?.outputDuration ?? d));
      const buffer = await fetch(api.audioSourceUrl(project.id)).then((r) => r.arrayBuffer());
      const decoded = await new AudioContext().decodeAudioData(buffer); const channel = decoded.getChannelData(0); const bins = 1800; const next: number[] = [];
      for (let i = 0; i < bins; i++) { const from = Math.floor(i / bins * channel.length); const to = Math.floor((i + 1) / bins * channel.length); let peak = 0; for (let j = from; j < to; j += Math.max(1, Math.floor((to - from) / 24))) peak = Math.max(peak, Math.abs(channel[j])); next.push(peak); }
      setPeaks(next);
    }).catch((e) => setError((e as Error).message));
  }, [project.id, project.song.audioEdit]);

  const sourceOutputTime = (sourceTime: number) => {
    let output = 0;
    for (const segment of segments) {
      if (sourceTime >= segment.start && sourceTime <= segment.end + .01) return output + clamp(sourceTime - segment.start, 0, segment.end - segment.start);
      output += segment.end - segment.start;
    }
    return output;
  };
  const previewVolume = (sourceTime: number) => {
    if (!fade) return 1;
    const output = sourceOutputTime(sourceTime);
    if (output <= fadeStart) return 1;
    if (output >= fadeEnd) return 0;
    return clamp(1 - (output - fadeStart) / (fadeEnd - fadeStart), 0, 1);
  };
  const seek = (sourceTime: number) => {
    if (audio.current) { audio.current.currentTime = sourceTime; audio.current.volume = previewVolume(sourceTime); }
    setPlayhead(sourceTime);
  };
  const followPlayback = (element: HTMLAudioElement) => {
    const at = element.currentTime;
    element.volume = previewVolume(at);
    if (segments.some((s) => at >= s.start - .01 && at <= s.end + .01)) return setPlayhead(at);
    const next = segments.find((s) => s.start > at);
    if (next) { element.currentTime = next.start; setPlayhead(next.start); }
    else { element.pause(); setPlayhead(segments.at(-1)?.end ?? at); }
  };
  const split = () => { const at = playhead; const i = segments.findIndex((s) => at > s.start + .01 && at < s.end - .01); if (i < 0) return setError('Place the playhead inside a clip before splitting.'); setSegments([...segments.slice(0, i), { start: segments[i].start, end: round(at) }, { start: round(at), end: segments[i].end }, ...segments.slice(i + 1)]); };
  const removeAtPlayhead = () => { const i = segments.findIndex((s) => playhead >= s.start && playhead <= s.end); if (i >= 0 && segments.length > 1) setSegments(segments.filter((_, index) => index !== i)); };
  const togglePlayback = () => {
    const element = audio.current; if (!element) return;
    if (element.paused) void element.play(); else element.pause();
  };
  const startPreviewLoop = () => {
    if (previewFrame.current != null) cancelAnimationFrame(previewFrame.current);
    const tick = () => {
      const element = audio.current;
      if (!element || element.paused) { previewFrame.current = null; return; }
      followPlayback(element); previewFrame.current = requestAnimationFrame(tick);
    };
    previewFrame.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
      else if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); split(); }
      else if (event.key === 'Delete') { event.preventDefault(); removeAtPlayhead(); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  useEffect(() => {
    if (audio.current) audio.current.volume = previewVolume(audio.current.currentTime);
  }, [fade, fadeStart, fadeEnd, segments]);

  useEffect(() => () => { if (previewFrame.current != null) cancelAnimationFrame(previewFrame.current); }, []);
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      if (segments.some((s) => s.start < 0 || s.end > duration + .01 || s.end <= s.start)) throw new Error('Every clip needs a valid start and end.');
      if (fade && (fadeStart < 0 || fadeEnd <= fadeStart || fadeEnd > outputDuration + .01)) throw new Error('Fade must be inside the output.');
      setProgress('loading ffmpeg.wasm…'); const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([import('@ffmpeg/ffmpeg'), import('@ffmpeg/util')]); const ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress: p }) => setProgress(`rendering… ${clamp(Math.round(p * 100), 0, 100)}%`)); const core = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
      await ffmpeg.load({ coreURL: await toBlobURL(`${core}/ffmpeg-core.js`, 'text/javascript'), wasmURL: await toBlobURL(`${core}/ffmpeg-core.wasm`, 'application/wasm') });
      await ffmpeg.writeFile('input.audio', await fetchFile(api.audioSourceUrl(project.id))); const chains = segments.map((s, i) => `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`);
      let tail = segments.length === 1 ? '[a0]anull[out]' : `${segments.map((_, i) => `[a${i}]`).join('')}concat=n=${segments.length}:v=0:a=1[out]`; if (fade) tail = `${tail.replace('[out]', '[joined]')};[joined]afade=t=out:st=${fadeStart}:d=${fadeEnd - fadeStart}[out]`;
      const code = await ffmpeg.exec(['-i', 'input.audio', '-filter_complex', `${chains.join(';')};${tail}`, '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '2', 'output.mp3']); if (code) throw new Error('ffmpeg.wasm could not render this audio.');
      const rendered = await ffmpeg.readFile('output.mp3'); if (!(rendered instanceof Uint8Array)) throw new Error('Invalid rendered audio.'); const bytes = new Uint8Array(rendered); ffmpeg.terminate(); setProgress('saving…');
      onChange(await api.saveAudioEdit(project.id, new Blob([bytes], { type: 'audio/mpeg' }), { segments, fadeStart: fade ? fadeStart : null, fadeEnd: fade ? fadeEnd : null }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setProgress(null); }
  };

  return <div className="card audio-editor"><div className="audio-editor-head"><div><h2>Audio timeline</h2><p>Drag the blue edges to trim. Click the waveform to position the playhead.</p></div><span className="timecode">{time(playhead)}</span></div>
    <div className="timeline-toolbar"><button onClick={split}>✂ Split <kbd>S</kbd></button><button className="danger" disabled={segments.length < 2} onClick={removeAtPlayhead}>Delete clip <kbd>Del</kbd></button><label className="fade-toggle"><input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} /> Fade out</label></div>
    <WaveformTimeline duration={duration} segments={segments} peaks={peaks} playhead={playhead} fade={fade} fadeStart={fadeStart} fadeEnd={fadeEnd} onSeek={seek} onSegments={setSegments} onFade={(a, b) => { setFadeStart(a); setFadeEnd(b); }} />
    <audio ref={audio} preload="auto" src={`${api.audioSourceUrl(project.id)}?v=${encodeURIComponent(project.song.audioEdit?.sourceFile ?? project.song.audioFile)}`} onPlay={() => { setPlaying(true); startPreviewLoop(); }} onPause={() => { setPlaying(false); if (previewFrame.current != null) cancelAnimationFrame(previewFrame.current); previewFrame.current = null; }} onTimeUpdate={(e) => followPlayback(e.currentTarget)} />
    {fade && <div className="timeline-inspector"><label>Fade starts <input type="number" step=".001" value={fadeStart} onChange={(e) => setFadeStart(Number(e.target.value))} /></label><span>→</span><label>Fully silent <input type="number" step=".001" value={fadeEnd} onChange={(e) => setFadeEnd(Number(e.target.value))} /></label></div>}
    {error && <p className="error-text">{error}</p>}
    <div className="timeline-footer"><div className="timeline-summary">{segments.length} clip{segments.length === 1 ? '' : 's'} · new duration <b>{time(outputDuration)}</b></div><div className="timeline-footer-actions"><button className="preview-button" onClick={togglePlayback}>{playing ? 'Ⅱ Pause' : '▶ Preview'} <kbd>Space</kbd></button><button onClick={() => setSegments([{ start: 0, end: duration }])}>↶ Reset</button>{project.song.audioEdit && <button disabled={busy} onClick={() => void api.resetAudio(project.id).then(onChange)}>Restore original</button>}<button className="render-button" disabled={busy || !segments.length} onClick={() => void apply()}>✂ {busy ? progress ?? 'working…' : 'Render audio'}</button></div></div>
  </div>;
}
