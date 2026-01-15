// Discrete Rebar Spacing Selector for OMNI ICF
// Only 3 options: 10cm, 15cm, 20cm (no slider/free input)

import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { RebarSpacing } from '@/types/icf';

interface RebarSpacingSelectorProps {
  value: RebarSpacing;
  onChange: (value: RebarSpacing) => void;
  className?: string;
}

const SPACING_OPTIONS: { value: RebarSpacing; label: string; description: string; webs: number }[] = [
  { value: 20, label: '20 cm', description: 'Standard', webs: 2 },
  { value: 15, label: '15 cm', description: '+1 web extra', webs: 3 },
  { value: 10, label: '10 cm', description: '+2 webs extra', webs: 4 },
];

export function RebarSpacingSelector({ value, onChange, className }: RebarSpacingSelectorProps) {
  return (
    <div className={className}>
      <Label className="text-sm font-medium mb-3 block">Espaçamento dos Ferros</Label>
      <RadioGroup
        value={String(value)}
        onValueChange={(v) => onChange(Number(v) as RebarSpacing)}
        className="grid grid-cols-3 gap-2"
      >
        {SPACING_OPTIONS.map((option) => (
          <div key={option.value} className="relative">
            <RadioGroupItem
              value={String(option.value)}
              id={`spacing-${option.value}`}
              className="peer sr-only"
            />
            <Label
              htmlFor={`spacing-${option.value}`}
              className="flex flex-col items-center justify-center rounded-lg border-2 border-muted bg-popover p-3 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary/5 cursor-pointer transition-all"
            >
              <span className="text-lg font-bold">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
              <span className="text-xs text-primary font-mono mt-1">{option.webs} webs/painel</span>
            </Label>
          </div>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground mt-2">
        20cm é o standard. Menor espaçamento = mais webs = estrutura mais reforçada.
      </p>
    </div>
  );
}
