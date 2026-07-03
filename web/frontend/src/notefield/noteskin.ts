// Loads the real game sprites (a StepMania pump noteskin served by the web
// server from the XSanity install). Falls back to the drawn skin when the
// server has no noteskin configured.

export interface Noteskin {
  taps: HTMLImageElement[];       // 6x1 sheets, one per lane
  receptors: HTMLImageElement[];  // 3x1 sheets: idle / pressed / glow
  holdBodies: (HTMLImageElement | null)[]; // thin strips, stretched vertically
  holdCaps: (HTMLImageElement | null)[];   // arrow-shaped tail caps
}

let cached: Promise<Noteskin | null> | null = null;

export function loadNoteskin(): Promise<Noteskin | null> {
  cached ??= load().catch(() => null);
  return cached;
}

async function load(): Promise<Noteskin | null> {
  const res = await fetch('/api/noteskin/manifest');
  if (!res.ok) return null;
  const manifest = (await res.json()) as { available: boolean; keys: string[] };
  if (!manifest.available) return null;
  const keys = new Set(manifest.keys);

  const img = (key: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`noteskin sprite ${key} failed`));
      el.src = `/api/noteskin/${key}`;
    });
  const opt = (key: string): Promise<HTMLImageElement | null> =>
    keys.has(key) ? img(key).catch(() => null) : Promise.resolve(null);

  const lanes = [0, 1, 2, 3, 4];
  const [taps, receptors, holdBodies, holdCaps] = await Promise.all([
    Promise.all(lanes.map((l) => img(`tap-${l}`))),
    Promise.all(lanes.map((l) => img(`receptor-${l}`))),
    Promise.all(lanes.map((l) => opt(`holdbody-${l}`))),
    Promise.all(lanes.map((l) => opt(`holdcap-${l}`))),
  ]);
  return { taps, receptors, holdBodies, holdCaps };
}
