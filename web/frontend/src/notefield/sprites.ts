// Canvas-drawn PIU-style panels — authentic arrangement (upper arrows red,
// lower arrows blue, center yellow, fixed regardless of timing) and the
// classic look: dark outline, metallic silver border, glossy colored body.
// All drawn, no copyrighted assets.
//
// Lane order (pump-single columns): DL, UL, C, UR, DR.

export const LANE_COLORS = ['#2f74e8', '#e33641', '#f2b83a', '#e33641', '#2f74e8'];
// distinct hues on purpose — these must be tellable apart at a glance
export const TIER_COLORS: Record<string, string> = {
  exact: '#35d558',      // green
  downgrade: '#3b8bff',  // blue
  fallback: '#ff9d2e',   // orange
  jump: '#ff4fd8',       // magenta
  manual: '#f5f5f5',     // white
};
export const TIER_HINTS: Record<string, string> = {
  exact: 'rhythm + holds copied from a real PIU chart',
  downgrade: 'rhythm matched a real chart, holds re-added',
  fallback: 'no pattern fit — rule generator invented it',
  jump: 'two-panel press placed on a musical accent',
  manual: 'you placed or edited this note',
};

// arrow points outward: DL ↙, UL ↖, UR ↗, DR ↘ (clockwise from pointing up)
const LANE_ANGLES = [225, 315, 0, 45, 135];

const OUTLINE = '#0b0d13';
const SILVER_HI = '#eef1f7';
const SILVER_LO = '#848ca0';
const SILVER_DIM_HI = '#5d6474';
const SILVER_DIM_LO = '#343a48';

function arrowPath(ctx: CanvasRenderingContext2D, u: number): void {
  ctx.beginPath();
  ctx.moveTo(0, -14 * u);        // tip
  ctx.lineTo(13 * u, -1 * u);    // right head corner
  ctx.lineTo(6 * u, -1 * u);     // right notch
  ctx.lineTo(6 * u, 13 * u);     // tail bottom right
  ctx.lineTo(-6 * u, 13 * u);    // tail bottom left
  ctx.lineTo(-6 * u, -1 * u);    // left notch
  ctx.lineTo(-13 * u, -1 * u);   // left head corner
  ctx.closePath();
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)));
  return `rgb(${f((n >> 16) & 255) | 0},${f((n >> 8) & 255) | 0},${f(n & 255) | 0})`;
}

function paintArrow(
  ctx: CanvasRenderingContext2D, size: number, angleDeg: number,
  body: string | null, dim: boolean,
): void {
  const s = size / 2;
  const u = size / 34;
  ctx.save();
  ctx.translate(s, s);
  ctx.rotate((angleDeg * Math.PI) / 180);

  // dark outline + metallic border band
  arrowPath(ctx, u);
  ctx.lineWidth = 2.6 * u;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  const rim = ctx.createLinearGradient(0, -14 * u, 0, 13 * u);
  rim.addColorStop(0, dim ? SILVER_DIM_HI : SILVER_HI);
  rim.addColorStop(1, dim ? SILVER_DIM_LO : SILVER_LO);
  ctx.fillStyle = rim;
  ctx.fill();

  // glossy body
  ctx.save();
  ctx.scale(0.68, 0.68);
  arrowPath(ctx, u);
  const grad = ctx.createLinearGradient(0, -14 * u, 0, 13 * u);
  if (body) {
    grad.addColorStop(0, shade(body, 0.45));
    grad.addColorStop(0.45, body);
    grad.addColorStop(1, shade(body, -0.45));
  } else {
    grad.addColorStop(0, '#3a4152');
    grad.addColorStop(1, '#14171f');
  }
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 1.2 * u;
  ctx.strokeStyle = 'rgba(8,10,15,0.75)';
  ctx.stroke();
  // top gloss streak
  arrowPath(ctx, u);
  ctx.clip();
  const gloss = ctx.createLinearGradient(0, -14 * u, 0, 0);
  gloss.addColorStop(0, 'rgba(255,255,255,0.5)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gloss;
  ctx.fillRect(-14 * u, -14 * u, 28 * u, 14 * u);
  ctx.restore();

  ctx.restore();
}

function paintCenter(
  ctx: CanvasRenderingContext2D, size: number, body: string | null, dim: boolean,
): void {
  const s = size / 2;
  const u = size / 34;

  ctx.beginPath();
  ctx.arc(s, s, 13 * u, 0, Math.PI * 2);
  ctx.lineWidth = 2.6 * u;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  const rim = ctx.createLinearGradient(s, s - 13 * u, s, s + 13 * u);
  rim.addColorStop(0, dim ? SILVER_DIM_HI : SILVER_HI);
  rim.addColorStop(1, dim ? SILVER_DIM_LO : SILVER_LO);
  ctx.fillStyle = rim;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(s, s, 9.6 * u, 0, Math.PI * 2);
  if (body) {
    const grad = ctx.createRadialGradient(s, s - 3 * u, 1.5 * u, s, s, 10.5 * u);
    grad.addColorStop(0, shade(body, 0.55));
    grad.addColorStop(0.55, body);
    grad.addColorStop(1, shade(body, -0.45));
    ctx.fillStyle = grad;
  } else {
    const grad = ctx.createRadialGradient(s, s - 3 * u, 1.5 * u, s, s, 10.5 * u);
    grad.addColorStop(0, '#3a4152');
    grad.addColorStop(1, '#14171f');
    ctx.fillStyle = grad;
  }
  ctx.fill();
  ctx.lineWidth = 1.2 * u;
  ctx.strokeStyle = 'rgba(8,10,15,0.75)';
  ctx.stroke();

  // gloss crescent
  ctx.beginPath();
  ctx.ellipse(s, s - 4.5 * u, 6.5 * u, 3.4 * u, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fill();
}

export function makeSprite(size: number, lane: number, color: string | null,
                           dpr: number, dim = false): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = Math.round(size * dpr);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  if (lane === 2) paintCenter(ctx, size, color, dim);
  else paintArrow(ctx, size, LANE_ANGLES[lane], color, dim);
  return c;
}

export interface SpriteSet {
  size: number;
  byLane: HTMLCanvasElement[];
  byTier: Record<string, HTMLCanvasElement[]>;
  receptors: HTMLCanvasElement[];
}

export function makeSprites(size: number, dpr: number): SpriteSet {
  const byLane = LANE_COLORS.map((c, lane) => makeSprite(size, lane, c, dpr));
  const byTier: Record<string, HTMLCanvasElement[]> = {};
  for (const [tier, color] of Object.entries(TIER_COLORS)) {
    byTier[tier] = LANE_COLORS.map((_, lane) => makeSprite(size, lane, color, dpr));
  }
  const receptors = LANE_COLORS.map((_, lane) => makeSprite(size, lane, null, dpr, true));
  return { size, byLane, byTier, receptors };
}
