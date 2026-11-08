import { Component, useEffect, useRef, useState } from "react";
import type { ReactNode, FormEvent, ErrorInfo } from "react";
import { X, ArrowUpRight } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
export const useWorkspace = () =>
  useQuery({ queryKey: ["workspace"], queryFn: api.snapshot });
export function useAction<T>(
  fn: (v: T) => Promise<unknown>,
  done?: () => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workspace"] });
      done?.();
    },
  });
}
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="actions">{children}</div>
    </div>
  );
}
export function StatCard({
  label,
  value,
  note,
  main = false,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  main?: boolean;
}) {
  return (
    <div className={"metric" + (main ? " main" : "")}>
      <div className="metric-label">
        {label}
        <ArrowUpRight size={16} />
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-meta">{note || "Current workspace"}</div>
    </div>
  );
}
export const FinanceKpiCard = StatCard;
export function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  return (
    <span
      className={
        "badge " +
        (s.includes("expired") || s === "revoked" || s === "failed"
          ? "red"
          : s.includes("partial") ||
              s.includes("unpaid") ||
              s.includes("soon") ||
              s === "pending"
            ? "amber"
            : s.includes("archived") ||
                s.includes("inactive") ||
                [
                  "no plan",
                  "upcoming",
                  "cancelled",
                  "not_issued",
                  "draft",
                  "void",
                ].includes(s)
              ? "neutral"
              : "")
      }
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
export function LoadingSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <div className="skeleton-grid">
        {[1, 2, 3].map((i) => (
          <div className="skeleton" key={i} />
        ))}
      </div>
      <div className="skeleton line" />
    </div>
  );
}
export function EmptyState({
  text = "No records found. Try changing your filters.",
}: {
  text?: string;
}) {
  return (
    <div className="empty">
      <h3>No records to show</h3>
      <p>{text}</p>
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <div className="notice" role="alert">
      <strong>
        {error instanceof Error ? error.message : "Something went wrong."}
      </strong>
      {retry && (
        <button className="btn small" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"modal native-modal" + (className ? " " + className : "")}
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-btn"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ConfirmDialog({
  title,
  description,
  onConfirm,
  onClose,
  pending,
  error,
  confirmLabel = "Confirm",
  danger = false,
}: {
  title: string;
  description: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
  error?: unknown;
  confirmLabel?: string;
  danger?: boolean;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body">
        <p>{description}</p>
        {!!error && <ErrorState error={error} />}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className={danger ? "btn danger" : "btn primary"}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Saving…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
export function Field({
  label,
  children,
  error,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  error?: string;
  wide?: boolean;
}) {
  return (
    <label className={"field" + (wide ? " wide" : "")}>
      <span>{label}</span>
      {children}
      {error && (
        <small role="alert" className="field-error">
          {error}
        </small>
      )}
    </label>
  );
}
export function FormLayout({
  children,
  onSubmit,
  pending,
  error,
  onClose,
}: {
  children: ReactNode;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  error: unknown;
  onClose: () => void;
}) {
  return (
    <form onSubmit={onSubmit}>
      <div className="modal-body">
        <div className="form-grid">{children}</div>
        {!!error && <ErrorState error={error} />}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
export interface Column<T> {
  label: string;
  render: (row: T, index: number) => ReactNode;
}
export function DataTable<T extends { id: string }>({
  rows,
  columns,
  pageSize = 8,
  pagination,
}: {
  rows: T[];
  columns: Column<T>[];
  pageSize?: number;
  pagination?: {
    page: number;
    total: number;
    onChange: (page: number) => void;
  };
}) {
  const [page, setPage] = useState(1);
  const total = pagination?.total ?? rows.length;
  const max = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pagination?.page ?? page, max);
  const changePage = pagination?.onChange ?? setPage;
  return (
    <div className="panel">
      <div className="table-wrap mobile-cards">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.label}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(pagination
              ? rows
              : rows.slice((current - 1) * pageSize, current * pageSize)
            ).map((r, i) => (
              <tr key={r.id}>
                {columns.map((c) => (
                  <td key={c.label} data-label={c.label}>
                    {c.render(r, (current - 1) * pageSize + i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <EmptyState />}
      </div>
      <div className="pagination">
        <span>
          {total} records · Page {current} of {max}
        </span>
        <div className="actions">
          <button
            aria-label="Previous page"
            disabled={current === 1}
            onClick={() => changePage(current - 1)}
          >
            ‹
          </button>
          <button
            aria-label="Next page"
            disabled={current === max}
            onClick={() => changePage(current + 1)}
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}
export function Person({ name, email }: { name: string; email?: string }) {
  return (
    <div className="person">
      <span className="avatar soft">
        {name
          .split(" ")
          .map((s) => s[0])
          .slice(0, 2)
          .join("")}
      </span>
      <div>
        <strong>{name}</strong>
        {email && <small>{email}</small>}
      </div>
    </div>
  );
}
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info);
  }
  render() {
    return this.state.error ? (
      <div className="empty">
        <ErrorState error={this.state.error} />
        <button className="btn" onClick={() => window.location.reload()}>
          Reload application
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
