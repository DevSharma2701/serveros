import { Plus } from 'lucide-react';
import { Button, Input, Select, cn } from '@/components/ui';
import { IconButton, InlineError } from '../catalogue/common';
import { errorAt } from '../catalogue/forms';
import { Trash2 } from 'lucide-react';
import type { StockLookups } from './queries';

/** One editable line: an ingredient, how much of it, in which unit and (for purchasing) at what cost. */
export interface Line {
  ingredientId: string;
  quantity: string;
  unitId: string;
  /** Typed rupees per unit. Only used when `withCost` is set. */
  unitCostMinor?: string;
}

export const emptyLine = (withCost = false): Line => ({ ingredientId: '', quantity: '', unitId: '', ...(withCost ? { unitCostMinor: '' } : {}) });

/**
 * Editable list of ingredient lines, used by transfers, recipes, purchase orders and direct receipts.
 * Controlled: the parent form owns the lines (react-hook-form `Controller`) and passes that field's errors.
 */
export function LinesEditor({ value, onChange, errors, lookups, withCost, addLabel = 'Add line', quantityLabel = 'Quantity' }: {
  value: Line[];
  onChange: (lines: Line[]) => void;
  /** The errors object of the lines field: `{ 0: { quantity: { message } }, root: { message } }`. */
  errors?: unknown;
  lookups: StockLookups;
  withCost?: boolean;
  addLabel?: string;
  quantityLabel?: string;
}) {
  const ingredients = (lookups.ingredients.data ?? []).filter((i) => i.isActive || value.some((l) => l.ingredientId === i.id));
  const update = (index: number, patch: Partial<Line>) => onChange(value.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const chooseIngredient = (index: number, ingredientId: string) => {
    // Start in the unit stock is kept in; the person can pick another unit of the same kind.
    update(index, { ingredientId, unitId: lookups.ingredientById.get(ingredientId)?.baseUnitId ?? '' });
  };

  return (
    <div className="flex flex-col gap-3">
      <InlineError message={errorAt(errors, 'root') ?? errorAt(errors)} />
      {value.length === 0 ? <p className="text-sm text-ink-faint">No lines yet.</p> : null}
      <ul className="flex flex-col gap-2">
        {value.map((line, i) => {
          const n = i + 1;
          const problems = [errorAt(errors, i, 'ingredientId'), errorAt(errors, i, 'quantity'), errorAt(errors, i, 'unitId'), errorAt(errors, i, 'unitCostMinor')];
          const describedBy = problems.some(Boolean) ? `line-${n}-errors` : undefined;
          return (
            <li key={i} className="rounded-control border border-line bg-sunken/40 p-2">
              <div className={cn('grid grid-cols-2 gap-2', withCost ? 'sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]' : 'sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]')}>
                <Select aria-label={`Ingredient, line ${n}`} aria-invalid={problems[0] ? true : undefined} aria-describedby={describedBy} className="col-span-2 sm:col-span-1" value={line.ingredientId} onChange={(e) => chooseIngredient(i, e.target.value)}>
                  <option value="">Choose ingredient</option>
                  {ingredients.map((ing) => (
                    <option key={ing.id} value={ing.id}>
                      {ing.name}
                    </option>
                  ))}
                </Select>
                <Input aria-label={`${quantityLabel}, line ${n}`} aria-invalid={problems[1] ? true : undefined} aria-describedby={describedBy} inputMode="decimal" autoComplete="off" placeholder={quantityLabel} className="tabular text-right" value={line.quantity} onChange={(e) => update(i, { quantity: e.target.value })} />
                <Select aria-label={`Unit, line ${n}`} aria-invalid={problems[2] ? true : undefined} aria-describedby={describedBy} value={line.unitId} disabled={!line.ingredientId} onChange={(e) => update(i, { unitId: e.target.value })}>
                  {line.ingredientId ? null : <option value="">Unit</option>}
                  {lookups.unitsFor(line.ingredientId).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code}
                    </option>
                  ))}
                </Select>
                {withCost ? (
                  <Input aria-label={`Cost per unit in rupees, line ${n}`} aria-invalid={problems[3] ? true : undefined} aria-describedby={describedBy} inputMode="decimal" autoComplete="off" placeholder="Cost / unit (₹)" className="tabular text-right" value={line.unitCostMinor ?? ''} onChange={(e) => update(i, { unitCostMinor: e.target.value })} />
                ) : null}
                <div className={cn('flex justify-end', withCost ? '' : 'col-span-2 sm:col-span-1')}>
                  <IconButton label={`Remove line ${n}`} onClick={() => onChange(value.filter((_, index) => index !== i))} className="hover:text-bad">
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </IconButton>
                </div>
              </div>
              {describedBy ? (
                <p id={describedBy} role="alert" className="mt-1 text-sm text-bad">
                  {[problems[0] && `Ingredient: ${problems[0]}`, problems[1] && `Quantity: ${problems[1]}`, problems[2] && `Unit: ${problems[2]}`, problems[3] && `Cost: ${problems[3]}`].filter(Boolean).join(' · ')}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div>
        <Button size="sm" onClick={() => onChange([...value, emptyLine(withCost)])}>
          <Plus className="h-4 w-4" aria-hidden />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}
