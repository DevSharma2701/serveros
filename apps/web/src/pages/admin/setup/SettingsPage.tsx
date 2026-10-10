import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Card, Checkbox, ErrorState, Field, Input, Notice, PageHeader, Select, SkeletonRows, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { percent } from '@/lib/format';
import { settingsFormSchema, toForm, toPatch, type RestaurantPatch, type SettingsForm } from './settingsForm';
import type { Restaurant, TaxCategory } from './types';

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card className="p-4 sm:p-5">
      <section aria-labelledby={id} className="grid gap-4 lg:grid-cols-[16rem_1fr] lg:gap-8">
        <div>
          <h2 id={id} className="text-base font-semibold text-ink">
            {title}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{description}</p>
        </div>
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
      </section>
    </Card>
  );
}

const INVENTORY_POLICIES: Array<{ value: Restaurant['inventoryPolicy']; label: string; explanation: string }> = [
  { value: 'NONE', label: 'Do not deduct stock', explanation: 'Sales never change stock levels. Use this if you do not track ingredients.' },
  { value: 'ON_CONFIRM', label: 'Deduct when the order is confirmed', explanation: 'Ingredients leave stock as soon as an order is sent to the kitchen.' },
  { value: 'ON_COMPLETE', label: 'Deduct when the order is completed', explanation: 'Ingredients leave stock only once the order is finished and closed.' },
];

function SettingsFormView({ restaurant, taxCategories, taxError }: { restaurant: Restaurant; taxCategories: TaxCategory[]; taxError: string | null }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const form = useForm<SettingsForm>({ resolver: zodResolver(settingsFormSchema), defaultValues: toForm(restaurant) });
  const { errors, isDirty } = form.formState;
  const { reset, register } = form;
  // After a save (or a refetch) the form starts again from what the server holds.
  useEffect(() => reset(toForm(restaurant)), [restaurant, reset]);

  const save = useMutation({
    mutationFn: (patch: RestaurantPatch) => api<Restaurant>('/restaurant', { method: 'PATCH', body: patch }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['restaurant'], saved);
      // The till prices orders from the catalogue, which embeds these billing rules.
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      notify('Settings saved');
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });

  const submit = form.handleSubmit((values) => {
    const patch = toPatch(values, restaurant);
    if (Object.keys(patch).length === 0) return reset(toForm(restaurant));
    save.mutate(patch);
  });

  const taxOptions = (currentId: string | null) => (
    <>
      <option value="">No tax</option>
      {/* Keep the saved choice selectable even if the list could not be loaded, so saving never clears it by accident. */}
      {currentId && !taxCategories.some((t) => t.id === currentId) ? <option value={currentId}>Current tax category</option> : null}
      {taxCategories
        .filter((t) => t.isActive || t.id === currentId)
        .map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.rules.length ? ` (${t.rules.filter((r) => r.isActive).map((r) => `${r.name.replace(/\s*\d+(\.\d+)?%$/, '')} ${percent(r.rateBps)}`).join(', ')})` : ''}
          </option>
        ))}
    </>
  );
  const policy = form.watch('inventoryPolicy');
  const loyaltyOn = form.watch('loyaltyEnabled');
  const currency = restaurant.currency;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 pb-24">
      <Section title="Business details" description="Printed on bills and tax invoices.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Restaurant name" error={errors.name?.message}>
            {(p) => <Input {...p} {...register('name')} />}
          </Field>
          <Field label="Legal name" error={errors.legalName?.message} hint="The registered business name.">
            {(p) => <Input {...p} {...register('legalName')} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="GSTIN" error={errors.gstin?.message} hint="Leave empty if not registered for GST.">
            {(p) => <Input {...p} autoCapitalize="characters" {...register('gstin')} />}
          </Field>
          <Field label="State code" error={errors.stateCode?.message} hint="GST state code of the business, e.g. 29.">
            {(p) => <Input {...p} maxLength={4} {...register('stateCode')} />}
          </Field>
        </div>
        <Field label="Address" error={errors.addressLine1?.message}>
          {(p) => <Input {...p} {...register('addressLine1')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="City" error={errors.city?.message}>
            {(p) => <Input {...p} {...register('city')} />}
          </Field>
          <Field label="Postal code" error={errors.postalCode?.message}>
            {(p) => <Input {...p} {...register('postalCode')} />}
          </Field>
        </div>
      </Section>

      <Section title="Billing rules" description="How every bill is calculated, in all outlets.">
        <Notice tone="warn" title="Check tax settings with a tax professional">
          These are configuration choices, not tax advice. ServeOS applies exactly what is set here; confirm the rates and rules with your accountant before changing them.
        </Notice>
        <div>
          <Checkbox label="Menu prices already include tax" {...register('pricesIncludeTax')} />
          <p className="pl-8 text-sm text-ink-faint">When ticked, tax is worked out from within the menu price. When not, tax is added on top.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Service charge (%)" error={errors.serviceChargePercent?.message} hint="Applied to dine-in orders in outlets that have it switched on. 0 for none.">
            {(p) => <Input {...p} inputMode="decimal" {...register('serviceChargePercent')} />}
          </Field>
          <Field label="Tax on service charge" error={taxError ?? undefined}>
            {(p) => (
              <Select {...p} {...register('serviceChargeTaxCategoryId')}>
                {taxOptions(restaurant.serviceChargeTaxCategoryId)}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tax on delivery charge" error={taxError ?? undefined} hint="The delivery charge itself is set per outlet.">
            {(p) => (
              <Select {...p} {...register('deliveryChargeTaxCategoryId')}>
                {taxOptions(restaurant.deliveryChargeTaxCategoryId)}
              </Select>
            )}
          </Field>
          <Field label="Round-off" error={errors.roundOffMode?.message} hint="The difference is shown on the bill as round-off.">
            {(p) => (
              <Select {...p} {...register('roundOffMode')}>
                <option value="NONE">Do not round bill totals</option>
                <option value="NEAREST_UNIT">Round the total to the nearest whole {currency === 'INR' ? 'rupee' : 'unit'}</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="Receipt footer" error={errors.receiptFooter?.message} hint="Printed at the bottom of every receipt. Up to 500 characters.">
          {(p) => <Textarea {...p} maxLength={500} {...register('receiptFooter')} />}
        </Field>
      </Section>

      <Section title="Controls" description="Limits that need a manager's approval.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Discount approval threshold (%)" error={errors.discountApprovalPercent?.message} hint="Discounts above this need someone allowed to approve high discounts.">
            {(p) => <Input {...p} inputMode="decimal" {...register('discountApprovalPercent')} />}
          </Field>
          <Field label={`Cash variance approval threshold (${currency})`} error={errors.cashVarianceThreshold?.message} hint="A shift that closes short or over by more than this needs approval.">
            {(p) => <Input {...p} inputMode="decimal" {...register('cashVarianceThreshold')} />}
          </Field>
        </div>
        <div>
          <Checkbox label="Allow partial payment" {...register('allowPartialPayment')} />
          <p className="pl-8 text-sm text-ink-faint">When ticked, a bill can be part-paid and settled later. When not, payments must cover the whole bill.</p>
        </div>
      </Section>

      <Section title="Inventory" description="When selling a dish takes its ingredients out of stock.">
        <Field label="Stock deduction" error={errors.inventoryPolicy?.message} hint={INVENTORY_POLICIES.find((o) => o.value === policy)?.explanation}>
          {(p) => (
            <Select {...p} {...register('inventoryPolicy')}>
              {INVENTORY_POLICIES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ul className="flex flex-col gap-1 text-sm text-ink-soft">
          {INVENTORY_POLICIES.map((o) => (
            <li key={o.value}>
              <span className="font-medium text-ink">{o.label}:</span> {o.explanation}
            </li>
          ))}
        </ul>
        <div>
          <Checkbox label="Allow negative stock" {...register('allowNegativeStock')} />
          <p className="pl-8 text-sm text-ink-faint">When ticked, a sale goes through even if stock would fall below zero. When not, the order is refused.</p>
        </div>
      </Section>

      <Section title="Loyalty" description="Points customers earn and spend.">
        <Checkbox label="Loyalty programme is on" {...register('loyaltyEnabled')} />
        {!loyaltyOn ? <p className="text-sm text-ink-faint">While off, no points are earned. The values below are kept for when it is switched on again.</p> : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={`Points per ${currency === 'INR' ? '₹100' : '100'} spent`} error={errors.loyaltyEarnPointsPer100?.message}>
            {(p) => <Input {...p} inputMode="numeric" {...register('loyaltyEarnPointsPer100')} />}
          </Field>
          <Field label={`Value of one point (${currency})`} error={errors.loyaltyPointValue?.message} hint="What a point is worth when redeemed.">
            {(p) => <Input {...p} inputMode="decimal" {...register('loyaltyPointValue')} />}
          </Field>
          <Field label="Minimum points to redeem" error={errors.loyaltyMinRedeemPoints?.message}>
            {(p) => <Input {...p} inputMode="numeric" {...register('loyaltyMinRedeemPoints')} />}
          </Field>
        </div>
      </Section>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-canvas/95 px-4 py-3 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
        <p className="mr-auto text-sm text-ink-soft" role="status">
          {Object.keys(errors).length ? 'Some fields need attention.' : isDirty ? 'You have unsaved changes.' : 'All changes saved.'}
        </p>
        <Button disabled={!isDirty || save.isPending} onClick={() => reset(toForm(restaurant))}>
          Discard
        </Button>
        <Button type="submit" variant="primary" disabled={!isDirty} loading={save.isPending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const restaurant = useQuery({ queryKey: ['restaurant'], queryFn: () => api<Restaurant>('/restaurant') });
  const taxes = useQuery({ queryKey: ['restaurant', 'tax-categories'], queryFn: () => api<TaxCategory[]>('/tax-categories') });
  return (
    <div>
      <PageHeader title="Settings" description="Business details and the rules that apply to every outlet." />
      {restaurant.isError && !restaurant.data ? (
        <Card>
          <ErrorState message={errorMessage(restaurant.error)} onRetry={() => void restaurant.refetch()} />
        </Card>
      ) : !restaurant.data || taxes.isLoading ? (
        <Card>
          <SkeletonRows rows={8} />
        </Card>
      ) : (
        <SettingsFormView restaurant={restaurant.data} taxCategories={taxes.data ?? []} taxError={taxes.isError ? `Could not load tax categories: ${errorMessage(taxes.error)}` : null} />
      )}
    </div>
  );
}
