import { useState, useRef } from 'react';
import { Upload, Layers, Check, FileText, AlertCircle, Info, Ruler } from 'lucide-react';
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
  filterSegmentsByLayers, 
  convertSegmentsToMM,
  calculateTotalLength,
  formatLength,
  DXFSegment, 
  DXFParseResult 
} from '@/lib/dxf-parser';

interface DXFImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (segments: DXFSegment[], selectedLayers: string[], totalLengthMM: number) => void;
}

type ImportStep = 'upload' | 'layers';

export function DXFImportDialog({ open, onOpenChange, onImport }: DXFImportDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<ImportStep>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<DXFParseResult | null>(null);
  const [selectedLayers, setSelectedLayers] = useState<string[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<'mm' | 'm'>('m');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setStep('upload');
    setFile(null);
    setParseResult(null);
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

  const handleConfirm = () => {
    if (!parseResult) return;
    
    const filteredSegments = filterSegmentsByLayers(parseResult.segments, selectedLayers);
    const segmentsInMM = convertSegmentsToMM(filteredSegments, selectedUnit);
    const totalLength = calculateTotalLength(segmentsInMM);
    
    onImport(segmentsInMM, selectedLayers, totalLength);
    handleClose();
  };

  const filteredSegments = parseResult 
    ? filterSegmentsByLayers(parseResult.segments, selectedLayers)
    : [];
  const filteredCount = filteredSegments.length;
  
  const previewSegmentsInMM = parseResult && filteredSegments.length > 0
    ? convertSegmentsToMM(filteredSegments, selectedUnit)
    : [];
  const previewTotalLength = calculateTotalLength(previewSegmentsInMM);
  
  const bbox = parseResult?.boundingBox;

  // Calculate dimensions of converted segments
  const getConvertedDimensions = () => {
    if (previewSegmentsInMM.length === 0) return { width: 0, height: 0 };
    const allX = previewSegmentsInMM.flatMap(s => [s.startX, s.endX]);
    const allY = previewSegmentsInMM.flatMap(s => [s.startY, s.endY]);
    return {
      width: Math.max(...allX) - Math.min(...allX),
      height: Math.max(...allY) - Math.min(...allY)
    };
  };
  const convertedDims = getConvertedDimensions();

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

            {/* Import summary */}
            <div className="p-3 bg-primary/10 border border-primary/20 rounded-md space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm">Segmentos a importar:</span>
                <span className="text-sm font-bold text-primary">{filteredCount}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">Comprimento total:</span>
                <span className="text-sm font-bold text-primary">
                  {formatLength(previewTotalLength)}
                </span>
              </div>
              {filteredCount > 0 && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Dimensões (em mm):</span>
                  <span>
                    {formatLength(convertedDims.width)} × {formatLength(convertedDims.height)}
                  </span>
                </div>
              )}
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
                onClick={handleConfirm}
                disabled={selectedLayers.length === 0 || filteredCount === 0}
                className="gap-2"
              >
                <Check className="h-4 w-4" />
                Importar {filteredCount} paredes
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}