// Openings Panel for Project Editor - Add/Edit doors and windows
// Includes "Detetadas" section for auto-detected opening candidates
import { useState, useMemo } from 'react';
import { DoorOpen, LayoutGrid, Plus, Trash2, Check, X, Scan, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { 
  OpeningData, 
  OpeningKind, 
  OpeningTemplate,
  OpeningCandidate,
  DOOR_TEMPLATES, 
  WINDOW_TEMPLATES,
  getAffectedRows,
  calculateOpeningTopos,
  generateOpeningLabel 
} from '@/types/openings';
import { WallChain, ChainsResult } from '@/lib/wall-chains';

interface OpeningsPanelProps {
  openings: OpeningData[];
  chains: WallChain[];
  candidates?: OpeningCandidate[];
  onAddOpening: (
    chainId: string,
    kind: OpeningKind,
    widthMm: number,
    heightMm: number,
    sillMm: number,
    offsetMm: number,
    label?: string
  ) => Promise<OpeningData | null>;
  onUpdateOpening: (id: string, updates: Partial<OpeningData>) => Promise<boolean>;
  onDeleteOpening: (id: string) => Promise<boolean>;
  onConvertCandidate?: (candidateId: string) => void;
  maxHeight: number; // Wall height to validate openings
}

type AddMode = 'none' | 'door' | 'window';

export function OpeningsPanel({
  openings,
  chains,
  candidates = [],
  onAddOpening,
  onUpdateOpening,
  onDeleteOpening,
  onConvertCandidate,
  maxHeight,
}: OpeningsPanelProps) {
  const [addMode, setAddMode] = useState<AddMode>('none');
  const [editingId, setEditingId] = useState<string | null>(null);
  
  // Form state for new opening
  const [newOpening, setNewOpening] = useState({
    chainId: '',
    template: 'custom',
    widthMm: 800,
    heightMm: 2000,
    sillMm: 0,
    offsetMm: 0,
    label: '',
  });

  // Track which candidate is being converted (if any)
  const [convertingCandidateId, setConvertingCandidateId] = useState<string | null>(null);

  // Filter candidates that haven't been converted yet
  const activeCandidates = useMemo(() => 
    candidates.filter(c => c.status === 'detected'),
    [candidates]
  );

  const templates = addMode === 'door' ? DOOR_TEMPLATES : addMode === 'window' ? WINDOW_TEMPLATES : [];

  const handleTemplateChange = (templateName: string) => {
    if (templateName === 'custom') {
      setNewOpening(prev => ({ ...prev, template: 'custom' }));
      return;
    }
    
    const template = templates.find(t => t.name === templateName);
    if (template) {
      setNewOpening(prev => ({
        ...prev,
        template: templateName,
        widthMm: template.widthMm,
        heightMm: template.heightMm,
        sillMm: template.sillMm,
      }));
    }
  };

  const handleStartAdd = (kind: OpeningKind) => {
    setAddMode(kind);
    setConvertingCandidateId(null);
    const defaultTemplate = kind === 'door' ? DOOR_TEMPLATES[1] : WINDOW_TEMPLATES[0];
    setNewOpening({
      chainId: chains.length > 0 ? chains[0].id : '',
      template: defaultTemplate.name,
      widthMm: defaultTemplate.widthMm,
      heightMm: defaultTemplate.heightMm,
      sillMm: defaultTemplate.sillMm,
      offsetMm: 0,
      label: generateOpeningLabel(kind, openings),
    });
  };

  // Start adding from a detected candidate
  const handleCreateFromCandidate = (candidate: OpeningCandidate) => {
    setConvertingCandidateId(candidate.id);
    // Default to door if width >= 700, otherwise window
    const kind: OpeningKind = candidate.widthMm >= 700 ? 'door' : 'window';
    setAddMode(kind);
    
    const defaultTemplate = kind === 'door' ? DOOR_TEMPLATES[1] : WINDOW_TEMPLATES[0];
    setNewOpening({
      chainId: candidate.chainId,
      template: defaultTemplate.name,
      widthMm: Math.round(candidate.widthMm), // Use detected width
      heightMm: defaultTemplate.heightMm,
      sillMm: defaultTemplate.sillMm,
      offsetMm: Math.round(candidate.startDistMm), // Use detected position
      label: generateOpeningLabel(kind, openings),
    });
  };

  const handleCancelAdd = () => {
    setAddMode('none');
    setConvertingCandidateId(null);
    setNewOpening({
      chainId: '',
      template: 'custom',
      widthMm: 800,
      heightMm: 2000,
      sillMm: 0,
      offsetMm: 0,
      label: '',
    });
  };

  const handleConfirmAdd = async () => {
    if (!newOpening.chainId) return;
    
    const chain = chains.find(c => c.id === newOpening.chainId);
    if (!chain) return;

    // Validate offset
    const maxOffset = Math.max(0, chain.lengthMm - newOpening.widthMm);
    const safeOffset = Math.min(Math.max(0, newOpening.offsetMm), maxOffset);

    // Validate height
    if (newOpening.sillMm + newOpening.heightMm > maxHeight) {
      return; // TODO: show error
    }

    const result = await onAddOpening(
      newOpening.chainId,
      addMode as OpeningKind,
      newOpening.widthMm,
      newOpening.heightMm,
      newOpening.sillMm,
      safeOffset,
      newOpening.label
    );

    // If we were converting a candidate, mark it as converted
    if (result && convertingCandidateId && onConvertCandidate) {
      onConvertCandidate(convertingCandidateId);
    }

    handleCancelAdd();
  };

  const getChainLabel = (chainId: string) => {
    const idx = chains.findIndex(c => c.id === chainId);
    return idx >= 0 ? `Cadeia #${idx + 1}` : 'Desconhecida';
  };

  const getChainForCandidate = (candidate: OpeningCandidate) => {
    const idx = chains.findIndex(c => c.id === candidate.chainId);
    return idx >= 0 ? `#${idx + 1}` : '?';
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-2 mb-3">
          <DoorOpen className="h-4 w-4 text-primary" />
          <span className="font-medium">Aberturas</span>
          <Badge variant="secondary" className="ml-auto">
            {openings.length}
          </Badge>
        </div>
        
        {/* Add buttons */}
        {addMode === 'none' && (
          <div className="flex gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              className="flex-1 gap-1"
              onClick={() => handleStartAdd('door')}
              disabled={chains.length === 0}
            >
              <Plus className="h-3 w-3" />
              Porta
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              className="flex-1 gap-1"
              onClick={() => handleStartAdd('window')}
              disabled={chains.length === 0}
            >
              <Plus className="h-3 w-3" />
              Janela
            </Button>
          </div>
        )}

        {/* Add form */}
        {addMode !== 'none' && (
          <div className="space-y-3 p-3 bg-muted/30 rounded-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  Nova {addMode === 'door' ? 'Porta' : 'Janela'}
                </span>
                {convertingCandidateId && (
                  <Badge variant="outline" className="text-[10px] bg-orange-500/10 border-orange-500/30">
                    de {candidates.find(c => c.id === convertingCandidateId)?.label}
                  </Badge>
                )}
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCancelAdd}>
                  <X className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-primary" onClick={handleConfirmAdd}>
                  <Check className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {/* Template selector */}
            <div>
              <Label className="text-xs">Modelo</Label>
              <Select value={newOpening.template} onValueChange={handleTemplateChange}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {templates.map(t => (
                    <SelectItem key={t.name} value={t.name} className="text-xs">
                      {t.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom" className="text-xs">Personalizado</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Chain selector */}
            <div>
              <Label className="text-xs">Parede/Cadeia</Label>
              <Select value={newOpening.chainId} onValueChange={(v) => setNewOpening(prev => ({ ...prev, chainId: v }))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Selecionar parede..." />
                </SelectTrigger>
                <SelectContent>
                  {chains.map((chain, idx) => (
                    <SelectItem key={chain.id} value={chain.id} className="text-xs">
                      #{idx + 1} - {(chain.lengthMm / 1000).toFixed(2)}m
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Dimensions */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Largura (mm)</Label>
                <Input
                  type="number"
                  value={newOpening.widthMm}
                  onChange={(e) => setNewOpening(prev => ({ ...prev, widthMm: Number(e.target.value) }))}
                  className="h-7 text-xs font-mono"
                />
              </div>
              <div>
                <Label className="text-xs">Altura (mm)</Label>
                <Input
                  type="number"
                  value={newOpening.heightMm}
                  onChange={(e) => setNewOpening(prev => ({ ...prev, heightMm: Number(e.target.value) }))}
                  className="h-7 text-xs font-mono"
                />
              </div>
            </div>

            {/* Sill and offset */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Cota arranque (mm)</Label>
                <Input
                  type="number"
                  value={newOpening.sillMm}
                  onChange={(e) => setNewOpening(prev => ({ ...prev, sillMm: Number(e.target.value) }))}
                  className="h-7 text-xs font-mono"
                  disabled={addMode === 'door'}
                />
              </div>
              <div>
                <Label className="text-xs">Posição (mm)</Label>
                <Input
                  type="number"
                  value={newOpening.offsetMm}
                  onChange={(e) => setNewOpening(prev => ({ ...prev, offsetMm: Number(e.target.value) }))}
                  className="h-7 text-xs font-mono"
                  placeholder="desde início da cadeia"
                />
                <span className="text-[10px] text-muted-foreground">
                  a partir do início da cadeia
                </span>
              </div>
            </div>

            {/* Validation warning */}
            {newOpening.chainId && (() => {
              const chain = chains.find(c => c.id === newOpening.chainId);
              if (!chain) return null;
              const maxPos = chain.lengthMm - newOpening.widthMm;
              if (newOpening.offsetMm > maxPos) {
                return (
                  <div className="text-[10px] text-destructive bg-destructive/10 px-2 py-1 rounded">
                    ⚠️ Posição + largura excedem a cadeia ({chain.lengthMm}mm). Máx: {Math.max(0, maxPos)}mm
                  </div>
                );
              }
              return null;
            })()}

            {/* Label */}
            <div>
              <Label className="text-xs">Etiqueta</Label>
              <Input
                value={newOpening.label}
                onChange={(e) => setNewOpening(prev => ({ ...prev, label: e.target.value }))}
                className="h-7 text-xs font-mono"
                placeholder="P1, J1..."
              />
            </div>
          </div>
        )}
      </div>

      {/* Detected Candidates Section */}
      {activeCandidates.length > 0 && addMode === 'none' && (
        <div className="p-3 border-b border-border bg-orange-500/5">
          <div className="flex items-center gap-2 mb-2">
            <Scan className="h-4 w-4 text-orange-500" />
            <span className="text-sm font-medium text-orange-600">Detetadas</span>
            <Badge variant="outline" className="ml-auto text-[10px] border-orange-500/30 text-orange-600">
              {activeCandidates.length}
            </Badge>
          </div>
          <p className="text-[10px] text-muted-foreground mb-2">
            Aberturas detetadas automaticamente. Clique "Criar" para converter.
          </p>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {activeCandidates.map(candidate => (
              <div 
                key={candidate.id}
                className="flex items-center justify-between p-2 rounded bg-orange-500/10 border border-orange-500/20 text-xs"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] px-1 font-mono border-orange-500/30">
                    {candidate.label}
                  </Badge>
                  <span className="font-mono text-orange-700">
                    {Math.round(candidate.widthMm)}mm
                  </span>
                  <span className="text-muted-foreground">
                    Cadeia {getChainForCandidate(candidate)} @ {Math.round(candidate.startDistMm)}mm
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-orange-600 hover:text-orange-700 hover:bg-orange-500/20"
                  onClick={() => handleCreateFromCandidate(candidate)}
                >
                  <Zap className="h-3 w-3 mr-1" />
                  Criar
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Openings list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {openings.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <LayoutGrid className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">Sem aberturas</p>
              <p className="text-xs opacity-70">Adicione portas ou janelas</p>
            </div>
          ) : (
            openings.map(opening => {
              const { rowsAffected } = getAffectedRows(opening.sillMm, opening.heightMm);
              const { units: toposUnits } = calculateOpeningTopos(opening);
              const isDoor = opening.kind === 'door';
              
              return (
                <div 
                  key={opening.id}
                  className={`p-2 rounded-md border text-xs ${
                    isDoor ? 'border-orange-500/30 bg-orange-500/5' : 'border-blue-500/30 bg-blue-500/5'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={isDoor ? 'default' : 'secondary'} className="text-[10px] px-1.5">
                        {opening.label}
                      </Badge>
                      <span className="font-mono">
                        {opening.widthMm}×{opening.heightMm}
                      </span>
                    </div>
                    <div className="flex gap-1">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-5 w-5 opacity-50 hover:opacity-100"
                        onClick={() => onDeleteOpening(opening.id)}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>{getChainLabel(opening.chainId)} @ {opening.offsetMm}mm</span>
                    <span>{rowsAffected} fiadas • {toposUnits} topos</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Summary */}
      {openings.length > 0 && (
        <div className="p-3 border-t border-border bg-muted/30">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Total Topos (aberturas)</span>
            <span className="font-mono font-medium">
              {openings.reduce((sum, o) => sum + calculateOpeningTopos(o).units, 0)} un
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
