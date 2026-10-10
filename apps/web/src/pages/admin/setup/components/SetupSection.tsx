import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { Badge, Button, Card, Modal, Notice, useToast } from '@/components/ui';
import { errorMessage } from '@/lib/api';

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">Inactive</Badge>;
}

/** A titled block of the outlet set-up page with its own "add" action. */
export function SetupSection({ title, description, action, readOnly, children }: { title: string; description: string; action?: ReactNode; /** True when the user can look but not change. */ readOnly: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <Card className="overflow-hidden">
      <section aria-labelledby={id}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4">
          <div className="min-w-0">
            <h2 id={id} className="text-base font-semibold text-ink">
              {title}
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-ink-soft">{description}</p>
            {readOnly ? <p className="mt-1 text-sm text-ink-faint">You can view this section but not change it.</p> : null}
          </div>
          {action}
        </div>
        {children}
      </section>
    </Card>
  );
}

/** Saves one record, then refreshes the lists that show it and says so. */
export function useSave<TBody, TResult>(request: (body: TBody) => Promise<TResult>, options: { invalidate: string[]; success: (saved: TResult) => string; onDone: () => void }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (saved) => {
      for (const key of options.invalidate) void queryClient.invalidateQueries({ queryKey: [key] });
      notify(options.success(saved));
      options.onDone();
    },
  });
}

/** Modal shell for the small create/edit forms on this page. */
export function FormModal({ open, onClose, title, description, submitLabel, pending, error, onSubmit, children }: { open: boolean; onClose: () => void; title: string; description?: string; submitLabel: string; pending: boolean; error: unknown; onSubmit: (e: React.FormEvent<HTMLFormElement>) => void; children: ReactNode }) {
  const formId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {children}
        {error ? <Notice tone="bad">{errorMessage(error)}</Notice> : null}
      </form>
    </Modal>
  );
}
