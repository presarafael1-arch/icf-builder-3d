/**
 * Wall Thickness Detection from DXF
 * 
 * Auto-detects 150mm or 220mm core concrete from parallel wall lines
 * - 282mm spacing → 150mm core concrete (4×tooth)
 * - 353mm spacing → 220mm core concrete (5×tooth)
 */

import { WallSegment } from '@/types/icf';
import { 
  ThicknessDetectionResult, 
  CoreConcreteMm, 
  WallOuterThicknessMm,
  wallThicknessToCoreThickness,
  coreThicknessToWallThickness
} from '@/types/panel-selection';

// Tolerance for parallel line detection (mm)
const PARALLEL_TOLERANCE = 10;
const ANGLE_TOLERANCE = 0.087; // ~5 degrees in radians

/**
 * Calculate perpendicular distance between two parallel line segments
 */
function perpendicularDistance(
  seg1: WallSegment,
  seg2: WallSegment
): number | null {
  // Get direction vectors
  const dx1 = seg1.endX - seg1.startX;
  const dy1 = seg1.endY - seg1.startY;
  const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  
  if (len1 < 1) return null;
  
  // Normalize direction
  const nx = dx1 / len1;
  const ny = dy1 / len1;
  
  // Vector from seg1 start to seg2 start
  const vx = seg2.startX - seg1.startX;
  const vy = seg2.startY - seg1.startY;
  
  // Project onto perpendicular direction
  const perpX = -ny;
  const perpY = nx;
  
  const dist = Math.abs(vx * perpX + vy * perpY);
  return dist;
}

/**
 * Check if two segments are parallel (within tolerance)
 */
function areParallel(seg1: WallSegment, seg2: WallSegment): boolean {
  const angle1 = Math.atan2(seg1.endY - seg1.startY, seg1.endX - seg1.startX);
  const angle2 = Math.atan2(seg2.endY - seg2.startY, seg2.endX - seg2.startX);
  
  let diff = Math.abs(angle1 - angle2);
  // Normalize to [0, π]
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  // Also check if anti-parallel (180° apart)
  if (diff > Math.PI / 2) diff = Math.PI - diff;
  
  return diff < ANGLE_TOLERANCE;
}

/**
 * Check if segments overlap in their direction (are "beside" each other)
 */
function segmentsOverlap(seg1: WallSegment, seg2: WallSegment): boolean {
  // Project both segments onto their direction axis
  const dx1 = seg1.endX - seg1.startX;
  const dy1 = seg1.endY - seg1.startY;
  const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  
  if (len1 < 1) return false;
  
  const nx = dx1 / len1;
  const ny = dy1 / len1;
  
  // Project all 4 points onto the direction axis
  const proj1Start = seg1.startX * nx + seg1.startY * ny;
  const proj1End = seg1.endX * nx + seg1.endY * ny;
  const proj2Start = seg2.startX * nx + seg2.startY * ny;
  const proj2End = seg2.endX * nx + seg2.endY * ny;
  
  const min1 = Math.min(proj1Start, proj1End);
  const max1 = Math.max(proj1Start, proj1End);
  const min2 = Math.min(proj2Start, proj2End);
  const max2 = Math.max(proj2Start, proj2End);
  
  // Check for overlap
  return !(max1 < min2 || max2 < min1);
}

/**
 * Detect wall thickness from parallel line pairs in DXF
 */
export function detectWallThickness(walls: WallSegment[]): ThicknessDetectionResult {
  if (walls.length < 2) {
    return {
      detected: false,
      wallOuterThicknessMm: null,
      coreConcreteMm: null,
      confidence: 'none',
      detectionMethod: 'parallel_lines',
      message: 'Não há segmentos suficientes para detetar espessura'
    };
  }
  
  // Find pairs of parallel segments and measure their perpendicular distance
  const distances: number[] = [];
  
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const seg1 = walls[i];
      const seg2 = walls[j];
      
      if (!areParallel(seg1, seg2)) continue;
      if (!segmentsOverlap(seg1, seg2)) continue;
      
      const dist = perpendicularDistance(seg1, seg2);
      if (dist !== null && dist > 200 && dist < 400) {
        distances.push(dist);
      }
    }
  }
  
  if (distances.length === 0) {
    return {
      detected: false,
      wallOuterThicknessMm: null,
      coreConcreteMm: null,
      confidence: 'none',
      detectionMethod: 'parallel_lines',
      message: 'Não foram encontrados pares de linhas paralelas com espaçamento compatível'
    };
  }
  
  // Calculate median distance
  distances.sort((a, b) => a - b);
  const median = distances[Math.floor(distances.length / 2)];
  
  // Count how many are close to 282mm and 353mm (tooth-based)
  const near282 = distances.filter(d => Math.abs(d - 282) < PARALLEL_TOLERANCE).length;
  const near353 = distances.filter(d => Math.abs(d - 353) < PARALLEL_TOLERANCE).length;
  
  // Determine which thickness is more likely
  let detectedThickness: WallOuterThicknessMm;
  let confidence: 'high' | 'medium' | 'low';
  
  if (near282 > near353 && near282 >= 3) {
    detectedThickness = 282;
    confidence = near282 >= distances.length * 0.7 ? 'high' : 'medium';
  } else if (near353 > near282 && near353 >= 3) {
    detectedThickness = 353;
    confidence = near353 >= distances.length * 0.7 ? 'high' : 'medium';
  } else {
    // Use median to guess
    const coreFromMedian = wallThicknessToCoreThickness(median);
    if (coreFromMedian) {
      detectedThickness = coreThicknessToWallThickness(coreFromMedian);
      confidence = 'low';
    } else {
      return {
        detected: false,
        wallOuterThicknessMm: null,
        coreConcreteMm: null,
        confidence: 'low',
        detectionMethod: 'parallel_lines',
        message: `Mediana de espaçamento ${median.toFixed(0)}mm não corresponde a 282mm ou 353mm`
      };
    }
  }
  
  const coreConcreteMm: CoreConcreteMm = detectedThickness === 282 ? 150 : 220;
  
  return {
    detected: true,
    wallOuterThicknessMm: detectedThickness,
    coreConcreteMm,
    confidence,
    detectionMethod: 'parallel_lines',
    message: `Detetado ${detectedThickness}mm (${near282} amostras @282mm, ${near353} amostras @353mm)`
  };
}

/**
 * Get thickness from project settings
 */
export function getThicknessFromSettings(concreteThickness: string): ThicknessDetectionResult {
  const coreValue = parseInt(concreteThickness, 10);
  
  // Map 150 → 150, 220 → 220 (also accept legacy 200 and map to 220)
  let core: CoreConcreteMm;
  if (coreValue === 150) {
    core = 150;
  } else if (coreValue === 220 || coreValue === 200) {
    core = 220;
  } else {
    return {
      detected: false,
      wallOuterThicknessMm: null,
      coreConcreteMm: null,
      confidence: 'none',
      detectionMethod: 'project_setting',
      message: `Espessura de betão inválida: ${concreteThickness}`
    };
  }
  
  return {
    detected: true,
    wallOuterThicknessMm: coreThicknessToWallThickness(core),
    coreConcreteMm: core,
    confidence: 'high',
    detectionMethod: 'project_setting',
    message: `Definido nas configurações do projeto: ${core}mm`
  };
}
