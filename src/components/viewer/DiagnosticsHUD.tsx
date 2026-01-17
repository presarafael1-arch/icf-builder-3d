import { useMemo } from 'react';
import { AlertTriangle, CheckCircle, Info, Scan } from 'lucide-react';
import { WallSegment, ViewerSettings, PANEL_WIDTH, PANEL_HEIGHT } from '@/types/icf';
import { OpeningData, OpeningCandidate, calculateOpeningTopos } from '@/types/openings';
import { buildWallChains } from '@/lib/wall-chains';

interface DiagnosticsHUDProps {
  walls: WallSegment[];
  settings: ViewerSettings;
  openings?: OpeningData[];
  candidates?: OpeningCandidate[];
  panelInstancesCount: number;
  geometrySource?: 'glb' | 'step' | 'cache' | 'procedural' | 'simple';
  geometryBBoxM?: { x: number; y: number; z: number };
  geometryScaleApplied?: number;
  panelMeshVisible?: boolean;
  panelMeshBBoxSizeM?: { x: number; y: number; z: number };
  instancePosRangeM?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  layoutStats?: { lJunctions: number; tJunctions: number; freeEnds?: number; templatesApplied: number; toposPlaced: number; effectiveOffset?: number };
  panelCountsByType?: { FULL: number; CUT_SINGLE: number; CUT_DOUBLE: number; CORNER_CUT: number; TOPO?: number; END_CUT?: number };
}

export function DiagnosticsHUD({
  walls,
  settings,
  openings = [],
  candidates = [],
  panelInstancesCount,
  geometrySource = 'simple',
  geometryBBoxM,
  geometryScaleApplied,
  panelMeshVisible,
  panelMeshBBoxSizeM,
  instancePosRangeM,
  layoutStats,
  panelCountsByType,
}: DiagnosticsHUDProps) {
  const chainsResult = useMemo(() => buildWallChains(walls, { detectCandidates: true }), [walls]);
  const { chains, stats, candidates: detectedCandidates } = chainsResult;
  
  const viewModeLabel = {
    lines: 'Linhas',
    panels: 'Painéis',
    both: 'Ambos'
  };
  
  const currentViewMode = settings.viewMode || 'panels';
  
  // Calculate expected panels for current visible rows
  const expectedPanelsForVisibleRows = useMemo(() => {
    if (chains.length === 0) return 0;
    let totalPanels = 0;
    for (let row = 0; row < settings.currentRow; row++) {
      chains.forEach(chain => {
        totalPanels += Math.ceil(chain.lengthMm / PANEL_WIDTH);
      });
    }
    return totalPanels;
  }, [chains, settings.currentRow]);
  
  // Calculate total topos from openings
  const totalOpeningTopos = useMemo(() => {
    return openings.reduce((sum, o) => sum + calculateOpeningTopos(o).units, 0);
  }, [openings]);
  
  const showPanelsActive = currentViewMode === 'panels' || currentViewMode === 'both';
  const hasError = showPanelsActive && panelInstancesCount === 0 && chains.length > 0;
  const isOk = showPanelsActive && panelInstancesCount > 0;
  
  // Combined candidates count (passed + detected)
  const totalCandidates = candidates.length || detectedCandidates.length;
  const hasCandidatesWarning = chains.length > 0 && totalCandidates === 0;
  
  return (
    <div className="absolute bottom-20 right-4 z-10 rounded-md bg-background/95 backdrop-blur border border-border px-3 py-2 text-xs font-mono space-y-1 min-w-[220px] shadow-lg">
      <div className="text-muted-foreground font-sans font-medium mb-2 flex items-center gap-2">
        <Info className="h-3 w-3" />
        Diagnóstico
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">viewMode:</span>
        <span className="text-primary font-medium">{viewModeLabel[currentViewMode as keyof typeof viewModeLabel] || currentViewMode}</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">visibleRows:</span>
        <span>{settings.currentRow}/{settings.maxRows}</span>
      </div>
      
      <div className="border-t border-border my-1 pt-1" />
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">chains:</span>
        <span className="text-cyan-400">{chains.length}</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">totalLen:</span>
        <span>{(stats.totalLengthMm / 1000).toFixed(2)}m</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">panelInstances:</span>
        <span className={panelInstancesCount > 0 ? 'text-green-400' : (showPanelsActive ? 'text-red-400' : 'text-muted-foreground')}>
          {panelInstancesCount}
        </span>
      </div>
      
      {showPanelsActive && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">expected:</span>
          <span className="text-muted-foreground">~{expectedPanelsForVisibleRows}</span>
        </div>
      )}
      
      <div className="border-t border-border my-1 pt-1" />
      
      {/* CANDIDATES section */}
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground flex items-center gap-1">
          <Scan className="h-3 w-3" />
          candidates:
        </span>
        <span className={totalCandidates > 0 ? 'text-orange-400' : 'text-muted-foreground'}>
          {totalCandidates}
        </span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">openings:</span>
        <span className={openings.length > 0 ? 'text-orange-400' : 'text-muted-foreground'}>{openings.length}</span>
      </div>
      
      {openings.length > 0 && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">topos (aberturas):</span>
          <span className="text-green-600">{totalOpeningTopos}</span>
        </div>
      )}
      
      {/* JUNCTION and LAYOUT STATS section */}
      {layoutStats && (
        <>
          <div className="border-t border-border my-1 pt-1" />
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">L-junções:</span>
            <span className="text-cyan-400">{layoutStats.lJunctions}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">T-junções:</span>
            <span className="text-purple-400">{layoutStats.tJunctions}</span>
          </div>
          {layoutStats.freeEnds !== undefined && layoutStats.freeEnds > 0 && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">pontas livres:</span>
              <span className="text-orange-400">{layoutStats.freeEnds}</span>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">corner templates:</span>
            <span className="text-red-400">{layoutStats.templatesApplied}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">topos (T+ends):</span>
            <span className="text-green-600">{layoutStats.toposPlaced}</span>
          </div>
          {layoutStats.effectiveOffset !== undefined && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">offset (ímpar):</span>
              <span>{layoutStats.effectiveOffset}mm</span>
            </div>
          )}
        </>
      )}
      
      {panelCountsByType && (
        <>
          <div className="border-t border-border my-1 pt-1" />
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">FULL (amarelo):</span>
            <span className="text-yellow-400">{panelCountsByType.FULL}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">CORNER_CUT (verm):</span>
            <span className="text-red-400">{panelCountsByType.CORNER_CUT}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">CUT_DOUBLE (laranja):</span>
            <span className="text-orange-400">{panelCountsByType.CUT_DOUBLE}</span>
          </div>
          {panelCountsByType.CUT_SINGLE > 0 && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">CUT_SINGLE (verde):</span>
              <span className="text-green-400">{panelCountsByType.CUT_SINGLE}</span>
            </div>
          )}
        </>
      )}
      
      <div className="border-t border-border my-1 pt-1" />
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">geometry:</span>
        <span className={geometrySource === 'glb' || geometrySource === 'step' || geometrySource === 'cache' ? 'text-green-400' : 'text-muted-foreground'}>
          {geometrySource === 'glb' ? '✓ GLB' : 
           geometrySource === 'step' ? '✓ STEP' : 
           geometrySource === 'cache' ? '✓ Cache' :
           geometrySource === 'procedural' ? 'Procedural' : 'Simple'}
        </span>
      </div>

      {geometryBBoxM && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">geoBBox:</span>
          <span>{geometryBBoxM.x.toFixed(3)}×{geometryBBoxM.y.toFixed(3)}×{geometryBBoxM.z.toFixed(3)}m</span>
        </div>
      )}

      {typeof geometryScaleApplied === 'number' && geometryScaleApplied !== 1 && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">geoScale:</span>
          <span>{geometryScaleApplied.toFixed(4)}x</span>
        </div>
      )}

      {typeof panelMeshVisible === 'boolean' && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">panelVisible:</span>
          <span className={panelMeshVisible ? 'text-green-400' : 'text-red-400'}>{String(panelMeshVisible)}</span>
        </div>
      )}

      {panelMeshBBoxSizeM && panelMeshBBoxSizeM.x > 0 && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">panelBBox:</span>
          <span>{panelMeshBBoxSizeM.x.toFixed(2)}×{panelMeshBBoxSizeM.y.toFixed(2)}×{panelMeshBBoxSizeM.z.toFixed(2)}m</span>
        </div>
      )}

      {instancePosRangeM && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">instRange:</span>
          <span className="text-[10px]">
            {instancePosRangeM.min.x.toFixed(1)},{instancePosRangeM.min.y.toFixed(1)}→{instancePosRangeM.max.x.toFixed(1)},{instancePosRangeM.max.y.toFixed(1)}
          </span>
        </div>
      )}
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">panelSize:</span>
        <span>{PANEL_WIDTH}×{PANEL_HEIGHT}mm</span>
      </div>
      
      {/* Status indicators */}
      {hasError && (
        <div className="flex items-center gap-1 text-red-400 mt-2 pt-2 border-t border-border">
          <AlertTriangle className="h-3 w-3" />
          <span className="text-[10px]">Painéis não gerados - verificar chains</span>
        </div>
      )}
      
      {isOk && (
        <div className="flex items-center gap-1 text-green-400 mt-2 pt-2 border-t border-border">
          <CheckCircle className="h-3 w-3" />
          <span className="text-[10px]">Painéis renderizados OK</span>
        </div>
      )}
      
      {hasCandidatesWarning && (
        <div className="flex items-center gap-1 text-yellow-500 mt-1">
          <AlertTriangle className="h-3 w-3" />
          <span className="text-[10px]">Sem candidatos - ajustar thresholds</span>
        </div>
      )}
    </div>
  );
}
