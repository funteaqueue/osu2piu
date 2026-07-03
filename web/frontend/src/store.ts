import { create } from 'zustand';
import type { Chart, Note, Project } from './types';
import { validateNotes, type ValidationError } from './validate';

export interface Selection {
  startRow: number;
  endRow: number;
}

const MAX_UNDO = 200;

function manual(): Note['origin'] {
  return { tier: 'manual', sourceMeter: null };
}

function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.row - b.row || a.panels[0] - b.panels[0]);
}

interface EditorState {
  project: Project | null;
  chartId: string | null;
  notes: Note[];
  level: number;
  name: string;
  dirty: number; // bumped on every edit; autosave watches it
  undoStack: Note[][];
  redoStack: Note[][];
  selection: Selection | null;
  errors: ValidationError[];

  load: (project: Project, chartId: string) => void;
  replaceChart: (chart: Chart) => void;
  setNotes: (notes: Note[]) => void;
  setLevel: (level: number) => void;
  setName: (name: string) => void;
  toggleTap: (row: number, panel: number) => void;
  addHold: (row: number, endRow: number, panel: number) => void;
  deleteAt: (row: number, panel: number) => void;
  deleteSelection: () => void;
  nudgeSelection: (deltaRows: number) => void;
  setSelection: (sel: Selection | null) => void;
  undo: () => void;
  redo: () => void;
}

export const useEditor = create<EditorState>((set, get) => {
  function commit(notes: Note[]): void {
    const { notes: prev, undoStack, dirty } = get();
    set({
      notes: sortNotes(notes),
      undoStack: [...undoStack.slice(-MAX_UNDO), prev],
      redoStack: [],
      errors: validateNotes(notes),
      dirty: dirty + 1,
    });
  }

  /** note whose head sits at (row, panel) */
  function headAt(notes: Note[], row: number, panel: number): Note | undefined {
    return notes.find((n) => n.row === row && n.panels.includes(panel));
  }

  return {
    project: null,
    chartId: null,
    notes: [],
    level: 0,
    name: '',
    dirty: 0,
    undoStack: [],
    redoStack: [],
    selection: null,
    errors: [],

    load: (project, chartId) => {
      const chart = project.charts.find((c) => c.id === chartId);
      if (!chart) return;
      set({
        project,
        chartId,
        notes: sortNotes(chart.notes),
        level: chart.level,
        name: chart.name,
        dirty: 0,
        undoStack: [],
        redoStack: [],
        selection: null,
        errors: validateNotes(chart.notes),
      });
    },

    replaceChart: (chart) => {
      const { notes: prev, undoStack, dirty, project, chartId } = get();
      if (project && chartId) {
        const idx = project.charts.findIndex((c) => c.id === chartId);
        if (idx >= 0) project.charts[idx] = chart;
      }
      set({
        notes: sortNotes(chart.notes),
        level: chart.level,
        undoStack: [...undoStack.slice(-MAX_UNDO), prev],
        redoStack: [],
        errors: validateNotes(chart.notes),
        dirty: dirty + 1,
      });
    },

    setNotes: (notes) => commit(notes),

    setLevel: (level) => set({ level, dirty: get().dirty + 1 }),
    setName: (name) => set({ name, dirty: get().dirty + 1 }),

    toggleTap: (row, panel) => {
      const { notes } = get();
      const existing = headAt(notes, row, panel);
      if (existing) {
        if (existing.panels.length === 2) {
          commit(notes.map((n) => n === existing
            ? { ...n, panels: n.panels.filter((p) => p !== panel), origin: manual() }
            : n));
        } else {
          commit(notes.filter((n) => n !== existing));
        }
      } else {
        commit([...notes, { row, panels: [panel], holdEndRow: null, origin: manual() }]);
      }
    },

    addHold: (row, endRow, panel) => {
      const { notes } = get();
      const rest = notes.filter((n) => !(n.row === row && n.panels.length === 1 && n.panels[0] === panel));
      commit([...rest, { row, panels: [panel], holdEndRow: endRow > row ? endRow : null, origin: manual() }]);
    },

    deleteAt: (row, panel) => {
      const { notes } = get();
      const hit = notes.find((n) =>
        n.panels.includes(panel)
        && (n.row === row || (n.holdEndRow != null && n.row <= row && row <= n.holdEndRow)));
      if (!hit) return;
      if (hit.panels.length === 2 && hit.row === row) {
        commit(notes.map((n) => n === hit
          ? { ...n, panels: n.panels.filter((p) => p !== panel), origin: manual() }
          : n));
      } else {
        commit(notes.filter((n) => n !== hit));
      }
    },

    deleteSelection: () => {
      const { notes, selection } = get();
      if (!selection) return;
      commit(notes.filter((n) => n.row < selection.startRow || n.row > selection.endRow));
    },

    nudgeSelection: (deltaRows) => {
      const { notes, selection } = get();
      if (!selection) return;
      const inSel = (n: Note) => n.row >= selection.startRow && n.row <= selection.endRow;
      if (notes.some((n) => inSel(n) && n.row + deltaRows < 0)) return;
      commit(notes.map((n) => inSel(n)
        ? {
            ...n,
            row: n.row + deltaRows,
            holdEndRow: n.holdEndRow != null ? n.holdEndRow + deltaRows : null,
            origin: manual(),
          }
        : n));
      set({ selection: { startRow: selection.startRow + deltaRows, endRow: selection.endRow + deltaRows } });
    },

    setSelection: (selection) => set({ selection }),

    undo: () => {
      const { undoStack, redoStack, notes, dirty } = get();
      if (!undoStack.length) return;
      const prev = undoStack[undoStack.length - 1];
      set({
        notes: prev,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, notes],
        errors: validateNotes(prev),
        dirty: dirty + 1,
      });
    },

    redo: () => {
      const { undoStack, redoStack, notes, dirty } = get();
      if (!redoStack.length) return;
      const next = redoStack[redoStack.length - 1];
      set({
        notes: next,
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, notes],
        errors: validateNotes(next),
        dirty: dirty + 1,
      });
    },
  };
});
