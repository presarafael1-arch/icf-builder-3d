import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Ruler, Layers, Upload, ArrowRight, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

export function NewProjectForm() {
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    concreteThickness: '150' as '150' | '200',
    wallHeightMm: 2800,
    rebarSpacingCm: 20,
    cornerMode: 'overlap_cut' as 'overlap_cut' | 'topo'
  });
  
  const rows = Math.ceil(formData.wallHeightMm / 400);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.name.trim()) {
      toast({
        title: 'Nome obrigatório',
        description: 'Por favor, insira um nome para o projeto.',
        variant: 'destructive'
      });
      return;
    }
    
    setIsSubmitting(true);
    
    try {
      const { data, error } = await supabase
        .from('projects')
        .insert({
          name: formData.name,
          description: formData.description || null,
          concrete_thickness: formData.concreteThickness,
          wall_height_mm: formData.wallHeightMm,
          rebar_spacing_cm: formData.rebarSpacingCm,
          corner_mode: formData.cornerMode
        })
        .select()
        .single();
      
      if (error) throw error;
      
      toast({
        title: 'Projeto criado',
        description: 'O seu novo projeto foi criado com sucesso.'
      });
      
      navigate(`/projects/${data.id}/editor`);
    } catch (error) {
      console.error('Error creating project:', error);
      toast({
        title: 'Erro ao criar projeto',
        description: 'Ocorreu um erro ao criar o projeto. Tente novamente.',
        variant: 'destructive'
      });
    } finally {
      setIsSubmitting(false);
    }
  };
  
  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-2xl">
      {/* Project Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Box className="h-5 w-5 text-primary" />
            Informações do Projeto
          </CardTitle>
          <CardDescription>
            Defina o nome e descrição do seu projeto ICF.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nome do Projeto *</Label>
            <Input
              id="name"
              placeholder="Ex: Casa Lote 42"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="text-lg"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="description">Descrição (opcional)</Label>
            <Textarea
              id="description"
              placeholder="Notas sobre o projeto..."
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              rows={3}
            />
          </div>
        </CardContent>
      </Card>
      
      {/* Structural Parameters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ruler className="h-5 w-5 text-primary" />
            Parâmetros Estruturais
          </CardTitle>
          <CardDescription>
            Configure as dimensões e especificações técnicas.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Concrete Thickness */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label>Núcleo de Betão (tc)</Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Espessura do núcleo de betão armado interior.</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <RadioGroup
              value={formData.concreteThickness}
              onValueChange={(value) => setFormData({ ...formData, concreteThickness: value as '150' | '200' })}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="150" id="tc-150" />
                <Label htmlFor="tc-150" className="font-mono cursor-pointer">150 mm</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="200" id="tc-200" />
                <Label htmlFor="tc-200" className="font-mono cursor-pointer">200 mm</Label>
              </div>
            </RadioGroup>
          </div>
          
          {/* Wall Height */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label>Altura Total da Parede</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Altura total das paredes em milímetros.</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <span className="text-sm font-mono text-primary">
                {formData.wallHeightMm} mm = {rows} fiadas
              </span>
            </div>
            <Slider
              value={[formData.wallHeightMm]}
              min={800}
              max={4000}
              step={100}
              onValueChange={([value]) => setFormData({ ...formData, wallHeightMm: value })}
            />
            <div className="flex justify-between text-xs text-muted-foreground font-mono">
              <span>800 mm</span>
              <span>4000 mm</span>
            </div>
          </div>
          
          {/* Rebar Spacing */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label>Espaçamento dos Ferros</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Espaçamento entre ferros da armadura. Afeta o número de webs.</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <span className="text-sm font-mono text-primary">
                {formData.rebarSpacingCm} cm
                {formData.rebarSpacingCm < 20 && (
                  <span className="text-warning ml-2">(+webs extra)</span>
                )}
              </span>
            </div>
            <Slider
              value={[formData.rebarSpacingCm]}
              min={10}
              max={25}
              step={1}
              onValueChange={([value]) => setFormData({ ...formData, rebarSpacingCm: value })}
            />
            <div className="flex justify-between text-xs text-muted-foreground font-mono">
              <span>10 cm</span>
              <span>20 cm (standard)</span>
              <span>25 cm</span>
            </div>
          </div>
          
          {/* Corner Mode */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label>Modo de Cantos</Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Define como os cantos L são tratados.</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <RadioGroup
              value={formData.cornerMode}
              onValueChange={(value) => setFormData({ ...formData, cornerMode: value as 'overlap_cut' | 'topo' })}
              className="grid grid-cols-2 gap-4"
            >
              <Label
                htmlFor="corner-overlap"
                className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 cursor-pointer transition-all ${
                  formData.cornerMode === 'overlap_cut' 
                    ? 'border-primary bg-primary/5' 
                    : 'border-border hover:border-primary/50'
                }`}
              >
                <RadioGroupItem value="overlap_cut" id="corner-overlap" className="sr-only" />
                <Layers className="h-6 w-6" />
                <span className="text-sm font-medium">Overlap + Corte</span>
                <span className="text-xs text-muted-foreground text-center">
                  Painéis avançam e são cortados (default)
                </span>
              </Label>
              
              <Label
                htmlFor="corner-topo"
                className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 cursor-pointer transition-all ${
                  formData.cornerMode === 'topo' 
                    ? 'border-primary bg-primary/5' 
                    : 'border-border hover:border-primary/50'
                }`}
              >
                <RadioGroupItem value="topo" id="corner-topo" className="sr-only" />
                <Box className="h-6 w-6" />
                <span className="text-sm font-medium">Topo no Canto</span>
                <span className="text-xs text-muted-foreground text-center">
                  Usa topo em fiadas alternadas
                </span>
              </Label>
            </RadioGroup>
          </div>
        </CardContent>
      </Card>
      
      {/* Submit */}
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={() => navigate('/projects')}>
          Cancelar
        </Button>
        <Button type="submit" disabled={isSubmitting} className="gap-2">
          {isSubmitting ? (
            'A criar...'
          ) : (
            <>
              Criar Projeto
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
