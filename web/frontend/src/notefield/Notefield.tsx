import { useEffect, useMemo, useRef } from 'react';
import { JUDGMENT_COLORS, type PlaySession } from '../play';
import type { Selection } from '../store';
import { ROWS_PER_BEAT, SongTiming } from '../timing';
import type { Note } from '../types';
import type { ValidationError } from '../validate';
import { loadNoteskin, type Noteskin } from './noteskin';
import { LANE_COLORS, TIER_COLORS, makeSprites } from './sprites';

export const LANE_W = 64;
const NOTE = 56;
const RECEPTOR_MARGIN = 96;

export interface NotefieldProps {
  notes: Note[];
  timing: SongTiming;
  getTime: () => number; // smoothed playback clock, seconds
  pxPerBeat: number;
  scrollDir: 'rise' | 'fall';
  provenance: boolean;
  editMode: boolean;
  playSession: PlaySession | null;
  snapRows: number;
  selection: Selection | null;
  errors: ValidationError[];
  loopA: number | null;
  loopB: number | null;
  onScrub: (deltaBeats: number) => void;
  onTap: (row: number, panel: number) => void;
  onHold: (row: number, endRow: number, panel: number) => void;
  onDelete: (row: number, panel: number) => void;
  onSelect: (sel: Selection | null) => void;
}

interface DragState {
  kind: 'note' | 'select';
  lane: number;
  startRow: number;
  currentRow: number;
}

export default function Notefield(props: NotefieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const dragRef = useRef<DragState | null>(null);
  const hoverRef = useRef<{ lane: number; row: number } | null>(null);

  const maxHoldRows = useMemo(
    () => Math.max(0, ...props.notes.map((n) => (n.holdEndRow ?? n.row) - n.row)),
    [props.notes],
  );
  const maxHoldRef = useRef(maxHoldRows);
  maxHoldRef.current = maxHoldRows;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const parent = canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const sprites = makeSprites(NOTE, dpr);
    let skin: Noteskin | null = null;
    void loadNoteskin().then((s) => { skin = s; });
    let raf = 0;

    const resize = () => {
      canvas.width = Math.round(parent.clientWidth * dpr);
      canvas.height = Math.round(parent.clientHeight * dpr);
      canvas.style.width = `${parent.clientWidth}px`;
      canvas.style.height = `${parent.clientHeight}px`;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    resize();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const p = propsRef.current;
      const ctx = canvas.getContext('2d')!;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const fieldW = LANE_W * 5;
      const x0 = Math.round((w - fieldW) / 2);
      const rise = p.scrollDir === 'rise';
      const receptorY = rise ? RECEPTOR_MARGIN : h - RECEPTOR_MARGIN;
      const dir = rise ? 1 : -1;
      const time = p.getTime();
      const curBeat = p.timing.beatAt(time);
      const yOf = (beat: number) => receptorY + dir * (beat - curBeat) * p.pxPerBeat;
      const beatOf = (y: number) => curBeat + (dir * (y - receptorY)) / p.pxPerBeat;

      const beatLo = Math.min(beatOf(-NOTE), beatOf(h + NOTE));
      const beatHi = Math.max(beatOf(-NOTE), beatOf(h + NOTE));

      // lane backdrop + beat/measure lines are editor chrome — the game
      // field stays clean during playback
      if (p.editMode) {
        ctx.fillStyle = 'rgba(255,255,255,0.028)';
        ctx.fillRect(x0, 0, fieldW, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let l = 0; l <= 5; l++) {
          ctx.beginPath();
          ctx.moveTo(x0 + l * LANE_W + 0.5, 0);
          ctx.lineTo(x0 + l * LANE_W + 0.5, h);
          ctx.stroke();
        }
        for (let b = Math.max(0, Math.floor(beatLo)); b <= beatHi; b++) {
          const y = yOf(b);
          const measure = b % 4 === 0;
          ctx.strokeStyle = measure ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
          ctx.beginPath();
          ctx.moveTo(x0, Math.round(y) + 0.5);
          ctx.lineTo(x0 + fieldW, Math.round(y) + 0.5);
          ctx.stroke();
          if (measure) {
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.font = '11px ui-monospace, monospace';
            ctx.textAlign = 'right';
            ctx.fillText(String(b / 4), x0 - 8, y + 4);
          }
        }
      }
      // edit-mode snap grid
      if (p.editMode && p.pxPerBeat >= 48) {
        ctx.strokeStyle = 'rgba(120,170,255,0.10)';
        const step = p.snapRows / ROWS_PER_BEAT;
        for (let b = Math.max(0, Math.ceil(beatLo / step) * step); b <= beatHi; b += step) {
          const y = yOf(b);
          ctx.beginPath();
          ctx.moveTo(x0, Math.round(y) + 0.5);
          ctx.lineTo(x0 + fieldW, Math.round(y) + 0.5);
          ctx.stroke();
        }
      }

      // selection band
      if (p.selection) {
        const yA = yOf(p.selection.startRow / ROWS_PER_BEAT);
        const yB = yOf(p.selection.endRow / ROWS_PER_BEAT);
        ctx.fillStyle = 'rgba(90,140,255,0.14)';
        ctx.fillRect(x0, Math.min(yA, yB), fieldW, Math.abs(yB - yA) || 2);
        ctx.strokeStyle = 'rgba(120,160,255,0.7)';
        for (const y of [yA, yB]) {
          ctx.beginPath();
          ctx.moveTo(x0, Math.round(y) + 0.5);
          ctx.lineTo(x0 + fieldW, Math.round(y) + 0.5);
          ctx.stroke();
        }
      }

      // A/B loop markers
      for (const [t, label, color] of [
        [p.loopA, 'A', '#ffd166'],
        [p.loopB, 'B', '#ef7674'],
      ] as const) {
        if (t == null) continue;
        const y = yOf(p.timing.beatAt(t));
        if (y < -20 || y > h + 20) continue;
        ctx.strokeStyle = color;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(x0 - 24, Math.round(y) + 0.5);
        ctx.lineTo(x0 + fieldW + 24, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(label, x0 + fieldW + 28, y + 4);
      }

      const rowLo = Math.floor(beatLo * ROWS_PER_BEAT) - maxHoldRef.current;
      const rowHi = Math.ceil(beatHi * ROWS_PER_BEAT);
      const visible: { n: Note; idx: number }[] = [];
      for (let i = 0; i < p.notes.length; i++) {
        const n = p.notes[i];
        if (n.row >= rowLo && n.row <= rowHi) visible.push({ n, idx: i });
      }
      const ps = p.playSession;
      ps?.tick(time);

      // hold bodies: game strip + bottom cap when the skin is loaded,
      // colored tube with metallic rails + faded tail arrow otherwise
      for (const { n, idx } of visible) {
        if (n.holdEndRow == null) continue;
        if (!p.editMode && p.timing.rowTime(n.holdEndRow) < time - 0.03) continue;
        for (const panel of n.panels) {
          let yHead = yOf(n.row / ROWS_PER_BEAT);
          const yTail = yOf(n.holdEndRow / ROWS_PER_BEAT);
          const headPassed = p.timing.rowTime(n.row) <= time;
          let dim = false;
          if (ps) {
            if (ps.isHit(idx, panel)) {
              if (headPassed) yHead = receptorY; // held: drain into the receptor
            } else if (headPassed) {
              dim = true; // missed or not-yet-judged overdue hold scrolls by
            }
          } else if (!p.editMode && headPassed) {
            yHead = receptorY;
          }
          if (dim) ctx.globalAlpha = 0.4;
          const nx = x0 + panel * LANE_W + (LANE_W - NOTE) / 2;
          const body = skin?.holdBodies[panel];
          if (!p.provenance && skin && body) {
            const top = Math.min(yHead, yTail);
            const hh = Math.abs(yTail - yHead);
            if (hh > 0) ctx.drawImage(body, nx, top, NOTE, hh);
            const cap = skin.holdCaps[panel];
            if (cap) {
              if (yTail < yHead) { // fall mode: cap points the other way
                ctx.save();
                ctx.translate(0, yTail);
                ctx.scale(1, -1);
                ctx.drawImage(cap, nx, -NOTE / 2, NOTE, NOTE);
                ctx.restore();
              } else {
                ctx.drawImage(cap, nx, yTail - NOTE / 2, NOTE, NOTE);
              }
            }
            ctx.globalAlpha = 1;
            continue;
          }
          const color = p.provenance ? TIER_COLORS[n.origin.tier] : LANE_COLORS[panel];
          const cx = x0 + panel * LANE_W + LANE_W / 2;
          const bw = NOTE * 0.64;
          const top = Math.min(yHead, yTail);
          const hh = Math.abs(yTail - yHead);
          const grad = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
          grad.addColorStop(0, color + '66');
          grad.addColorStop(0.5, color + 'cc');
          grad.addColorStop(1, color + '66');
          ctx.fillStyle = grad;
          ctx.strokeStyle = 'rgba(200,208,224,0.55)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(cx - bw / 2, top, bw, hh, bw / 2);
          ctx.fill();
          ctx.stroke();
          // tail cap: the same arrow, faded
          const sprite = p.provenance
            ? sprites.byTier[n.origin.tier]?.[panel] ?? sprites.byLane[panel]
            : sprites.byLane[panel];
          ctx.globalAlpha = 0.45;
          ctx.drawImage(sprite, nx, yTail - NOTE / 2, NOTE, NOTE);
          ctx.globalAlpha = 1;
        }
      }

      // receptors: the game's grey "ready" arrows (frames: idle / pressed /
      // glow outline), pulsing to the beat and flashing on hits
      const phase = ((curBeat % 1) + 1) % 1;
      const hitGlow = new Array<number>(5).fill(0);
      if (!p.editMode && !ps) {
        for (const { n } of visible) {
          const dt = time - p.timing.rowTime(n.row);
          if (dt < -0.02 || dt > 0.13) continue;
          const glow = 1 - dt / 0.13;
          for (const panel of n.panels) hitGlow[panel] = Math.max(hitGlow[panel], glow);
        }
      }
      if (ps) {
        // pressed panels light their receptor
        for (let lane = 0; lane < 5; lane++) {
          if (ps.keysDown[lane]) hitGlow[lane] = 1;
        }
      }
      for (let lane = 0; lane < 5; lane++) {
        const rx = x0 + lane * LANE_W + (LANE_W - NOTE) / 2;
        const ry = receptorY - NOTE / 2;
        if (skin) {
          const sheet = skin.receptors[lane];
          const fw = sheet.width / 3;
          ctx.drawImage(sheet, 0, 0, fw, sheet.height, rx, ry, NOTE, NOTE);
          const beatPulse = Math.max(0, 1 - phase * 2.5) * 0.55;
          const glow = Math.max(beatPulse, hitGlow[lane]);
          if (hitGlow[lane] > 0) {
            ctx.globalAlpha = hitGlow[lane];
            ctx.drawImage(sheet, fw, 0, fw, sheet.height, rx, ry, NOTE, NOTE);
          }
          if (glow > 0.01) {
            ctx.globalAlpha = glow;
            ctx.drawImage(sheet, fw * 2, 0, fw, sheet.height, rx, ry, NOTE, NOTE);
          }
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = Math.min(1, 0.6 + 0.4 * (1 - phase));
          ctx.drawImage(sprites.receptors[lane], rx, ry, NOTE, NOTE);
          ctx.globalAlpha = 1;
          if (hitGlow[lane] > 0) {
            const cx = x0 + lane * LANE_W + LANE_W / 2;
            const g = ctx.createRadialGradient(cx, receptorY, 2, cx, receptorY, NOTE * 0.75);
            g.addColorStop(0, `rgba(255,255,255,${0.55 * hitGlow[lane]})`);
            g.addColorStop(0.4, LANE_COLORS[lane] + Math.round(80 * hitGlow[lane]).toString(16).padStart(2, '0'));
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(cx, receptorY, NOTE * 0.75, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // notes (playback: taps vanish at the receptors, active holds pin
      // there; play mode: taps vanish only when HIT, misses scroll past)
      for (const { n, idx } of visible) {
        const yBase = yOf(n.row / ROWS_PER_BEAT);
        const tHead = p.timing.rowTime(n.row);
        for (const panel of n.panels) {
          let y = yBase;
          if (ps) {
            if (ps.isHit(idx, panel)) {
              if (n.holdEndRow == null) continue; // hit tap: gone
              if (p.timing.rowTime(n.holdEndRow) < time - 0.03) continue;
              if (tHead <= time) y = receptorY;   // held: pinned
            } else if (ps.isMissed(idx, panel)) {
              ctx.globalAlpha = 0.4;              // miss: scrolls past, dim
            }
          } else if (!p.editMode) {
            if (n.holdEndRow == null) {
              if (tHead < time - 0.03) continue;
            } else {
              if (p.timing.rowTime(n.holdEndRow) < time - 0.03) continue;
              if (tHead <= time) y = receptorY;
            }
          }
          const nx = x0 + panel * LANE_W + (LANE_W - NOTE) / 2;
          if (!p.provenance && skin) {
            const sheet = skin.taps[panel];
            const fw = sheet.width / 6;
            const frame = p.editMode ? 0 : Math.floor(phase * 6) % 6;
            ctx.drawImage(sheet, frame * fw, 0, fw, sheet.height, nx, y - NOTE / 2, NOTE, NOTE);
          } else {
            const sprite = p.provenance
              ? sprites.byTier[n.origin.tier]?.[panel] ?? sprites.byLane[panel]
              : sprites.byLane[panel];
            ctx.drawImage(sprite, nx, y - NOTE / 2, NOTE, NOTE);
          }
          ctx.globalAlpha = 1;
        }
      }

      // play-mode HUD: judgment popup, combo, running counts
      if (ps) {
        const now = performance.now() / 1000;
        const lj = ps.lastJudgment;
        const cxField = x0 + fieldW / 2;
        const judgeY = rise ? receptorY + 170 : receptorY - 200;
        if (lj && now - lj.at < 0.7) {
          const age = now - lj.at;
          const alpha = age < 0.45 ? 1 : 1 - (age - 0.45) / 0.25;
          const scale = 1 + Math.max(0, 0.3 - age * 2.5);
          ctx.save();
          ctx.translate(cxField, judgeY);
          ctx.scale(scale, scale);
          ctx.globalAlpha = alpha;
          ctx.font = 'bold 30px "Segoe UI", sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 5;
          ctx.strokeStyle = 'rgba(10,12,18,0.85)';
          ctx.strokeText(lj.judgment.toUpperCase(), 0, 0);
          ctx.fillStyle = JUDGMENT_COLORS[lj.judgment];
          ctx.fillText(lj.judgment.toUpperCase(), 0, 0);
          ctx.restore();
        }
        if (ps.combo >= 2) {
          ctx.font = 'bold 22px "Segoe UI", sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(10,12,18,0.85)';
          ctx.strokeText(`${ps.combo} COMBO`, cxField, judgeY + 32);
          ctx.fillStyle = '#ffd166';
          ctx.fillText(`${ps.combo} COMBO`, cxField, judgeY + 32);
        }
        ctx.font = '12px ui-monospace, monospace';
        ctx.textAlign = 'left';
        let hudY = 20;
        for (const [j, count] of Object.entries(ps.counts)) {
          ctx.fillStyle = JUDGMENT_COLORS[j as keyof typeof JUDGMENT_COLORS];
          ctx.fillText(`${j.padEnd(7)} ${count}`, 12, hudY);
          hudY += 16;
        }
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText(`acc ${(ps.accuracy() * 100).toFixed(1)}%`, 12, hudY + 4);
      }

      // validation markers
      for (const err of p.errors) {
        const y = yOf(err.row / ROWS_PER_BEAT);
        if (y < -NOTE || y > h + NOTE) continue;
        ctx.strokeStyle = '#ff3355';
        ctx.lineWidth = 2.5;
        if (err.panel != null) {
          ctx.beginPath();
          ctx.arc(x0 + err.panel * LANE_W + LANE_W / 2, y, NOTE * 0.58, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.strokeRect(x0 - 4, y - NOTE / 2, fieldW + 8, NOTE);
        }
      }

      // hover cell + drag preview (edit mode)
      if (p.editMode) {
        const drag = dragRef.current;
        if (drag && drag.kind === 'note') {
          const lo = Math.min(drag.startRow, drag.currentRow);
          const hi = Math.max(drag.startRow, drag.currentRow);
          const cx = x0 + drag.lane * LANE_W + LANE_W / 2;
          const yA = yOf(lo / ROWS_PER_BEAT);
          const yB = yOf(hi / ROWS_PER_BEAT);
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.beginPath();
          ctx.roundRect(cx - NOTE * 0.31, Math.min(yA, yB) - 6, NOTE * 0.62, Math.abs(yB - yA) + 12, 12);
          ctx.fill();
        } else if (drag && drag.kind === 'select') {
          const yA = yOf(drag.startRow / ROWS_PER_BEAT);
          const yB = yOf(drag.currentRow / ROWS_PER_BEAT);
          ctx.fillStyle = 'rgba(90,140,255,0.18)';
          ctx.fillRect(x0, Math.min(yA, yB), fieldW, Math.abs(yB - yA) || 2);
        } else if (hoverRef.current) {
          const { lane, row } = hoverRef.current;
          const y = yOf(row / ROWS_PER_BEAT);
          ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x0 + lane * LANE_W + 4, y - NOTE / 2, LANE_W - 8, NOTE);
        }
      }

      // HUD
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(
        `${time.toFixed(2)}s  beat ${curBeat.toFixed(2)}  measure ${Math.floor(curBeat / 4)}`,
        12,
        h - 12,
      );
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // -------------------------------------------------- interaction helpers

  function fieldGeometry() {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const p = propsRef.current;
    const rise = p.scrollDir === 'rise';
    const receptorY = rise ? RECEPTOR_MARGIN : rect.height - RECEPTOR_MARGIN;
    const dir = rise ? 1 : -1;
    const x0 = (rect.width - LANE_W * 5) / 2;
    return { rect, receptorY, dir, x0, p };
  }

  function eventCell(e: React.PointerEvent | React.MouseEvent, snap: boolean) {
    const { rect, receptorY, dir, x0, p } = fieldGeometry();
    const x = e.clientX - rect.left - x0;
    const y = e.clientY - rect.top;
    const lane = Math.floor(x / LANE_W);
    const beat = p.timing.beatAt(p.getTime()) + (dir * (y - receptorY)) / p.pxPerBeat;
    let row = Math.round(beat * ROWS_PER_BEAT);
    if (snap) row = Math.round(row / p.snapRows) * p.snapRows;
    return { lane, row: Math.max(0, row), inField: lane >= 0 && lane < 5 };
  }

  function onPointerDown(e: React.PointerEvent) {
    const p = propsRef.current;
    if (!p.editMode || e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch { /* synthetic events have no active pointer */ }
    const { lane, row, inField } = eventCell(e, true);
    if (e.shiftKey) {
      dragRef.current = { kind: 'select', lane: 0, startRow: row, currentRow: row };
    } else if (inField) {
      dragRef.current = { kind: 'note', lane, startRow: row, currentRow: row };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = propsRef.current;
    if (!p.editMode) return;
    const { lane, row, inField } = eventCell(e, true);
    hoverRef.current = inField ? { lane, row } : null;
    if (dragRef.current) dragRef.current.currentRow = row;
  }

  function onPointerUp(e: React.PointerEvent) {
    const p = propsRef.current;
    const drag = dragRef.current;
    dragRef.current = null;
    if (!p.editMode || !drag) return;
    const lo = Math.min(drag.startRow, drag.currentRow);
    const hi = Math.max(drag.startRow, drag.currentRow);
    if (drag.kind === 'select') {
      if (hi - lo >= p.snapRows) p.onSelect({ startRow: lo, endRow: hi });
      else p.onSelect(null);
      return;
    }
    if (hi - lo >= p.snapRows) p.onHold(lo, hi, drag.lane);
    else p.onTap(lo, drag.lane);
  }

  function onContextMenu(e: React.MouseEvent) {
    const p = propsRef.current;
    e.preventDefault();
    if (!p.editMode) return;
    const { lane, row, inField } = eventCell(e, false);
    if (!inField) return;
    // find head near the cursor first, then a hold body under it
    const tol = Math.max(2, Math.round((p.snapRows || 3) / 2));
    const head = p.notes.find(
      (n) => n.panels.includes(lane) && Math.abs(n.row - row) <= tol,
    );
    if (head) p.onDelete(head.row, lane);
    else p.onDelete(row, lane);
  }

  function onWheel(e: React.WheelEvent) {
    const p = propsRef.current;
    if (!p.editMode) return;
    const steps = e.deltaY > 0 ? 1 : -1;
    const beats = (e.altKey ? 4 : p.snapRows / ROWS_PER_BEAT) * steps;
    p.onScrub(beats);
  }

  return (
    <canvas
      ref={canvasRef}
      className="notefield"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
      onWheel={onWheel}
    />
  );
}
