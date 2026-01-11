import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Download, FileSpreadsheet, Box } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { BOMTable } from '@/components/bom/BOMTable';
import { ICFViewer3D } from '@/components/viewer/ICFViewer3D';
import { ViewerControls } from '@/components/viewer/ViewerControls';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { WallSegment, ViewerSettings, BOMResult, ConcreteThickness, CornerMode, RebarSpacing } from '@/types/icf';
import { calculateWallLength, calculateWallAngle, calculateBOM, calculateNumberOfRows } from '@/lib/icf-calculations';

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
  
  // Viewer settings
  const [viewerSettings, setViewerSettings] = useState<ViewerSettings>({
    showPanels: true,
    showTopos: true,
    showWebs: true,
    showTarugos: false,
    showOpenings: true,
    showJunctions: true,
    showGrid: true,
    showGrids: true,
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
  
  // Calculate BOM
  const bom: BOMResult | null = useMemo(() => {
    if (!project || walls.length === 0) return null;
    
    return calculateBOM(
      walls,
      [], // openings - will be implemented later
      project.wall_height_mm,
      project.rebar_spacing_cm,
      project.concrete_thickness as ConcreteThickness,
      project.corner_mode as CornerMode
    );
  }, [project, walls]);
  
  const exportCSV = () => {
    if (!bom || !project) return;
    
    const rows = [
      ['Item', 'Descrição', 'Quantidade', 'Unidade'],
      ['1', 'Painel Standard 1200x400mm', bom.panelsCount, 'un'],
      ['2', 'Tarugos (total)', bom.tarugosTotal, 'un'],
      ['3', 'Tarugos de Injeção', bom.tarugosInjection, 'un'],
      ['4', `Topo (${project.concrete_thickness}mm)`, bom.toposUnits, 'un'],
      ['5', 'Webs Distanciadoras', bom.websTotal, 'un'],
      ['', 'Cortes', bom.cutsCount, 'cortes']
    ];
    
    const csv = rows.map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${project.name.replace(/\s+/g, '_')}_BOM.csv`;
    link.click();
    URL.revokeObjectURL(url);
    
    toast({
      title: 'Exportado',
      description: 'Ficheiro CSV exportado com sucesso.'
    });
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
            <Button variant="outline" className="gap-2" disabled>
              <FileSpreadsheet className="h-4 w-4" />
              Exportar CSV
              <span className="text-xs text-muted-foreground">(em breve)</span>
            </Button>
            <Button variant="outline" className="gap-2" disabled>
              <Download className="h-4 w-4" />
              Exportar PDF
              <span className="text-xs text-muted-foreground">(em breve)</span>
            </Button>
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
                  className="w-full h-full rounded-none"
                />
                <ViewerControls
                  settings={viewerSettings}
                  onSettingsChange={setViewerSettings}
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
                  <p className="data-value">{project.rebar_spacing_cm}<span className="data-unit">cm</span></p>
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
