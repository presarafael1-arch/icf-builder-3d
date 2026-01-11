import { Box, Calendar, Layers, ArrowRight, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import { pt } from 'date-fns/locale';

interface ProjectCardProps {
  id: string;
  name: string;
  description?: string;
  concreteThickness: string;
  wallHeightMm: number;
  createdAt: Date;
  updatedAt: Date;
  wallCount?: number;
  onDelete?: (id: string) => void;
}

export function ProjectCard({
  id,
  name,
  description,
  concreteThickness,
  wallHeightMm,
  createdAt,
  updatedAt,
  wallCount = 0,
  onDelete
}: ProjectCardProps) {
  const rows = Math.ceil(wallHeightMm / 400);
  
  return (
    <Card className="group relative overflow-hidden transition-all hover:border-primary/50 hover:shadow-glow-sm animate-fade-in">
      {/* Decorative corner */}
      <div className="absolute top-0 right-0 w-16 h-16 overflow-hidden">
        <div className="absolute top-0 right-0 w-[200%] h-1 bg-gradient-to-r from-transparent via-primary/50 to-primary origin-top-right -rotate-45 translate-x-1/2" />
      </div>
      
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="font-semibold text-lg tracking-tight text-foreground group-hover:text-primary transition-colors">
              {name}
            </h3>
            {description && (
              <p className="text-sm text-muted-foreground line-clamp-2">
                {description}
              </p>
            )}
          </div>
          <Box className="h-5 w-5 text-primary/50 group-hover:text-primary transition-colors" />
        </div>
      </CardHeader>
      
      <CardContent className="pb-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1">
            <span className="data-label">Núcleo</span>
            <p className="text-sm font-medium">{concreteThickness} mm</p>
          </div>
          <div className="space-y-1">
            <span className="data-label">Altura</span>
            <p className="text-sm font-medium">{(wallHeightMm / 1000).toFixed(1)} m</p>
          </div>
          <div className="space-y-1">
            <span className="data-label">Fiadas</span>
            <p className="text-sm font-medium">{rows}</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2 mt-4">
          <Badge variant="secondary" className="gap-1">
            <Layers className="h-3 w-3" />
            {wallCount} paredes
          </Badge>
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {formatDistanceToNow(updatedAt, { addSuffix: true, locale: pt })}
          </Badge>
        </div>
      </CardContent>
      
      <CardFooter className="pt-0 gap-2">
        <Link to={`/projects/${id}/editor`} className="flex-1">
          <Button variant="secondary" className="w-full gap-2 group/btn">
            Editor 2D
          </Button>
        </Link>
        <Link to={`/projects/${id}/estimate`}>
          <Button className="gap-2">
            Orçamento
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Button>
        </Link>
        {onDelete && (
          <Button 
            variant="ghost" 
            size="icon"
            onClick={(e) => {
              e.preventDefault();
              onDelete(id);
            }}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
