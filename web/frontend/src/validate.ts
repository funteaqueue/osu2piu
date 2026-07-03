import type { Note } from './types';

export interface ValidationError {
  row: number;
  panel: number | null;
  message: string;
}

/** Same rules as the engine's expectations: hold integrity, at most two
 *  simultaneous panels, no note on a panel inside another note's hold body. */
export function validateNotes(notes: Note[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const holds: { row: number; end: number; panel: number }[] = [];
  const headsByRow = new Map<number, number[]>();

  for (const n of notes) {
    if (n.holdEndRow != null && n.holdEndRow <= n.row) {
      errors.push({ row: n.row, panel: n.panels[0], message: 'hold ends before it starts' });
    }
    if (n.panels.length === 0 || n.panels.length > 2) {
      errors.push({ row: n.row, panel: null, message: 'note must press 1 or 2 panels' });
    }
    const seen = headsByRow.get(n.row) ?? [];
    for (const p of n.panels) {
      if (seen.includes(p)) {
        errors.push({ row: n.row, panel: p, message: 'two notes on the same panel and row' });
      }
      seen.push(p);
      if (n.holdEndRow != null && n.holdEndRow > n.row) {
        holds.push({ row: n.row, end: n.holdEndRow, panel: p });
      }
    }
    headsByRow.set(n.row, seen);
  }

  // heads landing inside another hold's body on the same panel
  for (const n of notes) {
    for (const p of n.panels) {
      for (const h of holds) {
        if (p !== h.panel) continue;
        if (n.row === h.row && n.holdEndRow === h.end) continue; // itself
        if (n.row > h.row && n.row <= h.end) {
          errors.push({ row: n.row, panel: p, message: 'note inside a hold on the same panel' });
        }
      }
    }
  }

  // >2 simultaneous panels (heads + active hold bodies)
  const rows = [...headsByRow.keys()].sort((a, b) => a - b);
  for (const row of rows) {
    const pressed = new Set<number>(headsByRow.get(row));
    for (const h of holds) {
      if (h.row < row && row <= h.end) pressed.add(h.panel);
    }
    if (pressed.size > 2) {
      errors.push({ row, panel: null, message: `${pressed.size} panels pressed at once` });
    }
  }
  return errors;
}
