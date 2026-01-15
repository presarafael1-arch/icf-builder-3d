import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Download, FileSpreadsheet, Box, Loader2 } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { BOMTable } from '@/components/bom/BOMTable';
import { ICFViewer3D } from '@/components/viewer/ICFViewer3D';
import { ViewerControls } from '@/components/viewer/ViewerControls';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOpenings } from '@/hooks/useOpenings';
import { WallSegment, ViewerSettings, BOMResult, ConcreteThickness, CornerMode, RebarSpacing, Opening } from '@/types/icf';
import { calculateWallLength, calculateWallAngle, calculateBOM, calculateNumberOfRows } from '@/lib/icf-calculations';
import { generateBOMCSV, downloadCSV, generateFilename } from '@/lib/export-csv';
import { generateBOMPDF, captureCanvasScreenshot } from '@/lib/export-pdf';

interface Project {
  id: string;
  name: string;
  description: string | null;
  concrete_thickness: string;
  wall_height_mm: number;
  rebar_spacing_cm: number;
  corner_mode: string;
}

interface Wall {
  id: string;
  project_id: string;
  start_x: number;
  start_y: number;
  end_x: number;
  end_y: number;
}

export default function ProjectEstimate() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  
  const [project, setProject] = useState<Project | null>(null);
  const [walls, setWalls] = useState<WallSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportingCSV, setExportingCSV] = useState(false);
  const [exportingPDF, setExportingPDF] = useState(false);
  
  // Openings from localStorage
  const { openings } = useOpenings(id);
  
  // Viewer settings
  const [viewerSettings, setViewerSettings] = useState<ViewerSettings>({
    // View mode
    viewMode: 'panels',

    // Debug
    showDXFLines: false, // Segments
    showChains: true, // Chains
    showHelpers: false,

    // Layers
    showPanels: true,
    showTopos: true,
    showWebs: true,
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
    concreteThickness: '150'
  });
  
  useEffect(() => {
    if (id) {
      fetchData();
    }
  }, [id]);
  
  const fetchData = async () => {
    try {
      // Fetch project
      const { data: projectData, error: projectError } = await supabase
        .from('projects')
        .select('*')
        .eq('id', id)
        .single();
      
      if (projectError) throw projectError;
      setProject(projectData);
      
      // Update settings based on project
      const rows = calculateNumberOfRows(projectData.wall_height_mm);
      setViewerSettings(prev => ({ 
        ...prev, 
        maxRows: rows, 
        currentRow: rows,
        rebarSpacing: projectData.rebar_spacing_cm as RebarSpacing,
        concreteThickness: projectData.concrete_thickness as ConcreteThickness
      }));
      
      // Fetch walls
      const { data: wallsData, error: wallsError } = await supabase
        .from('walls')
        .select('*')
        .eq('project_id', id);
      
      if (wallsError) throw wallsError;
      
      const mappedWalls: WallSegment[] = (wallsData || []).map((wall: Wall) => {
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
      
      setWalls(mappedWalls);
    } catch (error) {
      console.error('Error fetching data:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível carregar os dados.',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };
  
  // Convert OpeningData to legacy Opening format for BOM calculation
  const bomOpenings: Opening[] = useMemo(() => {
    return openings.map(o => ({
      id: o.id,
      wallId: o.chainId,
      type: o.kind === 'door' ? 'door' : 'window',
      widthMm: o.widthMm,
      heightMm: o.heightMm,
      sillHeightMm: o.sillMm,
      positionMm: o.offsetMm,
      chainId: o.chainId,
    }));
  }, [openings]);
  
  // Calculate BOM with openings
  const bom: BOMResult | null = useMemo(() => {
    if (!project || walls.length === 0) return null;
    
    return calculateBOM(
      walls,
      bomOpenings,
      project.wall_height_mm,
      project.rebar_spacing_cm,
      project.concrete_thickness as ConcreteThickness,
      project.corner_mode as CornerMode
    );
  }, [project, walls, bomOpenings]);
  
  const handleExportCSV = () => {
    if (!bom || !project) return;
    
    setExportingCSV(true);
    try {
      // Pass openings to CSV export
      const csvContent = generateBOMCSV(bom, {
        projectName: project.name,
        concreteThickness: project.concrete_thickness as ConcreteThickness,
        wallHeightMm: project.wall_height_mm,
        rebarSpacingCm: project.rebar_spacing_cm,
        cornerMode: project.corner_mode,
        numberOfRows: bom.numberOfRows,
      }, openings);
      
      const filename = generateFilename(project.name, 'csv');
      downloadCSV(csvContent, filename);
      
      toast({
        title: 'CSV Exportado',
        description: `Ficheiro ${filename} descarregado.`
      });
    } catch (error) {
      console.error('Error exporting CSV:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível exportar o CSV.',
        variant: 'destructive'
      });
    } finally {
      setExportingCSV(false);
    }
  };
  
  const handleExportPDF = async () => {
    if (!bom || !project) return;
    
    setExportingPDF(true);
    try {
      // Wait a bit for the 3D view to be fully rendered
      await new Promise(resolve => setTimeout(resolve, 500));
      const screenshot = await captureCanvasScreenshot();
      
      await generateBOMPDF(bom, {
        name: project.name,
        concreteThickness: project.concrete_thickness as ConcreteThickness,
        wallHeightMm: project.wall_height_mm,
        rebarSpacingCm: project.rebar_spacing_cm,
        cornerMode: project.corner_mode,
        numberOfRows: bom.numberOfRows
      }, screenshot);
      
      toast({
        title: 'PDF Exportado',
        description: 'Ficheiro PDF descarregado.'
      });
    } catch (error) {
      console.error('Error exporting PDF:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível exportar o PDF.',
        variant: 'destructive'
      });
    } finally {
      setExportingPDF(false);
    }
  };
  
  const getRebarLabel = (spacing: number) => {
    if (spacing === 20) return '20 cm (Standard)';
    if (spacing === 15) return '15 cm (+1 web extra)';
    if (spacing === 10) return '10 cm (+2 webs extra)';
    return `${spacing} cm`;
  };
  
  if (loading || !project) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-pulse text-muted-foreground">A carregar...</div>
        </div>
      </MainLayout>
    );
  }
  
  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link to={`/projects/${id}/editor`}>
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
              <p className="text-muted-foreground">Orçamentação Automática</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button 
                    variant="outline" 
                    className="gap-2" 
                    onClick={handleExportCSV}
                    disabled={!bom || exportingCSV}
                  >
                    {exportingCSV ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FileSpreadsheet className="h-4 w-4" />
                    )}
                    Exportar CSV
                  </Button>
                </span>
              </TooltipTrigger>
              {!bom && (
                <TooltipContent>
                  <p>Sem paredes para orçamentar</p>
                </TooltipContent>
              )}
            </Tooltip>
            
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button 
                    variant="outline" 
                    className="gap-2" 
                    onClick={handleExportPDF}
                    disabled={!bom || exportingPDF}
                  >
                    {exportingPDF ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    Exportar PDF
                  </Button>
                </span>
              </TooltipTrigger>
              {!bom && (
                <TooltipContent>
                  <p>Sem paredes para orçamentar</p>
                </TooltipContent>
              )}
            </Tooltip>
          </div>
        </div>
        
        {/* Main Content */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* 3D Viewer */}
          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2">
                <Box className="h-5 w-5 text-primary" />
                Visualização 3D
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="relative h-[500px]">
                <ICFViewer3D 
                  walls={walls} 
                  settings={viewerSettings}
                  openings={openings}
                  className="w-full h-full rounded-none"
                />
                <ViewerControls
                  settings={viewerSettings}
                  onSettingsChange={setViewerSettings}
                  onFitView={() => window.dispatchEvent(new CustomEvent('icf-fit-view'))}
                />
              </div>
            </CardContent>
          </Card>
          
          {/* Project Info */}
          <Card>
            <CardHeader>
              <CardTitle>Parâmetros do Projeto</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <span className="data-label">Núcleo de Betão</span>
                  <p className="data-value">{project.concrete_thickness}<span className="data-unit">mm</span></p>
                </div>
                <div>
                  <span className="data-label">Altura Total</span>
                  <p className="data-value">{(project.wall_height_mm / 1000).toFixed(1)}<span className="data-unit">m</span></p>
                </div>
                <div>
                  <span className="data-label">Espaçamento Ferros</span>
                  <p className="data-value text-sm">{getRebarLabel(project.rebar_spacing_cm)}</p>
                </div>
                <div>
                  <span className="data-label">Modo Cantos</span>
                  <p className="data-value text-sm">
                    {project.corner_mode === 'overlap_cut' ? 'Overlap + Corte' : 'Topo'}
                  </p>
                </div>
                <div>
                  <span className="data-label">Nº Paredes</span>
                  <p className="data-value">{walls.length}</p>
                </div>
                <div>
                  <span className="data-label">Nº Fiadas</span>
                  <p className="data-value">{bom?.numberOfRows || 0}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
        
        {/* BOM */}
        {bom ? (
          <BOMTable bom={bom} concreteThickness={project.concrete_thickness} />
        ) : (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">
              Adicione paredes no editor para ver a orçamentação.
            </p>
            <Link to={`/projects/${id}/editor`}>
              <Button className="mt-4">Ir para Editor</Button>
            </Link>
          </Card>
        )}
      </div>
    </MainLayout>
  );
}
