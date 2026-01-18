import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Box, Upload, Plus, Trash2, ArrowRight, Layers, MousePointer, Link2, AlertTriangle, DoorOpen, Crosshair } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { ICFViewer3D } from '@/components/viewer/ICFViewer3D';
import { ViewerControls } from '@/components/viewer/ViewerControls';
import { DXFImportDialog } from '@/components/dxf/DXFImportDialog';
import { OpeningsPanel } from '@/components/openings/OpeningsPanel';
import { PanelInspector } from '@/components/viewer/PanelInspector';
import { Button } from '@/components/ui/button';
// Card components imported but conditionally used
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOpenings } from '@/hooks/useOpenings';
import { usePanelSelection } from '@/hooks/usePanelSelection';
import { usePanelOverrides } from '@/hooks/usePanelOverrides';
import { WallSegment, ViewerSettings, ConcreteThickness, RebarSpacing } from '@/types/icf';
import { OpeningData, OpeningCandidate } from '@/types/openings';
import { ExtendedPanelData, CoreConcreteMm, coreThicknessToWallThickness, parsePanelId, getTopoType, ThicknessDetectionResult } from '@/types/panel-selection';
import { ClassifiedPanel, PanelType, TopoPlacement } from '@/lib/panel-layout';
import { TOOTH } from '@/types/icf';
import { calculateWallLength, calculateWallAngle, calculateNumberOfRows } from '@/lib/icf-calculations';
import { buildWallChains, buildWallChainsAutoTuned } from '@/lib/wall-chains';
import { DXFSegment, NormalizedDXFResult } from '@/lib/dxf-parser';

interface Project {
  id: string;
  name: string;
  concrete_thickness: string;
  wall_height_mm: number;
  rebar_spacing_cm: number;
}

interface Wall {
  id: string;
  project_id: string;
  start_x: number;
  start_y: number;
  end_x: number;
  end_y: number;
}

// Wall List Panel with Chains/Segments toggle
function WallListPanel({ walls, onDeleteWall, onRecalculate }: { 
  walls: WallSegment[]; 
  onDeleteWall: (id: string) => void;
  onRecalculate?: () => void;
}) {
  const [showChains, setShowChains] = useState(true);
  const [recalcKey, setRecalcKey] = useState(0);
  
  const chainsResult = useMemo(() => {
    // recalcKey forces recompute when button is clicked
    console.log('[WallListPanel] Computing chains, recalcKey:', recalcKey);
    return buildWallChainsAutoTuned(walls);
  }, [walls, recalcKey]);
  const { chains, stats, junctionCounts } = chainsResult;
  
  const totalMM = walls.reduce((sum, w) => sum + w.length, 0);
  const totalM = totalMM / 1000;
  
  // Warn if merge is weak (chains close to segments count)
  const isWeakMerge = stats.chainsCount > stats.originalSegments * 0.85;
  
  const handleRecalculate = () => {
    console.log('[WallListPanel] Recalculating chains...');
    setRecalcKey(k => k + 1);
    onRecalculate?.();
  };
  
  return (
    <div className="flex-1 overflow-auto p-4">
      {/* Toggle header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {showChains ? <Link2 className="h-4 w-4 text-cyan-400" /> : <Layers className="h-4 w-4 text-muted-foreground" />}
          <button 
            onClick={() => setShowChains(!showChains)}
            className="text-sm font-medium hover:underline"
          >
            {showChains ? `Cadeias (${stats.chainsCount})` : `Segmentos (${walls.length})`}
          </button>
        </div>
        {walls.length > 0 && (
          <span className="text-xs text-primary font-mono">
            {totalM < 0.01 ? `${totalMM.toFixed(0)} mm` : `${totalM.toFixed(1)} m`}
          </span>
        )}
      </div>
      
      {/* Chain stats (when showing chains) */}
      {showChains && chains.length > 0 && (
        <div className="mb-3 p-2 rounded bg-cyan-950/30 border border-cyan-800/30 text-xs space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Redução:</span>
            <span className="font-mono">{stats.reductionPercent}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">min/avg/max:</span>
            <span className="font-mono">
              {(stats.minChainLengthMm/1000).toFixed(2)}m / {(stats.avgChainLengthMm/1000).toFixed(2)}m / {(stats.maxChainLengthMm/1000).toFixed(2)}m
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Nós:</span>
            <span className="font-mono">{junctionCounts.L}L {junctionCounts.T}T {junctionCounts.X}X</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Preset:</span>
            <span className="font-mono text-cyan-400">{stats.preset || 'normal'}</span>
          </div>
          {isWeakMerge && (
            <div className="flex items-center gap-1 text-yellow-500 mt-1">
              <AlertTriangle className="h-3 w-3" />
              <span>Merge fraco</span>
            </div>
          )}
          <Button 
            variant="outline" 
            size="sm" 
            className="w-full mt-2 h-7 text-xs"
            onClick={handleRecalculate}
          >
            <Crosshair className="h-3 w-3 mr-1" />
            Recalcular cadeias
          </Button>
        </div>
      )}
      
      {/* List items */}
      <div className="space-y-1">
        {showChains ? (
          // Show top 20 chains sorted by length
          chains
            .slice()
            .sort((a, b) => b.lengthMm - a.lengthMm)
            .slice(0, 20)
            .map((chain, idx) => (
              <div key={chain.id} className="flex items-center justify-between p-2 rounded-md bg-cyan-950/20 text-xs">
                <span className="font-mono text-muted-foreground">#{idx + 1}</span>
                <span className="font-mono text-cyan-400">{(chain.lengthMm / 1000).toFixed(2)} m</span>
              </div>
            ))
        ) : (
          // Show segments
          walls.slice(0, 50).map((wall, index) => (
            <div 
              key={wall.id} 
              className="flex items-center justify-between p-2 rounded-md bg-muted/30 hover:bg-muted/50 transition-colors group text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">#{index + 1}</span>
                <span className="font-mono">{(wall.length / 1000).toFixed(2)} m</span>
              </div>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => onDeleteWall(wall.id)}
              >
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          ))
        )}
        
        {walls.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <MousePointer className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">Sem paredes</p>
            <p className="text-xs">Adicione paredes manualmente ou importe um DXF</p>
          </div>
        )}
        
        {((showChains && chains.length > 20) || (!showChains && walls.length > 50)) && (
          <div className="text-center text-xs text-muted-foreground py-2">
            ... e mais {showChains ? chains.length - 20 : walls.length - 50}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ProjectEditor() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  
  const [project, setProject] = useState<Project | null>(null);
  const [walls, setWalls] = useState<WallSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [dxfDialogOpen, setDxfDialogOpen] = useState(false);
  const [importingDXF, setImportingDXF] = useState(false);
  const [activeTab, setActiveTab] = useState('walls');
  
  // Panel selection and inspection state
  const { selection, selectPanel, clearSelection } = usePanelSelection();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [allPanelsData, setAllPanelsData] = useState<ClassifiedPanel[]>([]);
  const [selectedPanelData, setSelectedPanelData] = useState<ExtendedPanelData | null>(null);
  
  // Panel overrides management
  const { 
    overrides, 
    conflicts, 
    setOverride, 
    removeOverride, 
    lockPanel, 
    unlockPanel, 
    getOverride 
  } = usePanelOverrides(id);
  
  // Core concrete thickness (from project settings)
  const coreConcreteMm: CoreConcreteMm = useMemo(() => {
    if (!project) return 150;
    const value = parseInt(project.concrete_thickness);
    // Map legacy 200 to 220, otherwise use value as-is
    if (value === 200 || value === 220) return 220;
    return 150;
  }, [project]);
  
  // Openings management
  const { 
    openings, 
    addOpening, 
    updateOpening, 
    deleteOpening,
    setOpenings 
  } = useOpenings(id);
  
  // New wall form
  const [newWall, setNewWall] = useState({
    startX: 0,
    startY: 0,
    endX: 1200,
    endY: 0
  });
  
  // Viewer settings
  const [viewerSettings, setViewerSettings] = useState<ViewerSettings>({
    // View mode
    viewMode: 'panels',

    // Debug
    showDXFLines: false, // Segments (gray)
    showChains: true, // Chains (cyan)
    showHelpers: false,

    // Layers
    showPanels: true,
    showExteriorPanels: true,
    showInteriorPanels: true,
    showTopos: true,
    showWebs: false,
    showTarugos: false,
    showOpenings: true,
    showJunctions: true,
    showGrid: true,
    showGrids: true,

    // View / params
    currentRow: 1,
    maxRows: 7,
    wireframe: false,
    rebarSpacing: 20,
    concreteThickness: '150',
    
    // Panel geometry mode
    highFidelityPanels: false, // Default OFF for performance
    showOutlines: true, // Show panel outlines by default
    
    // Debug visualization (panel inspection)
    showSeeds: false,
    showNodeAxes: false,
    showRunSegments: false,
    showIndexFromSeed: false,
    showMiddleZone: false,
    showThicknessDetection: false,
    showLJunctionArrows: false,
    highlightCornerCuts: true, // Highlight CORNER_CUT panels by default for debugging
  });
  
  // Build chains from walls (with candidate detection enabled)
  const chainsResult = useMemo(() => buildWallChains(walls, { detectCandidates: true }), [walls]);
  const chains = chainsResult.chains;
  const detectedCandidates = chainsResult.candidates;
  
  // Track converted candidates (stored in localStorage with openings)
  const [convertedCandidateIds, setConvertedCandidateIds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(`omni-icf-converted-candidates-${id}`);
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  
  // Filter out already converted candidates
  const activeCandidates = useMemo(() => 
    detectedCandidates.filter(c => !convertedCandidateIds.includes(c.id)),
    [detectedCandidates, convertedCandidateIds]
  );
  
  // Handler to mark a candidate as converted
  const handleConvertCandidate = (candidateId: string) => {
    const updated = [...convertedCandidateIds, candidateId];
    setConvertedCandidateIds(updated);
    localStorage.setItem(`omni-icf-converted-candidates-${id}`, JSON.stringify(updated));
  };
  
  // Handler for panel data ready from 3D viewer
  const handlePanelDataReady = useCallback((
    panelsByType: Record<PanelType, ClassifiedPanel[]>, 
    allPanels: ClassifiedPanel[], 
    allTopos: TopoPlacement[]
  ) => {
    setAllPanelsData(allPanels);
  }, []);
  
  // Handler for panel click in 3D viewer
  const handlePanelClick = useCallback((meshType: string, instanceId: number, panelId: string) => {
    console.log('[ProjectEditor] Panel clicked:', { meshType, instanceId, panelId });
    selectPanel(panelId);
    setInspectorOpen(true);
    
    // Find the panel data and build ExtendedPanelData
    const panel = allPanelsData.find(p => p.panelId === panelId);
    if (panel) {
      const parsed = parsePanelId(panelId);
      const wallThickness = coreThicknessToWallThickness(coreConcreteMm);
      
      const extended: ExtendedPanelData = {
        panelId,
        parsedId: parsed || { chainId: '', rowIndex: 0, side: 'exterior', slotIndex: 0, seedKey: '' },
        startMm: panel.startMm || 0,
        endMm: panel.endMm || 0,
        lengthMm: panel.widthMm || 1200,
        widthMm: panel.widthMm || 1200,
        cutLeftMm: panel.cutLeftMm || 0,
        cutRightMm: panel.cutRightMm || 0,
        type: panel.type,
        isCornerPiece: panel.type === 'CORNER_CUT',
        isEndPiece: panel.type === 'END_CUT' || panel.type === 'CUT_SINGLE',
        isTopoPiece: panel.type === 'TOPO',
        chainId: panel.chainId || '',
        rowIndex: panel.rowIndex || 0,
        rowParity: ((panel.rowIndex || 0) % 2 === 0) ? 1 : 2,
        side: parsed?.side || 'exterior',
        seedOrigin: panel.seedOrigin || 'none',
        nearestNodeId: panel.nearestNodeId || null,
        nearestNodeType: panel.nearestNodeType || null,
        distanceToNodeMm: panel.distanceToNodeMm || 0,
        position: panel.position || 'middle',
        ruleApplied: panel.ruleApplied || 'Padrão',
        coreConcreteMm,
        wallOuterThicknessMm: wallThickness,
        topoType: panel.type === 'TOPO' ? getTopoType(coreConcreteMm) : null,
        hasOverride: overrides.has(panelId),
        isLocked: overrides.get(panelId)?.isLocked ?? false,
      };
      
      setSelectedPanelData(extended);
    }
  }, [allPanelsData, coreConcreteMm, overrides, selectPanel]);
  
  // Close inspector handler
  const handleCloseInspector = useCallback(() => {
    setInspectorOpen(false);
    clearSelection();
    setSelectedPanelData(null);
  }, [clearSelection]);
  
  useEffect(() => {
    if (id) {
      fetchProject();
      fetchWalls();
    }
  }, [id]);
  
  const fetchProject = async () => {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('id', id)
        .single();
      
      if (error) throw error;
      setProject(data);
      
      // Update settings based on project
      const rows = calculateNumberOfRows(data.wall_height_mm);
      setViewerSettings(prev => ({ 
        ...prev, 
        maxRows: rows, 
        currentRow: rows,
        rebarSpacing: data.rebar_spacing_cm as RebarSpacing,
        concreteThickness: data.concrete_thickness as ConcreteThickness
      }));
    } catch (error) {
      console.error('Error fetching project:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível carregar o projeto.',
        variant: 'destructive'
      });
    }
  };
  
  const fetchWalls = async () => {
    try {
      const { data, error } = await supabase
        .from('walls')
        .select('*')
        .eq('project_id', id);
      
      if (error) throw error;
      
      const mappedWalls: WallSegment[] = (data || []).map((wall: Wall) => ({
        id: wall.id,
        projectId: wall.project_id,
        startX: Number(wall.start_x),
        startY: Number(wall.start_y),
        endX: Number(wall.end_x),
        endY: Number(wall.end_y),
        length: 0,
        angle: 0
      })).map(wall => ({
        ...wall,
        length: calculateWallLength(wall),
        angle: calculateWallAngle(wall)
      }));
      
      setWalls(mappedWalls);
    } catch (error) {
      console.error('Error fetching walls:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const addWall = async () => {
    if (!id) return;
    
    try {
      const { data, error } = await supabase
        .from('walls')
        .insert({
          project_id: id,
          start_x: newWall.startX,
          start_y: newWall.startY,
          end_x: newWall.endX,
          end_y: newWall.endY
        })
        .select()
        .single();
      
      if (error) throw error;
      
      const wall: WallSegment = {
        id: data.id,
        projectId: data.project_id,
        startX: Number(data.start_x),
        startY: Number(data.start_y),
        endX: Number(data.end_x),
        endY: Number(data.end_y),
        length: 0,
        angle: 0
      };
      wall.length = calculateWallLength(wall);
      wall.angle = calculateWallAngle(wall);
      
      setWalls([...walls, wall]);
      
      // Reset form with offset
      setNewWall({
        startX: newWall.endX,
        startY: newWall.endY,
        endX: newWall.endX + 1200,
        endY: newWall.endY
      });
      
      toast({
        title: 'Parede adicionada',
        description: `Comprimento: ${(wall.length / 1000).toFixed(2)} m`
      });
    } catch (error) {
      console.error('Error adding wall:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível adicionar a parede.',
        variant: 'destructive'
      });
    }
  };
  
  const deleteWall = async (wallId: string) => {
    try {
      const { error } = await supabase
        .from('walls')
        .delete()
        .eq('id', wallId);
      
      if (error) throw error;
      
      setWalls(walls.filter(w => w.id !== wallId));
      toast({
        title: 'Parede eliminada'
      });
    } catch (error) {
      console.error('Error deleting wall:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível eliminar a parede.',
        variant: 'destructive'
      });
    }
  };

  const clearWalls = async () => {
    if (!id) return;

    try {
      const { error } = await supabase
        .from('walls')
        .delete()
        .eq('project_id', id);

      if (error) throw error;

      setWalls([]);
      toast({
        title: 'Paredes limpas',
        description: 'O projeto ficou sem paredes. Pode reimportar um DXF.'
      });
    } catch (error) {
      console.error('Error clearing walls:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível limpar as paredes.',
        variant: 'destructive'
      });
    }
  };

  const fitView = () => {
    window.dispatchEvent(new CustomEvent('icf-fit-view'));
  };
  
  const handleDXFImport = async (
    segments: DXFSegment[], 
    selectedLayers: string[], 
    stats: NormalizedDXFResult['stats'],
    detectedThickness?: ThicknessDetectionResult
  ) => {
    if (!id || segments.length === 0) return;
    
    setImportingDXF(true);
    
    try {
      // Replace mode: clear any previous walls for this project (avoid duplicates / accumulation)
      const { error: deleteError } = await supabase
        .from('walls')
        .delete()
        .eq('project_id', id);

      if (deleteError) throw deleteError;

      // Insert all walls from DXF (segments are already normalized: mm + recentered + merged)
      const wallsToInsert = segments.map(seg => ({
        project_id: id,
        start_x: seg.startX,
        start_y: seg.startY,
        end_x: seg.endX,
        end_y: seg.endY,
        layer_name: seg.layerName
      }));
      
      const { data, error } = await supabase
        .from('walls')
        .insert(wallsToInsert)
        .select();
      
      if (error) throw error;
      
      // Map to WallSegment
      const newWalls: WallSegment[] = (data || []).map((wall: any) => {
        const segment: WallSegment = {
          id: wall.id,
          projectId: wall.project_id,
          startX: Number(wall.start_x),
          startY: Number(wall.start_y),
          endX: Number(wall.end_x),
          endY: Number(wall.end_y),
          length: 0,
          angle: 0
        };
        segment.length = calculateWallLength(segment);
        segment.angle = calculateWallAngle(segment);
        return segment;
      });
      
      // Source of truth: ONLY final walls (no concatenation)
      setWalls(newWalls);

      // Update project concrete_thickness if detected from DXF
      if (detectedThickness?.detected && detectedThickness.coreConcreteMm) {
        const newThickness = detectedThickness.coreConcreteMm.toString() as ConcreteThickness;
        
        // Update in database
        const { error: updateError } = await supabase
          .from('projects')
          .update({ concrete_thickness: newThickness })
          .eq('id', id);
        
        if (updateError) {
          console.error('Error updating project thickness:', updateError);
        } else {
          // Update local state
          setProject(prev => prev ? { ...prev, concrete_thickness: newThickness } : prev);
          
          // Update viewer settings
          setViewerSettings(prev => ({ ...prev, concreteThickness: newThickness }));
          
          toast({
            title: 'Espessura detetada',
            description: `Betão: ${detectedThickness.coreConcreteMm}mm | Parede: ${detectedThickness.wallOuterThicknessMm}mm (${detectedThickness.confidence === 'high' ? 'alta confiança' : detectedThickness.confidence === 'medium' ? 'média confiança' : 'baixa confiança'})`
          });
        }
      }

      // Ensure viewer fits the imported plan
      fitView();
      
      // Format total length for display
      const totalMeters = stats.totalLengthMM / 1000;
      const { L, T, X } = stats.junctionCounts;
      
      toast({
        title: 'DXF importado e normalizado',
        description: `${newWalls.length} paredes (${totalMeters.toFixed(1)}m) | ${L}L ${T}T ${X}X junções`
      });
    } catch (error) {
      console.error('Error importing DXF:', error);
      toast({
        title: 'Erro na importação',
        description: 'Não foi possível importar as paredes do DXF.',
        variant: 'destructive'
      });
    } finally {
      setImportingDXF(false);
    }
  };
  
  if (loading || !project) {
    return (
      <MainLayout fullHeight>
        <div className="h-full flex items-center justify-center">
          <div className="animate-pulse text-muted-foreground">A carregar...</div>
        </div>
      </MainLayout>
    );
  }
  
  return (
    <MainLayout fullHeight>
      <div className="h-[calc(100vh-4rem)] flex">
        {/* Left Panel - 2D Editor */}
        <div className="w-80 border-r border-border bg-card/50 flex flex-col">
          <div className="p-4 border-b border-border">
            <h2 className="font-semibold">{project.name}</h2>
            <p className="text-sm text-muted-foreground">Editor 2D</p>
          </div>
          
          {/* Tabs for Walls/Openings */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
            <TabsList className="mx-4 mt-2 grid w-auto grid-cols-2">
              <TabsTrigger value="walls" className="gap-1 text-xs">
                <Layers className="h-3 w-3" />
                Paredes
              </TabsTrigger>
              <TabsTrigger value="openings" className="gap-1 text-xs">
                <DoorOpen className="h-3 w-3" />
                Aberturas
                {openings.length > 0 && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                    {openings.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="walls" className="flex-1 flex flex-col m-0 data-[state=inactive]:hidden">
              {/* Add Wall Form */}
              <div className="p-4 border-b border-border space-y-4">
                <div className="flex items-center gap-2">
                  <Plus className="h-4 w-4 text-primary" />
                  <span className="font-medium text-sm">Nova Parede</span>
                </div>
                
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Início X (mm)</Label>
                    <Input
                      type="number"
                      value={newWall.startX}
                      onChange={(e) => setNewWall({ ...newWall, startX: Number(e.target.value) })}
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Início Y (mm)</Label>
                    <Input
                      type="number"
                      value={newWall.startY}
                      onChange={(e) => setNewWall({ ...newWall, startY: Number(e.target.value) })}
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Fim X (mm)</Label>
                    <Input
                      type="number"
                      value={newWall.endX}
                      onChange={(e) => setNewWall({ ...newWall, endX: Number(e.target.value) })}
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Fim Y (mm)</Label>
                    <Input
                      type="number"
                      value={newWall.endY}
                      onChange={(e) => setNewWall({ ...newWall, endY: Number(e.target.value) })}
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                </div>
                
                <Button onClick={addWall} className="w-full gap-2" size="sm">
                  <Plus className="h-4 w-4" />
                  Adicionar Parede
                </Button>
              </div>
              
              {/* DXF Import */}
              <div className="p-4 border-b border-border space-y-2">
                <Button 
                  variant="outline" 
                  className="w-full gap-2" 
                  onClick={() => setDxfDialogOpen(true)}
                  disabled={importingDXF}
                >
                  <Upload className="h-4 w-4" />
                  {importingDXF ? 'A importar...' : 'Importar DXF'}
                </Button>

                <Button
                  variant="ghost"
                  className="w-full gap-2"
                  onClick={clearWalls}
                  disabled={importingDXF || walls.length === 0}
                  title={walls.length === 0 ? 'Sem paredes para limpar' : 'Remover todas as paredes do projeto'}
                >
                  <Trash2 className="h-4 w-4" />
                  Limpar paredes
                </Button>
              </div>
              
              {/* Wall List with Chains/Segments toggle */}
              <WallListPanel walls={walls} onDeleteWall={deleteWall} />
            </TabsContent>
            
            <TabsContent value="openings" className="flex-1 flex flex-col m-0 data-[state=inactive]:hidden">
              <OpeningsPanel
                openings={openings}
                chains={chains}
                candidates={activeCandidates}
                onAddOpening={addOpening}
                onUpdateOpening={updateOpening}
                onDeleteOpening={deleteOpening}
                onConvertCandidate={handleConvertCandidate}
                maxHeight={project.wall_height_mm}
              />
            </TabsContent>
          </Tabs>
          
          {/* Go to Estimate */}
          <div className="p-4 border-t border-border">
            <Link to={`/projects/${id}/estimate`}>
              <Button className="w-full gap-2" disabled={walls.length === 0}>
                Ver Orçamento
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
        
        {/* Right Panel - 3D Viewer */}
        <div className="flex-1 relative">
          <ICFViewer3D 
            walls={walls} 
            settings={viewerSettings}
            openings={openings}
            candidates={activeCandidates}
            selectedPanelId={selection.selectedPanelId}
            onPanelClick={handlePanelClick}
            onPanelDataReady={handlePanelDataReady}
            className="w-full h-full"
          />
          <ViewerControls 
            settings={viewerSettings}
            onSettingsChange={setViewerSettings}
            onFitView={fitView}
          />
          
          {/* Selection Mode Indicator */}
          {selection.selectedPanelId && (
            <div className="absolute top-4 right-4 toolbar">
              <Crosshair className="h-4 w-4 text-cyan-400" />
              <span className="text-xs text-cyan-400">Painel selecionado</span>
            </div>
          )}
          
          {/* Project Info Overlay */}
          <div className="absolute top-4 left-4 toolbar">
            <Box className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{project.name}</span>
            <span className="text-xs text-muted-foreground">
              tc: {project.concrete_thickness}mm | 
              {(project.wall_height_mm / 1000).toFixed(1)}m
            </span>
            {openings.length > 0 && (
              <Badge variant="outline" className="text-xs">
                {openings.length} aberturas
              </Badge>
            )}
          </div>
        </div>
      </div>
      
      {/* DXF Import Dialog */}
      <DXFImportDialog
        open={dxfDialogOpen}
        onOpenChange={setDxfDialogOpen}
        onImport={handleDXFImport}
      />
      
      {/* Panel Inspector */}
      <PanelInspector
        isOpen={inspectorOpen}
        onClose={handleCloseInspector}
        panelData={selectedPanelData}
        override={selection.selectedPanelId ? getOverride(selection.selectedPanelId) : undefined}
        conflicts={conflicts}
        coreConcreteMm={coreConcreteMm}
        onSetOverride={setOverride}
        onRemoveOverride={removeOverride}
        onLockPanel={lockPanel}
        onUnlockPanel={unlockPanel}
      />
    </MainLayout>
  );
}
