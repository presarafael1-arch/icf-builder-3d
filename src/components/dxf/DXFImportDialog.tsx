import { useState, useRef } from 'react';
import { Upload, Layers, Check, FileText, AlertCircle, Info, Ruler, GitMerge, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  parseDXF, 
  processDXF,
  formatLength,
  DXFSegment, 
  DXFParseResult,
  NormalizedDXFResult
} from '@/lib/dxf-parser';

interface DXFImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (segments: DXFSegment[], selectedLayers: string[], stats: NormalizedDXFResult['stats']) => void;
}

type ImportStep = 'upload' | 'layers' | 'preview';

export function DXFImportDialog({ open, onOpenChange, onImport }: DXFImportDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<ImportStep>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<DXFParseResult | null>(null);
  const [processedResult, setProcessedResult] = useState<NormalizedDXFResult | null>(null);
  const [selectedLayers, setSelectedLayers] = useState<string[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<'mm' | 'm'>('m');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setStep('upload');
    setFile(null);
    setParseResult(null);
    setProcessedResult(null);
    setSelectedLayers([]);
    setSelectedUnit('m');
    setError(null);
    setLoading(false);
  };

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (!selectedFile.name.toLowerCase().endsWith('.dxf')) {
      setError('Por favor selecione um ficheiro DXF válido.');
      return;
    }

    setFile(selectedFile);
    setError(null);
    setLoading(true);

    try {
      const content = await selectedFile.text();
      const result = parseDXF(content);

      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }

      setParseResult(result);
      setSelectedLayers(result.layers);
      setSelectedUnit(result.suggestedUnit);
      setStep('layers');
    } catch (err) {
      console.error('Error reading file:', err);
      setError('Erro ao ler o ficheiro. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleLayerToggle = (layer: string, checked: boolean) => {
    if (checked) {
      setSelectedLayers([...selectedLayers, layer]);
    } else {
      setSelectedLayers(selectedLayers.filter(l => l !== layer));
    }
  };

  const handleSelectAll = () => {
    if (parseResult) setSelectedLayers([...parseResult.layers]);
  };

  const handleDeselectAll = () => {
    setSelectedLayers([]);
  };

  const handleProcessAndPreview = () => {
    if (!parseResult || selectedLayers.length === 0) return;
    
    setLoading(true);
    
    try {
      // Run the full normalization pipeline
      const result = processDXF(parseResult, selectedLayers, selectedUnit);
      setProcessedResult(result);
      setStep('preview');
    } catch (err) {
      console.error('Error processing DXF:', err);
      setError('Erro ao processar o DXF. Verifique o ficheiro.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = () => {
    if (!processedResult) return;
    
    onImport(
      processedResult.finalSegments, 
      selectedLayers, 
      processedResult.stats
    );
    handleClose();
  };

  const bbox = parseResult?.boundingBox;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            Importar DXF
          </DialogTitle>
          <DialogDescription>
            {step === 'upload' && 'Carregue um ficheiro DXF para importar paredes.'}
            {step === 'layers' && 'Selecione as layers e confirme a unidade.'}
            {step === 'preview' && 'Verifique o resultado da normalização.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {step === 'upload' && (
          <div className="space-y-4">
            <div
              className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".dxf"
                onChange={handleFileSelect}
                className="hidden"
              />
              <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mb-2">
                Clique para selecionar ou arraste um ficheiro DXF
              </p>
              <p className="text-xs text-muted-foreground">
                Suporta entidades LINE, LWPOLYLINE e POLYLINE
              </p>
            </div>

            {loading && (
              <div className="text-center text-sm text-muted-foreground animate-pulse">
                A processar ficheiro...
              </div>
            )}
          </div>
        )}

        {step === 'layers' && parseResult && (
          <div className="space-y-4">
            {/* Unit selector */}
            <div className="space-y-2 p-3 bg-muted/30 rounded-md">
              <div className="flex items-center gap-2">
                <Ruler className="h-4 w-4 text-primary" />
                <Label className="font-medium">Unidade do DXF</Label>
              </div>
              
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                <Info className="h-3 w-3" />
                <span>
                  Auto-deteção: provavelmente em <strong>{parseResult.suggestedUnit === 'm' ? 'metros' : 'milímetros'}</strong>
                  {bbox && ` (bbox: ${bbox.width.toFixed(1)} × ${bbox.height.toFixed(1)})`}
                </span>
              </div>
              
              <RadioGroup
                value={selectedUnit}
                onValueChange={(v) => setSelectedUnit(v as 'mm' | 'm')}
                className="flex gap-4"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="mm" id="unit-mm" />
                  <Label htmlFor="unit-mm" className="cursor-pointer">
                    Milímetros (mm)
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="m" id="unit-m" />
                  <Label htmlFor="unit-m" className="cursor-pointer">
                    Metros (m) → ×1000
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {/* Layers */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-2">
                  <Layers className="h-4 w-4" />
                  {parseResult.layers.length} layers encontradas
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={handleSelectAll}>
                    Todas
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleDeselectAll}>
                    Nenhuma
                  </Button>
                </div>
              </div>

              <ScrollArea className="h-[180px] border rounded-md p-3">
                <div className="space-y-2">
                  {parseResult.layers.map((layer) => (
                    <div key={layer} className="flex items-center space-x-2">
                      <Checkbox
                        id={`layer-${layer}`}
                        checked={selectedLayers.includes(layer)}
                        onCheckedChange={(checked) => handleLayerToggle(layer, checked === true)}
                      />
                      <Label
                        htmlFor={`layer-${layer}`}
                        className="flex-1 cursor-pointer text-sm font-mono truncate"
                      >
                        {layer}
                      </Label>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {parseResult.layerCounts[layer] || 0} segs
                      </span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>

            {/* Quick summary */}
            <div className="p-3 bg-muted/30 rounded-md">
              <div className="flex items-center justify-between text-sm">
                <span>Segmentos selecionados:</span>
                <span className="font-bold">
                  {selectedLayers.reduce((sum, layer) => sum + (parseResult.layerCounts[layer] || 0), 0)}
                </span>
              </div>
            </div>
          </div>
        )}

        {step === 'preview' && processedResult && (
          <div className="space-y-4">
            {/* Normalization pipeline visualization */}
            <div className="space-y-3">
              <div className="text-sm font-medium flex items-center gap-2">
                <GitMerge className="h-4 w-4 text-primary" />
                Pipeline de Normalização
              </div>
              
              {/* Pipeline steps */}
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between p-2 bg-muted/30 rounded">
                  <span className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs">1</span>
                    Segmentos originais
                  </span>
                  <span className="font-mono">{processedResult.stats.originalSegments}</span>
                </div>
                
                <div className="flex items-center justify-between p-2 bg-muted/30 rounded">
                  <span className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs">2</span>
                    Após filtro de layers
                  </span>
                  <span className="font-mono">{processedResult.stats.afterLayerFilter}</span>
                </div>
                
                <div className="flex items-center justify-between p-2 bg-orange-500/10 rounded">
                  <span className="flex items-center gap-2 text-orange-600">
                    <Trash2 className="h-4 w-4" />
                    Ruído removido (&lt;50mm, duplicados)
                  </span>
                  <span className="font-mono text-orange-600">−{processedResult.stats.removedNoise}</span>
                </div>
                
                <div className="flex items-center justify-between p-2 bg-green-500/10 rounded">
                  <span className="flex items-center gap-2 text-green-600">
                    <GitMerge className="h-4 w-4" />
                    Segmentos fundidos (colineares)
                  </span>
                  <span className="font-mono text-green-600">
                    {processedResult.stats.mergedSegments > 0 ? `−${processedResult.stats.mergedSegments}` : '0'}
                  </span>
                </div>
                
                <div className="flex items-center justify-between p-2 bg-primary/10 border border-primary/20 rounded font-medium">
                  <span className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-primary" />
                    Paredes finais
                  </span>
                  <span className="font-mono text-primary">{processedResult.stats.finalWalls}</span>
                </div>
              </div>
            </div>

            {/* Topology detection */}
            <div className="p-3 bg-muted/30 rounded-md space-y-2">
              <div className="text-sm font-medium">Topologia Detetada</div>
              <div className="grid grid-cols-4 gap-2 text-center text-sm">
                <div className="p-2 bg-background rounded">
                  <div className="font-bold text-lg">{processedResult.stats.junctionCounts.L}</div>
                  <div className="text-xs text-muted-foreground">Cantos L</div>
                </div>
                <div className="p-2 bg-background rounded">
                  <div className="font-bold text-lg">{processedResult.stats.junctionCounts.T}</div>
                  <div className="text-xs text-muted-foreground">Nós T</div>
                </div>
                <div className="p-2 bg-background rounded">
                  <div className="font-bold text-lg">{processedResult.stats.junctionCounts.X}</div>
                  <div className="text-xs text-muted-foreground">Nós X</div>
                </div>
                <div className="p-2 bg-background rounded">
                  <div className="font-bold text-lg">{processedResult.stats.junctionCounts.end}</div>
                  <div className="text-xs text-muted-foreground">Fins</div>
                </div>
              </div>
            </div>

            {/* Total length */}
            <div className="p-3 bg-primary/10 border border-primary/20 rounded-md">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Comprimento Total</span>
                <span className="text-lg font-bold text-primary">
                  {formatLength(processedResult.stats.totalLengthMM)}
                </span>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === 'upload' && (
            <Button variant="outline" onClick={handleClose}>
              Cancelar
            </Button>
          )}

          {step === 'layers' && (
            <>
              <Button variant="outline" onClick={() => setStep('upload')}>
                Voltar
              </Button>
              <Button
                onClick={handleProcessAndPreview}
                disabled={selectedLayers.length === 0 || loading}
                className="gap-2"
              >
                {loading ? 'A processar...' : 'Processar DXF'}
              </Button>
            </>
          )}

          {step === 'preview' && (
            <>
              <Button variant="outline" onClick={() => setStep('layers')}>
                Voltar
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={!processedResult || processedResult.stats.finalWalls === 0}
                className="gap-2"
              >
                <Check className="h-4 w-4" />
                Importar {processedResult?.stats.finalWalls} paredes
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
