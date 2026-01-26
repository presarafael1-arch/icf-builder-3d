
## Plano: Materiais Sólidos (Sem Transparência)

### Problema Atual

O código tem transparência em múltiplos lugares:

| Componente | Linha | Atual | Problema |
|------------|-------|-------|----------|
| `PanelSkin` | 390-391 | `transparent: true, opacity: 0.9` | Cor base semi-transparente |
| `PanelStripe` | 493-494 | `transparent: true, opacity: 0.8` | Overlay semi-transparente |
| `WallFallback` stripes | 807-808, 835-836, 869-870, 897-898 | `transparent: true, opacity: 0.8` | Stripes semi-transparentes |

### Solução

Remover todas as transparências e tornar tudo **100% sólido**:

---

### Alterações no ficheiro `src/components/viewer/ExternalEngineRenderer.tsx`

#### 1. Remover constante `STRIPE_OPACITY` (linha 93)

```typescript
// ANTES
const STRIPE_OPACITY = 0.8;       // 80% opacity

// DEPOIS
// (remover esta linha - não será mais usada)
```

#### 2. `PanelSkin` - Material base sólido (linhas 387-392)

```typescript
// ANTES
<meshStandardMaterial
  color={displayColor}
  side={THREE.DoubleSide}
  transparent
  opacity={0.9}
/>

// DEPOIS
<meshStandardMaterial
  color={displayColor}
  side={THREE.DoubleSide}
/>
```

#### 3. `PanelStripe` - Overlay sólido (linhas 491-500)

```typescript
// ANTES
<meshBasicMaterial
  color={color}
  transparent
  opacity={STRIPE_OPACITY}
  side={THREE.DoubleSide}
  depthTest={false}
  depthWrite={false}
  polygonOffset
  polygonOffsetFactor={-1}
  polygonOffsetUnits={-1}
/>

// DEPOIS
<meshBasicMaterial
  color={color}
  side={THREE.DoubleSide}
  depthTest={false}
  depthWrite={false}
  polygonOffset
  polygonOffsetFactor={-1}
  polygonOffsetUnits={-1}
/>
```

#### 4. `WallFallback` - Stripes sólidos (4 locais: linhas 805-814, 833-842, 866-875, 894-903)

Cada um dos 4 stripes precisa da mesma alteração:

```typescript
// ANTES
<meshBasicMaterial
  color={leftStripeColor}  // ou rightStripeColor
  transparent
  opacity={STRIPE_OPACITY}
  side={THREE.DoubleSide}
  depthWrite={false}
  polygonOffset
  polygonOffsetFactor={-1}
  polygonOffsetUnits={-1}
/>

// DEPOIS
<meshBasicMaterial
  color={leftStripeColor}  // ou rightStripeColor
  side={THREE.DoubleSide}
  depthWrite={false}
  polygonOffset
  polygonOffsetFactor={-1}
  polygonOffsetUnits={-1}
/>
```

---

### Resumo das Alterações

| Local | O que muda |
|-------|-----------|
| Linha 93 | Remover `STRIPE_OPACITY` |
| Linha 387-392 (`PanelSkin`) | Remover `transparent` e `opacity` |
| Linha 491-500 (`PanelStripe`) | Remover `transparent` e `opacity` |
| Linha 805-814 (`WallFallback` left-front) | Remover `transparent` e `opacity` |
| Linha 833-842 (`WallFallback` left-back) | Remover `transparent` e `opacity` |
| Linha 866-875 (`WallFallback` right-front) | Remover `transparent` e `opacity` |
| Linha 894-903 (`WallFallback` right-back) | Remover `transparent` e `opacity` |

---

### Resultado Visual Esperado

```text
┌─────────────────────────────────────────────────┐
│                                                 │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐               │
│  │█████│ │█████│ │█████│ │█████│  ← AMARELO    │
│  │█████│ │█████│ │█████│ │█████│    SÓLIDO     │
│  │ ██ ██│ │ ██ ██│ │ ██ ██│ │ ██ ██│  ← AZUL    │
│  │ ██ ██│ │ ██ ██│ │ ██ ██│ │ ██ ██│    SÓLIDO  │
│  └─────┘ └─────┘ └─────┘ └─────┘               │
│                                                 │
│  Parede EXTERIOR:                              │
│  - Base: Amarelo/Vermelho 100% opaco           │
│  - Overlay lado de fora: AZUL 100% opaco       │
│  - Overlay lado de dentro: BRANCO 100% opaco   │
│                                                 │
│  Parede INTERIOR:                              │
│  - Base: Amarelo/Vermelho 100% opaco           │
│  - Overlay ambos lados: BRANCO 100% opaco      │
│                                                 │
└─────────────────────────────────────────────────┘
```

Sem qualquer transparência - tudo completamente sólido.
