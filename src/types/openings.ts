// Opening types for OMNI ICF WALLS 3D PLANNER

export type OpeningKind = 'door' | 'window';

// Opening with chain association
export interface OpeningData {
  id: string;
  projectId: string;
  chainId: string; // Which chain this opening belongs to
  kind: OpeningKind;
  label: string; // e.g., P1, J1
  widthMm: number;
  heightMm: number;
  sillMm: number; // 0 for doors, typically 900+ for windows
  offsetMm: number; // Position along the chain from start
  createdAt?: Date;
  updatedAt?: Date;
}

// Opening Candidate - automatically detected gap in wall geometry
export interface OpeningCandidate {
  id: string;
  chainId: string;
  startDistMm: number; // Position along the chain
  widthMm: number;
  centerX: number; // World X coordinate
  centerY: number; // World Y coordinate (2D plane)
  angle: number; // Direction/orientation
  status: 'detected' | 'converted' | 'dismissed';
  label: string; // Auto-generated (C1, C2...)
  createdFromGap?: boolean; // True if created from bridged gap
}

// Templates for quick selection
export interface OpeningTemplate {
  name: string;
  kind: OpeningKind;
  widthMm: number;
  heightMm: number;
  sillMm: number;
}

// Default templates
export const DOOR_TEMPLATES: OpeningTemplate[] = [
  { name: 'Porta 700×2000', kind: 'door', widthMm: 700, heightMm: 2000, sillMm: 0 },
  { name: 'Porta 800×2000', kind: 'door', widthMm: 800, heightMm: 2000, sillMm: 0 },
  { name: 'Porta 900×2100', kind: 'door', widthMm: 900, heightMm: 2100, sillMm: 0 },
  { name: 'Porta Dupla 1600×2100', kind: 'door', widthMm: 1600, heightMm: 2100, sillMm: 0 },
];

export const WINDOW_TEMPLATES: OpeningTemplate[] = [
  { name: 'Janela 1200×1200 (sill 900)', kind: 'window', widthMm: 1200, heightMm: 1200, sillMm: 900 },
  { name: 'Janela 1600×1300 (sill 900)', kind: 'window', widthMm: 1600, heightMm: 1300, sillMm: 900 },
  { name: 'Janela 1000×600 (sill 1200)', kind: 'window', widthMm: 1000, heightMm: 600, sillMm: 1200 },
  { name: 'Janela 800×800 (sill 1000)', kind: 'window', widthMm: 800, heightMm: 800, sillMm: 1000 },
];

export const ALL_TEMPLATES: OpeningTemplate[] = [...DOOR_TEMPLATES, ...WINDOW_TEMPLATES];

// Calculate which rows are affected by an opening
export function getAffectedRows(sillMm: number, heightMm: number, rowHeightMm: number = 400): {
  startRow: number; // 0-indexed
  endRow: number; // exclusive
  rowsAffected: number;
} {
  const startRow = Math.floor(sillMm / rowHeightMm);
  const endRow = Math.ceil((sillMm + heightMm) / rowHeightMm);
  return {
    startRow,
    endRow,
    rowsAffected: endRow - startRow,
  };
}

// Calculate topos needed for an opening
export function calculateOpeningTopos(opening: OpeningData): {
  units: number;
  metersLinear: number;
} {
  const { rowsAffected } = getAffectedRows(opening.sillMm, opening.heightMm);
  // 2 topos per row affected (one on each side of opening)
  const units = 2 * rowsAffected;
  // Each topo is 400mm (0.4m) height
  const metersLinear = units * 0.4;
  return { units, metersLinear };
}

// Generate next label for openings
export function generateOpeningLabel(kind: OpeningKind, existingOpenings: OpeningData[]): string {
  const prefix = kind === 'door' ? 'P' : 'J';
  const sameKindCount = existingOpenings.filter(o => o.kind === kind).length;
  return `${prefix}${sameKindCount + 1}`;
}

// Generate label for candidates
export function generateCandidateLabel(existingCandidates: OpeningCandidate[]): string {
  const activeCount = existingCandidates.filter(c => c.status !== 'dismissed').length;
  return `C${activeCount + 1}`;
}
