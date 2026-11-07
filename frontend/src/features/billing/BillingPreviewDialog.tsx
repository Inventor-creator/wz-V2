import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { money } from "../../lib/dates";
import {
  Modal,
  LoadingSkeleton,
  ErrorState,
  DataTable,
  useAction,
} from "../../components/ui";
export function BillingPreviewDialog({ onClose }: { onClose: () => void }) {
  const [key] = useState(() => crypto.randomUUID());
  const preview = useQuery({
    queryKey: ["billing-preview", key],
    queryFn: api.billing.preview,
  });
  const [result, setResult] = useState<number | null>(null);
  const run = useAction(() => api.billing.run(key));
  return (
    <Modal title="Run billing cycle" onClose={onClose}>
      <div className="modal-body">
        {preview.isPending ? (
          <LoadingSkeleton />
        ) : preview.error ? (
          <ErrorState
            error={preview.error}
            retry={() => void preview.refetch()}
          />
        ) : (
          <>
            <p className="notice">
              Expired subscriptions are billed separately at their recorded
              purchase price. No payment is recorded and no subscription is
              extended.
            </p>
            <DataTable
              rows={(preview.data || []).map((c) => ({
                ...c,
                id: c.subscriptionId,
              }))}
              columns={[
                { label: "Fee type", render: (c) => c.feeType },
                { label: "Plan", render: (c) => c.description },
                { label: "Charge", render: (c) => money(c.amount) },
              ]}
            />
            <p>
              {new Set(preview.data?.map((c) => c.memberId)).size} unpaid
              invoices ·{" "}
              <strong>
                {money(preview.data?.reduce((s, c) => s + c.amount, 0) || 0)}
              </strong>
            </p>
          </>
        )}
        {run.error && <ErrorState error={run.error} />}
        {result !== null && (
          <p role="status" className="positive">
            Created {result} unpaid invoices. No payment was collected.
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button
          className="btn primary"
          disabled={run.isPending || result !== null || !preview.data?.length}
          onClick={() =>
            run.mutate(undefined, { onSuccess: (v) => setResult(v as number) })
          }
        >
          {run.isPending ? "Processing…" : "Confirm billing"}
        </button>
      </div>
    </Modal>
  );
}
