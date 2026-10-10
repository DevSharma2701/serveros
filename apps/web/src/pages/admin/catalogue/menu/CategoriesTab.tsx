import { categorySchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { CornerDownRight, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Modal, Select, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ActiveBadge, Loadable, Toolbar } from '../common';
import { payloadResolver, toInt, validatePayload, type Report } from '../forms';
import { useCategories, useInvalidateMenu } from '../queries';
import type { Category } from '../types';

interface CategoryForm {
  name: string;
  parentId: string;
  sortOrder: string;
  isActive: boolean;
}

const toPayload = (values: CategoryForm, report: Report) => ({
  name: values.name,
  parentId: values.parentId || null,
  sortOrder: toInt(values.sortOrder, 'sortOrder', report) ?? 0,
  isActive: values.isActive,
});

function CategoryDialog({ category, categories, onClose }: { category: Category | null; categories: Category[]; onClose: () => void }) {
  const notify = useToast();
  const invalidate = useInvalidateMenu();
  const hasChildren = !!category && categories.some((c) => c.parentId === category.id);
  const form = useForm<CategoryForm>({
    resolver: payloadResolver(categorySchema, toPayload),
    defaultValues: { name: category?.name ?? '', parentId: category?.parentId ?? '', sortOrder: String(category?.sortOrder ?? 0), isActive: category?.isActive ?? true },
  });
  const { errors } = form.formState;
  const save = useMutation({
    mutationFn: (body: unknown) => (category ? api<Category>(`/menu/categories/${category.id}`, { method: 'PATCH', body }) : api<Category>('/menu/categories', { method: 'POST', body })),
    onSuccess: (saved) => {
      invalidate();
      notify(`Category ${saved.name} saved`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(categorySchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <Modal open onClose={onClose} title={category ? `Edit ${category.name}` : 'New category'}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Name" error={errors.name?.message}>
          {(p) => <Input {...p} autoComplete="off" autoFocus {...form.register('name')} />}
        </Field>
        <Field label="Parent category" error={errors.parentId?.message} hint={hasChildren ? 'This category has sub-categories, so it must stay at the top level.' : 'Categories can be nested one level deep.'}>
          {(p) => (
            <Select {...p} disabled={hasChildren} {...form.register('parentId')}>
              <option value="">None (top level)</option>
              {categories
                .filter((c) => !c.parentId && c.id !== category?.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Sort order" error={errors.sortOrder?.message} hint="Lower numbers come first on the POS.">
          {(p) => <Input {...p} inputMode="numeric" className="tabular" {...form.register('sortOrder')} />}
        </Field>
        <Checkbox label="Active (its products are shown on the POS)" {...form.register('isActive')} />
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {category ? 'Save category' : 'Create category'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function CategoriesTab() {
  const { can } = useAuth();
  const canManage = can('menu.manage');
  const categories = useCategories();
  const [editing, setEditing] = useState<Category | 'new' | null>(null);

  // Parents in their order, each followed by its children.
  const ordered = useMemo(() => {
    const all = categories.data ?? [];
    const tops = all.filter((c) => !c.parentId || !all.some((p) => p.id === c.parentId));
    return tops.flatMap((top) => [top, ...all.filter((c) => c.parentId === top.id)]);
  }, [categories.data]);

  const columns: Array<Column<Category>> = [
    {
      key: 'name',
      header: 'Category',
      cell: (c) =>
        c.parentId ? (
          <span className="flex items-center gap-2 pl-4 text-ink">
            <CornerDownRight className="h-4 w-4 shrink-0 text-ink-faint" aria-label="Sub-category of the row above" />
            {c.name}
          </span>
        ) : (
          <span className="font-medium">{c.name}</span>
        ),
    },
    { key: 'sort', header: 'Sort order', align: 'right', cell: (c) => c.sortOrder },
    { key: 'products', header: 'Products', align: 'right', cell: (c) => c._count.products },
    { key: 'status', header: 'Status', cell: (c) => <ActiveBadge active={c.isActive} /> },
  ];

  return (
    <Card>
      {canManage ? (
        <Toolbar className="justify-end">
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New category
          </Button>
        </Toolbar>
      ) : null}
      <Loadable query={categories}>
        {() => (
          <DataTable
            columns={columns}
            rows={ordered}
            rowKey={(c) => c.id}
            onRowClick={canManage ? setEditing : undefined}
            empty={<EmptyState title="No categories yet" description="Categories group products on the POS, for example Starters or Beverages." action={canManage ? <Button variant="primary" onClick={() => setEditing('new')}>New category</Button> : undefined} />}
          />
        )}
      </Loadable>
      {editing && canManage ? <CategoryDialog category={editing === 'new' ? null : editing} categories={categories.data ?? []} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}
