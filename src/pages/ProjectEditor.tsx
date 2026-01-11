import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Box, Upload, Plus, Trash2, ArrowRight, Layers, MousePointer } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { ICFViewer3D } from '@/components/viewer/ICFViewer3D';
import { ViewerControls } from '@/components/viewer/ViewerControls';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { WallSegment, ViewerSettings } from '@/types/icf';
import { calculateWallLength, calculateWallAngle, calculateNumberOfRows } from '@/lib/icf-calculations';

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

export default function ProjectEditor() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  
  const [project, setProject] = useState<Project | null>(null);
  const [walls, setWalls] = useState<WallSegment[]>([]);
  const [loading, setLoading] = useState(true);
  
  // New wall form
  const [newWall, setNewWall] = useState({
    startX: 0,
    startY: 0,
    endX: 1200,
    endY: 0
  });
  
  // Viewer settings
  const [viewerSettings, setViewerSettings] = useState<ViewerSettings>({
    showPanels: true,
    showTopos: true,
    showWebs: false,
    showTarugos: false,
    showOpenings: true,
    showJunctions: true,
    showGrid: true,
    currentRow: 1,
    maxRows: 7,
    wireframe: false
  });
  
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
      
      // Update max rows based on wall height
      const rows = calculateNumberOfRows(data.wall_height_mm);
      setViewerSettings(prev => ({ ...prev, maxRows: rows, currentRow: rows }));
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
          <div className="p-4 border-b border-border">
            <Button variant="outline" className="w-full gap-2" disabled>
              <Upload className="h-4 w-4" />
              Importar DXF
              <span className="text-xs text-muted-foreground">(em breve)</span>
            </Button>
          </div>
          
          {/* Wall List */}
          <div className="flex-1 overflow-auto p-4">
            <div className="flex items-center gap-2 mb-3">
              <Layers className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Paredes ({walls.length})</span>
            </div>
            
            <div className="space-y-2">
              {walls.map((wall, index) => (
                <div 
                  key={wall.id} 
                  className="flex items-center justify-between p-2 rounded-md bg-muted/30 hover:bg-muted/50 transition-colors group"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground">#{index + 1}</span>
                    <span className="text-sm font-mono">{(wall.length / 1000).toFixed(2)} m</span>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => deleteWall(wall.id)}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                </div>
              ))}
              
              {walls.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <MousePointer className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">Sem paredes</p>
                  <p className="text-xs">Adicione paredes manualmente ou importe um DXF</p>
                </div>
              )}
            </div>
          </div>
          
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
            className="w-full h-full"
          />
          <ViewerControls 
            settings={viewerSettings}
            onSettingsChange={setViewerSettings}
          />
          
          {/* Project Info Overlay */}
          <div className="absolute top-4 left-4 toolbar">
            <Box className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{project.name}</span>
            <span className="text-xs text-muted-foreground">
              tc: {project.concrete_thickness}mm | 
              {(project.wall_height_mm / 1000).toFixed(1)}m
            </span>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
