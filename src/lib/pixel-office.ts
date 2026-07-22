/**
 * The pixel office — sprite data and canvas drawing for the hatchling swarm.
 *
 * Pure data in, pixels out: no React, no DOM lookups, no dependencies. The
 * component owns the canvas element and the animation timer; everything
 * here is deterministic per (characters, frame) so it stays testable and
 * cheap. The office is decorative supplement — every fact it shows is also
 * available as text in the status list next to it.
 */

import { t } from "@lingui/core/macro";

export type OfficeMood = "idle" | "thinking" | "tool" | "write" | "error" | "done";

export interface OfficeCharacter {
  id: string;
  name: string;
  species: number;
  mood: OfficeMood;
  running: boolean;
  /** Auto work switched on (shown as a small clock when idle). */
  scheduled: boolean;
  selected: boolean;
}

export const OFFICE_CELL_W = 72;
export const OFFICE_CELL_H = 60;
export const OFFICE_COLS = 2;

export function officeGrid(count: number): { cols: number; rows: number; width: number; height: number } {
  const cols = Math.min(OFFICE_COLS, Math.max(1, count));
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows, width: cols * OFFICE_CELL_W, height: rows * OFFICE_CELL_H };
}

export function hitTestOffice(count: number, x: number, y: number): number | null {
  const { cols, width, height } = officeGrid(count);
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const index = Math.floor(y / OFFICE_CELL_H) * cols + Math.floor(x / OFFICE_CELL_W);
  return index < count ? index : null;
}

/** Body/shade palettes per species — soft chick colours. */
const SPECIES_PALETTES: Array<{ body: string; shade: string }> = [
  { body: "#ffd94a", shade: "#e0b73a" },
  { body: "#ffb3c8", shade: "#e094ab" },
  { body: "#a2e8ba", shade: "#7fca9c" },
  { body: "#a2d2ff", shade: "#7fb4e2" },
  { body: "#cdb6ff", shade: "#ab95e4" },
  { body: "#ffc386", shade: "#e2a367" }
];

const BEAK = "#ff9e2c";
const EYE = "#2f2a26";
const CHEEK = "#ff9d9d";
const FEET = "#ff9e2c";

/**
 * 16×16 chick, one char per pixel:
 * `.` empty, `B` body, `b` shade, `E` eye, `K` beak, `C` cheek, `F` feet.
 */
const CHICK: readonly string[] = [
  "................",
  "......BBBB......",
  "....BBBBBBBB....",
  "...BBBBBBBBBB...",
  "...BBBBBBBBBB...",
  "..BBEBBBBBBEBB..",
  "..BBBBBKKBBBBB..",
  "..BCBBBKKBBBCB..",
  "..BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB..",
  "...BBBBBBBBBB...",
  "...bBBBBBBBBb...",
  "....bbBBBBbb....",
  ".....bbbbbb.....",
  "....F......F....",
  "................"
];

/** Row 5 with eyes shut, for blinking and for the happy "done" face. */
const EYES_CLOSED_ROW = "..BBbBBBBBBbBB..";

function drawSprite(
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  species: number,
  eyesClosed: boolean
): void {
  const palette = SPECIES_PALETTES[species % SPECIES_PALETTES.length];
  const colors: Record<string, string> = {
    B: palette.body,
    b: palette.shade,
    E: EYE,
    K: BEAK,
    C: CHEEK,
    F: FEET
  };
  CHICK.forEach((row, y) => {
    const cells = y === 5 && eyesClosed ? EYES_CLOSED_ROW : row;
    for (let x = 0; x < cells.length; x += 1) {
      const color = colors[cells[x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(originX + x, originY + y, 1, 1);
    }
  });
}

/** 8×8 mood glyphs; `X` pixels take the glyph colour. */
const GLYPHS: Record<string, { rows: readonly string[]; color: string }> = {
  exclaim: {
    color: "#e5484d",
    rows: ["...XX...", "...XX...", "...XX...", "...XX...", "...XX...", "........", "...XX...", "...XX..."]
  },
  star: {
    color: "#f5b301",
    rows: ["...X....", "...XX...", ".XXXXXX.", "..XXXX..", "..XXXX..", ".XX..XX.", "X.....X.", "........"]
  },
  gear: {
    color: "#7a8699",
    rows: ["..X..X..", ".XXXXXX.", "XXX..XXX", ".X....X.", ".X....X.", "XXX..XXX", ".XXXXXX.", "..X..X.."]
  },
  pencil: {
    color: "#4a90d9",
    rows: [".....XX.", "....XXX.", "...XXX..", "..XXX...", ".XXX....", "XXX.....", "XX......", "........"]
  },
  dots: {
    color: "#9aa4b2",
    rows: ["........", "........", "........", "X..X..X.", "X..X..X.", "........", "........", "........"]
  },
  zzz: {
    color: "#9aa4b2",
    rows: ["XXXX....", "..X.....", ".X..XXX.", "XXXX..X.", ".....X..", "....XXX.", "........", "........"]
  },
  clock: {
    color: "#8a94a6",
    rows: [".XXXXXX.", "X..X...X", "X..X...X", "X..XX..X", "X......X", "X......X", ".XXXXXX.", "........"]
  }
};

function glyphForCharacter(character: OfficeCharacter, frame: number): string | null {
  switch (character.mood) {
    case "error": return "exclaim";
    case "done": return "star";
    case "tool": return "gear";
    case "write": return "pencil";
    case "thinking": return frame % 2 === 0 ? "dots" : null;
    case "idle": return character.scheduled ? "clock" : (frame % 4 < 2 ? "zzz" : null);
    default: return null;
  }
}

function drawGlyph(ctx: CanvasRenderingContext2D, originX: number, originY: number, glyphId: string): void {
  const glyph = GLYPHS[glyphId];
  if (!glyph) return;
  ctx.fillStyle = glyph.color;
  glyph.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === "X") ctx.fillRect(originX + x, originY + y, 1, 1);
    }
  });
}

function drawDesk(ctx: CanvasRenderingContext2D, cellX: number, cellY: number, running: boolean): void {
  const deskY = cellY + 40;
  // table top and legs
  ctx.fillStyle = "#a98a63";
  ctx.fillRect(cellX + 20, deskY, 32, 3);
  ctx.fillStyle = "#8a6f4d";
  ctx.fillRect(cellX + 22, deskY + 3, 2, 7);
  ctx.fillRect(cellX + 48, deskY + 3, 2, 7);
  // laptop: base + screen, lit while the hatchling is running
  ctx.fillStyle = "#3c4250";
  ctx.fillRect(cellX + 30, deskY - 1, 12, 1);
  ctx.fillRect(cellX + 31, deskY - 8, 10, 7);
  ctx.fillStyle = running ? "#9df0a8" : "#5a6272";
  ctx.fillRect(cellX + 32, deskY - 7, 8, 5);
}

/**
 * Renders the whole office for one animation frame (~300 ms per frame).
 * The canvas must be officeGrid(count).width × height logical pixels;
 * CSS `image-rendering: pixelated` does the crisp upscaling.
 */
export function renderOffice(ctx: CanvasRenderingContext2D, characters: readonly OfficeCharacter[], frame: number): void {
  const { cols, width, height } = officeGrid(characters.length);
  ctx.clearRect(0, 0, width, height);
  // floor
  ctx.fillStyle = "#f4eee2";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#e9e0cd";
  for (let y = 0; y < height; y += 8) {
    for (let x = (y / 8) % 2 === 0 ? 0 : 8; x < width; x += 16) {
      ctx.fillRect(x, y, 8, 8);
    }
  }
  characters.forEach((character, index) => {
    const cellX = (index % cols) * OFFICE_CELL_W;
    const cellY = Math.floor(index / cols) * OFFICE_CELL_H;
    if (character.selected) {
      ctx.fillStyle = "#fff7dd";
      ctx.fillRect(cellX + 1, cellY + 1, OFFICE_CELL_W - 2, OFFICE_CELL_H - 2);
      ctx.strokeStyle = "#e0a815";
      ctx.strokeRect(cellX + 1.5, cellY + 1.5, OFFICE_CELL_W - 3, OFFICE_CELL_H - 3);
    }
    // Working hatchlings bounce; idle ones blink now and then.
    const active = character.running || character.mood === "tool" || character.mood === "write";
    const bounce = active && frame % 2 === 1 ? 1 : 0;
    const blink = character.mood === "done" || (character.mood === "idle" && frame % 7 === 0);
    const spriteX = cellX + 28;
    const spriteY = cellY + 22 + bounce;
    drawSprite(ctx, spriteX, spriteY, character.species, blink);
    drawDesk(ctx, cellX, cellY, character.running);
    const glyphId = glyphForCharacter(character, frame);
    if (glyphId) drawGlyph(ctx, spriteX + 12, spriteY - 8, glyphId);
    // name tag
    ctx.fillStyle = "#5c5648";
    ctx.font = "7px monospace";
    ctx.textAlign = "center";
    ctx.fillText(character.name.slice(0, 10), cellX + OFFICE_CELL_W / 2, cellY + 10);
  });
}

/** One text line for the canvas aria-label: every fact drawn is also spoken. */
export function describeOffice(characters: readonly OfficeCharacter[]): string {
  if (!characters.length) return t`No hatchlings yet.`;
  return characters
    .map((character) => {
      const name = character.name;
      if (character.running) return t`${name} is working`;
      if (character.mood === "error") return t`${name} hit an error`;
      if (character.scheduled) return t`${name} is waiting for the next auto-work run`;
      return t`${name} is resting`;
    })
    .join("; ");
}
