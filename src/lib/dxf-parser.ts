// DXF Parser utilities for OMNI ICF WALLS 3D PLANNER
import DxfParser from 'dxf-parser';

export interface DXFSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  layerName: string;
}

export interface DXFParseResult {
  layers: string[];
  segments: DXFSegment[];
  error?: string;
}

/**
 * Parse a DXF file and extract line segments
 * @param fileContent - The raw DXF file content as string
 * @param unitFactor - Multiplier for units (1 = mm, 1000 = m to mm)
 */
export function parseDXF(fileContent: string, unitFactor: number = 1): DXFParseResult {
  try {
    const parser = new DxfParser();
    const dxf = parser.parseSync(fileContent);
    
    if (!dxf || !dxf.entities) {
      return {
        layers: [],
        segments: [],
        error: 'DXF sem entidades válidas.'
      };
    }
    
    const segments: DXFSegment[] = [];
    const layersSet = new Set<string>();
    
    // Process entities
    dxf.entities.forEach((entity: any) => {
      const layerName = entity.layer || 'default';
      layersSet.add(layerName);
      
      if (entity.type === 'LINE') {
        // LINE entity
        segments.push({
          startX: (entity.vertices?.[0]?.x ?? entity.startPoint?.x ?? 0) * unitFactor,
          startY: (entity.vertices?.[0]?.y ?? entity.startPoint?.y ?? 0) * unitFactor,
          endX: (entity.vertices?.[1]?.x ?? entity.endPoint?.x ?? 0) * unitFactor,
          endY: (entity.vertices?.[1]?.y ?? entity.endPoint?.y ?? 0) * unitFactor,
          layerName
        });
      } else if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
        // LWPOLYLINE / POLYLINE - convert to line segments
        const vertices = entity.vertices || [];
        for (let i = 0; i < vertices.length - 1; i++) {
          segments.push({
            startX: (vertices[i].x ?? 0) * unitFactor,
            startY: (vertices[i].y ?? 0) * unitFactor,
            endX: (vertices[i + 1].x ?? 0) * unitFactor,
            endY: (vertices[i + 1].y ?? 0) * unitFactor,
            layerName
          });
        }
        // Close polyline if needed
        if (entity.shape && vertices.length > 2) {
          segments.push({
            startX: (vertices[vertices.length - 1].x ?? 0) * unitFactor,
            startY: (vertices[vertices.length - 1].y ?? 0) * unitFactor,
            endX: (vertices[0].x ?? 0) * unitFactor,
            endY: (vertices[0].y ?? 0) * unitFactor,
            layerName
          });
        }
      }
    });
    
    if (segments.length === 0) {
      return {
        layers: Array.from(layersSet),
        segments: [],
        error: 'DXF sem linhas/polylines compatíveis para paredes.'
      };
    }
    
    return {
      layers: Array.from(layersSet),
      segments
    };
  } catch (error) {
    console.error('DXF parse error:', error);
    return {
      layers: [],
      segments: [],
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
