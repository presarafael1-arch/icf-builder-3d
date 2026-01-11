import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Box, Plus, Search, FolderOpen } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { ProjectCard } from '@/components/project/ProjectCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface Project {
  id: string;
  name: string;
  description: string | null;
  concrete_thickness: string;
  wall_height_mm: number;
  created_at: string;
  updated_at: string;
}

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const { toast } = useToast();
  
  const fetchProjects = async () => {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('updated_at', { ascending: false });
      
      if (error) throw error;
      setProjects(data || []);
    } catch (error) {
      console.error('Error fetching projects:', error);
      toast({
        title: 'Erro ao carregar projetos',
        description: 'Não foi possível carregar os projetos.',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    fetchProjects();
  }, []);
  
  const handleDeleteProject = async (id: string) => {
    if (!confirm('Tem a certeza que pretende eliminar este projeto?')) return;
    
    try {
      const { error } = await supabase
        .from('projects')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
      
      setProjects(projects.filter(p => p.id !== id));
      toast({
        title: 'Projeto eliminado',
        description: 'O projeto foi eliminado com sucesso.'
      });
    } catch (error) {
      console.error('Error deleting project:', error);
      toast({
        title: 'Erro ao eliminar',
        description: 'Não foi possível eliminar o projeto.',
        variant: 'destructive'
      });
    }
  };
  
  const filteredProjects = projects.filter(project =>
    project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (project.description?.toLowerCase().includes(searchQuery.toLowerCase()))
  );
  
  return (
    <MainLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Projetos</h1>
            <p className="text-muted-foreground mt-1">
              Gerir os seus projetos de paredes ICF
            </p>
          </div>
          
          <Link to="/projects/new">
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Novo Projeto
            </Button>
          </Link>
        </div>
        
        {/* Search */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Pesquisar projetos..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        
        {/* Projects Grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-64 bg-card rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filteredProjects.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredProjects.map((project) => (
              <ProjectCard
                key={project.id}
                id={project.id}
                name={project.name}
                description={project.description || undefined}
                concreteThickness={project.concrete_thickness}
                wallHeightMm={project.wall_height_mm}
                createdAt={new Date(project.created_at)}
                updatedAt={new Date(project.updated_at)}
                onDelete={handleDeleteProject}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <FolderOpen className="h-16 w-16 text-muted-foreground/50 mb-4" />
            <h2 className="text-xl font-semibold mb-2">Sem projetos</h2>
            <p className="text-muted-foreground mb-6">
              {searchQuery 
                ? 'Nenhum projeto encontrado com essa pesquisa.' 
                : 'Comece criando o seu primeiro projeto ICF.'}
            </p>
            {!searchQuery && (
              <Link to="/projects/new">
                <Button className="gap-2">
                  <Plus className="h-4 w-4" />
                  Criar Primeiro Projeto
                </Button>
              </Link>
            )}
          </div>
        )}
      </div>
    </MainLayout>
  );
}
