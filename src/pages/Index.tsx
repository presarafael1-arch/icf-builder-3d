import { Link } from 'react-router-dom';
import { Box, Layers, Ruler, FileSpreadsheet, ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MainLayout } from '@/components/layout/MainLayout';

const features = [
  {
    icon: Layers,
    title: 'Importação DXF',
    description: 'Importe plantas diretamente de ficheiros DXF. Selecione layers e confirme paredes automaticamente.'
  },
  {
    icon: Box,
    title: 'Visualização 3D',
    description: 'Visualize as suas paredes ICF em 3D com controlo por fiadas. Painéis, topos, webs e tarugos.'
  },
  {
    icon: Ruler,
    title: 'Cálculo Automático',
    description: 'BOM completa com contagem precisa de painéis, tarugos, topos e webs baseada nas regras do sistema.'
  },
  {
    icon: FileSpreadsheet,
    title: 'Exportação',
    description: 'Exporte orçamentos em CSV/Excel e relatórios PDF com imagens 3D e tabelas BOM.'
  }
];

export default function Index() {
  return (
    <MainLayout>
      <div className="flex flex-col items-center justify-center min-h-[80vh] py-12">
        {/* Hero */}
        <div className="text-center space-y-6 max-w-3xl animate-fade-in">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 border border-primary/20">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-primary">Sistema ICF Patenteado</span>
          </div>
          
          {/* Title */}
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            <span className="text-gradient">OMNI ICF</span>
            <br />
            <span className="text-foreground">Walls 3D Planner</span>
          </h1>
          
          {/* Description */}
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto">
            Orçamentação automática e visualização 3D para o seu sistema ICF. 
            Importe plantas DXF, configure parâmetros e obtenha BOM completa em minutos.
          </p>
          
          {/* CTA */}
          <div className="flex items-center justify-center gap-4 pt-4">
            <Link to="/projects/new">
              <Button size="lg" className="gap-2 glow-primary animate-pulse-glow">
                <Box className="h-5 w-5" />
                Novo Projeto
              </Button>
            </Link>
            <Link to="/projects">
              <Button size="lg" variant="secondary" className="gap-2">
                Ver Projetos
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
        
        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mt-20 w-full max-w-6xl animate-slide-up">
          {features.map((feature, index) => (
            <div 
              key={feature.title}
              className="card-technical group hover:border-primary/30 transition-all hover-lift"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              <feature.icon className="h-10 w-10 text-primary mb-4 group-hover:scale-110 transition-transform" />
              <h3 className="font-semibold text-foreground mb-2">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
        
        {/* Technical Specs */}
        <div className="mt-20 w-full max-w-4xl">
          <div className="card-highlight p-8">
            <h2 className="text-xl font-semibold text-center mb-6">Especificações do Sistema</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
              <div>
                <span className="data-label">Painel</span>
                <p className="data-value">1200×400<span className="data-unit">mm</span></p>
              </div>
              <div>
                <span className="data-label">Espessura</span>
                <p className="data-value">70.59<span className="data-unit">mm</span></p>
              </div>
              <div>
                <span className="data-label">Núcleo tc</span>
                <p className="data-value">150-200<span className="data-unit">mm</span></p>
              </div>
              <div>
                <span className="data-label">Blocos</span>
                <p className="data-value">2<span className="data-unit">painéis/bloco</span></p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
