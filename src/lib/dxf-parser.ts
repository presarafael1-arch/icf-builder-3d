// DXF Parser utilities for OMNI ICF WALLS 3D PLANNER
import DxfParser from 'dxf-parser';

export interface DXFSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  layerName: string;
}

export interface DXFBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface DXFParseResult {
  layers: string[];
  segments: DXFSegment[];
  layerCounts: Record<string, number>;
  boundingBox: DXFBoundingBox | null;
  suggestedUnit: 'mm' | 'm';
  error?: string;
}

/**
 * Calculate bounding box from segments (in original units)
 */
function calculateBoundingBox(segments: DXFSegment[]): DXFBoundingBox | null {
  if (segments.length === 0) return null;
  
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  
  segments.forEach(seg => {
    minX = Math.min(minX, seg.startX, seg.endX);
    minY = Math.min(minY, seg.startY, seg.endY);
    maxX = Math.max(maxX, seg.startX, seg.endX);
    maxY = Math.max(maxY, seg.startY, seg.endY);
  });
  
  return {
    minX, minY, maxX, maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Auto-detect unit based on bounding box size
 * - If bbox < 500 in both dimensions → likely meters
 * - If bbox > 5000 in any dimension → likely mm
 */
function detectUnit(bbox: DXFBoundingBox): 'mm' | 'm' {
  if (bbox.width < 500 && bbox.height < 500) {
    return 'm'; // Small values suggest meters
  }
  if (bbox.width > 5000 || bbox.height > 5000) {
    return 'mm'; // Large values suggest mm
  }
  // Default to meters for mid-range values (architectural scale)
  return 'm';
}

/**
 * Parse a DXF file and extract line segments (in original units, no conversion yet)
 * @param fileContent - The raw DXF file content as string
 */
export function parseDXF(fileContent: string): DXFParseResult {
  try {
    const parser = new DxfParser();
    const dxf = parser.parseSync(fileContent);
    
    if (!dxf || !dxf.entities) {
      return {
        layers: [],
        segments: [],
        layerCounts: {},
        boundingBox: null,
        suggestedUnit: 'mm',
        error: 'DXF sem entidades válidas.'
      };
    }
    
    const segments: DXFSegment[] = [];
    const layerCounts: Record<string, number> = {};
    const layersSet = new Set<string>();
    
    // Process entities (NO unit conversion here - raw values)
    dxf.entities.forEach((entity: any) => {
      const layerName = entity.layer || 'default';
      layersSet.add(layerName);
      
      if (entity.type === 'LINE') {
        const seg: DXFSegment = {
          startX: entity.vertices?.[0]?.x ?? entity.startPoint?.x ?? 0,
          startY: entity.vertices?.[0]?.y ?? entity.startPoint?.y ?? 0,
          endX: entity.vertices?.[1]?.x ?? entity.endPoint?.x ?? 0,
          endY: entity.vertices?.[1]?.y ?? entity.endPoint?.y ?? 0,
          layerName
        };
        segments.push(seg);
        layerCounts[layerName] = (layerCounts[layerName] || 0) + 1;
      } else if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
        const vertices = entity.vertices || [];
        for (let i = 0; i < vertices.length - 1; i++) {
          segments.push({
            startX: vertices[i].x ?? 0,
            startY: vertices[i].y ?? 0,
            endX: vertices[i + 1].x ?? 0,
            endY: vertices[i + 1].y ?? 0,
            layerName
          });
          layerCounts[layerName] = (layerCounts[layerName] || 0) + 1;
        }
        // Close polyline if needed
        if (entity.shape && vertices.length > 2) {
          segments.push({
            startX: vertices[vertices.length - 1].x ?? 0,
            startY: vertices[vertices.length - 1].y ?? 0,
            endX: vertices[0].x ?? 0,
            endY: vertices[0].y ?? 0,
            layerName
          });
          layerCounts[layerName] = (layerCounts[layerName] || 0) + 1;
        }
      }
    });
    
    if (segments.length === 0) {
      return {
        layers: Array.from(layersSet),
        segments: [],
        layerCounts,
        boundingBox: null,
        suggestedUnit: 'mm',
        error: 'DXF sem linhas/polylines compatíveis para paredes.'
      };
    }
    
    const boundingBox = calculateBoundingBox(segments);
    const suggestedUnit = boundingBox ? detectUnit(boundingBox) : 'mm';
    
    return {
      layers: Array.from(layersSet),
      segments,
      layerCounts,
      boundingBox,
      suggestedUnit
    };
  } catch (error) {
    console.error('DXF parse error:', error);
    return {
      layers: [],
      segments: [],
      layerCounts: {},
      boundingBox: null,
      suggestedUnit: 'mm',
      error: 'Erro ao processar o ficheiro DXF. Verifique se o ficheiro é válido.'
    };
  }
}

/**
 * Filter segments by selected layers
 */
export function filterSegmentsByLayers(
  segments: DXFSegment[], 
  selectedLayers: string[]
): DXFSegment[] {
  if (selectedLayers.length === 0) return segments;
  return segments.filter(seg => selectedLayers.includes(seg.layerName));
}

/**
 * Convert segments to mm based on unit selection
 * If unit is 'm', multiply by 1000 to get mm
 * If unit is 'mm', keep as is
 */
export function convertSegmentsToMM(
  segments: DXFSegment[],
  sourceUnit: 'mm' | 'm'
): DXFSegment[] {
  const factor = sourceUnit === 'm' ? 1000 : 1;
  
  return segments.map(seg => ({
    ...seg,
    startX: seg.startX * factor,
    startY: seg.startY * factor,
    endX: seg.endX * factor,
    endY: seg.endY * factor
  }));
}

/**
 * Calculate total length of segments (in mm)
 */
export function calculateTotalLength(segments: DXFSegment[]): number {
  return segments.reduce((total, seg) => {
    const dx = seg.endX - seg.startX;
    const dy = seg.endY - seg.startY;
    return total + Math.sqrt(dx * dx + dy * dy);
  }, 0);
}

/**
 * Calculate bounding box of segments (already in mm)
 */
export function getSegmentsBoundingBox(segments: DXFSegment[]): DXFBoundingBox | null {
  return calculateBoundingBox(segments);
}

/**
 * Format length for display
 * Shows in meters with 2 decimal places, or "<0.01 m" for tiny values
 */
export function formatLength(lengthMM: number): string {
  const meters = lengthMM / 1000;
  if (meters < 0.01) {
    return lengthMM > 0 ? `${lengthMM.toFixed(0)} mm` : '0 m';
  }
  return `${meters.toFixed(2)} m`;
}
