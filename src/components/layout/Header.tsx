import { Box, Layers, Settings } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export function Header() {
  const location = useLocation();
  
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-card/80 backdrop-blur-md">
      <div className="container flex h-16 items-center justify-between px-4">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-3 group">
          <div className="relative">
            <Box className="h-8 w-8 text-primary transition-transform group-hover:scale-110" />
            <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="flex flex-col">
            <span className="text-lg font-bold text-foreground tracking-tight">
              OMNI ICF
            </span>
            <span className="text-[10px] font-medium uppercase tracking-widest text-primary">
              Walls 3D Planner
            </span>
          </div>
        </Link>
        
        {/* Navigation */}
        <nav className="hidden md:flex items-center gap-1">
          <Link to="/projects">
            <Button
              variant={location.pathname.includes('/projects') ? 'secondary' : 'ghost'}
              size="sm"
              className="gap-2"
            >
              <Layers className="h-4 w-4" />
              Projects
            </Button>
          </Link>
        </nav>
        
        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="hidden md:flex">
            <Settings className="h-4 w-4" />
          </Button>
          <Link to="/projects/new">
            <Button size="sm" className="gap-2 glow-primary">
              <Box className="h-4 w-4" />
              New Project
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
