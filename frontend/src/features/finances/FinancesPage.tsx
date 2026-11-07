import { useState } from "react";
import { groupBy } from "../../lib/groupBy";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import type { Database } from "../../types/domain";
import {
  today,
  money,
  dateLabel,
  calculateDaysRemaining,
} from "../../lib/dates";
import {
  useWorkspace,
  PageHeader,
  FinanceKpiCard,
  DataTable,
  StatusBadge,
  LoadingSkeleton,
  ErrorState,
} from "../../components/ui";
export function financials(db: Database, start: string, end: string) {
  const payments = db.payments.filter(
    (p) => p.paymentDate >= start && p.paymentDate <= end,
  );
  const collected = payments.reduce((s, p) => s + p.amount, 0);
  const pt = payments.reduce((s, p) => {
    const i = db.invoices.find((i) => i.id === p.invoiceId);
    return (
      s +
      p.amount *
        (i
          ? i.lineItems
              .filter((l) => l.feeType === "PT")
              .reduce((n, l) => n + l.amount, 0) / i.totalAmount
          : 0)
    );
  }, 0);
  const payouts = db.trainers.map((t) => {
    const config = db.payoutConfigurations.find((c) => c.trainerId === t.id);
    const subscriptions = new Set(
      db.trainingSubscriptions
        .filter((s) => s.trainerId === t.id)
        .map((s) => s.id),
    );
    const trainingRevenue = payments.reduce((total, p) => {
      const invoice = db.invoices.find((i) => i.id === p.invoiceId);
      return (
        total +
        (invoice
          ? (p.amount *
              invoice.lineItems
                .filter(
                  (l) =>
                    l.feeType === "PT" && subscriptions.has(l.subscriptionId),
                )
                .reduce((s, l) => s + l.amount, 0)) /
            invoice.totalAmount
          : 0)
      );
    }, 0);
    return {
      id: t.id,
      name: t.name,
      trainingRevenue,
      rule: config
        ? config.payoutType === "COMMISSION"
          ? `${config.commissionRate}% commission`
          : "Fixed per report period"
        : "Not Configured",
      amount: config
        ? config.payoutType === "COMMISSION"
          ? (trainingRevenue * config.commissionRate) / 100
          : config.fixedAmount
        : null,
    };
  });
  const payout = payouts.reduce((s, p) => s + (p.amount || 0), 0);
  const days = groupBy(payments, (p) => p.paymentDate);
  const trends = Array.from(days, ([date, ps]) => ({
    date: dateLabel(date),
    amount: ps.reduce((s, p) => s + p.amount, 0),
  })).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return {
    payments,
    collected,
    pt,
    gym: collected - pt,
    payout,
    payouts,
    trends,
  };
}
export function FinancesPage() {
  const q = useWorkspace();
  const [range, setRange] = useState("This Month");
  const [customStart, setCustomStart] = useState(today().slice(0, 7) + "-01");
  const [customEnd, setCustomEnd] = useState(today());
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data) return <ErrorState error={q.error} />;
  const db = q.data;
  const now = new Date(today() + "T00:00:00Z");
  const offset = range === "Last Month" ? 1 : range === "Last 3 Months" ? 2 : 0;
  const start =
    range === "Custom Range"
      ? customStart
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1))
          .toISOString()
          .slice(0, 10);
  const end =
    range === "Custom Range"
      ? customEnd
      : range === "Last Month"
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
            .toISOString()
            .slice(0, 10)
        : today();
  const f = financials(db, start, end);
  const outstanding = db.invoices.filter(
    (i) => i.invoiceDate <= end && i.outstandingAmount > 0,
  );
  const balance = outstanding.reduce((s, i) => s + i.outstandingAmount, 0);
  const categories = [
    { name: "Gym membership", amount: f.gym },
    { name: "Personal training", amount: f.pt },
  ];
  const aging = [
    { name: "Not due", min: -Infinity, max: -1 },
    { name: "0–30 days", min: 0, max: 30 },
    { name: "31–60 days", min: 31, max: 60 },
    { name: "60+ days", min: 61, max: Infinity },
  ].map((b) => ({
    name: b.name,
    amount: outstanding
      .filter((i) => {
        const age = -calculateDaysRemaining(i.dueDate, end);
        return age >= b.min && age <= b.max;
      })
      .reduce((s, i) => s + i.outstandingAmount, 0),
  }));
  const months = groupBy(f.payments, (p) => p.paymentDate.slice(0, 7));
  const monthly = Array.from(months, ([date, ps]) => ({
    date,
    amount: ps.reduce((s, p) => s + p.amount, 0),
  }));
  const tooltip = {
    contentStyle: {
      background: "#20231c",
      border: "1px solid #30342b",
      borderRadius: 10,
    },
    formatter: (v: unknown) => money(Number(v)),
  };
  return (
    <>
      <PageHeader
        title="Finances"
        description="A clear view of your gym’s financial health."
      >
        <select
          aria-label="Financial date range"
          value={range}
          onChange={(e) => setRange(e.target.value)}
        >
          {["This Month", "Last Month", "Last 3 Months", "Custom Range"].map(
            (r) => (
              <option key={r}>{r}</option>
            ),
          )}
        </select>
      </PageHeader>
      {range === "Custom Range" && (
        <div className="toolbar">
          <label className="field">
            From
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
            />
          </label>
          <label className="field">
            To
            <input
              type="date"
              min={customStart}
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
            />
          </label>
        </div>
      )}
      {start > end && (
        <ErrorState error={new Error("Start date must precede end date")} />
      )}
      <div className="metrics">
        <FinanceKpiCard
          main
          label="Total Revenue Collected"
          value={money(f.collected)}
          note="Payments received during selected period"
        />
        <FinanceKpiCard
          label="Gym Membership Revenue"
          value={money(f.gym)}
          note="Collected · gym membership fees"
        />
        <FinanceKpiCard
          label="Personal Training Revenue"
          value={money(f.pt)}
          note="Collected · personal training fees"
        />
        <FinanceKpiCard
          label="Outstanding Receivables"
          value={money(balance)}
          note="Current balances on invoices issued by period end"
        />
        <FinanceKpiCard
          label="Trainer Payouts"
          value={money(f.payout)}
          note="Configured estimates; unconfigured trainers excluded"
        />
        <FinanceKpiCard
          label="Revenue After Trainer Payouts"
          value={money(f.collected - f.payout)}
          note="Before operating expenses · not net profit"
        />
      </div>
      <div className="finance-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Revenue over time</h2>
              <p>Collected payments, not invoiced amounts</p>
            </div>
          </div>
          <div className="chart-meta">
            <div className="chart-total">{money(f.collected)}</div>
            <span className="legend">
              <i className="key" />
              Collections
            </span>
          </div>
          <div className="rechart">
            <ResponsiveContainer width="100%" height={230}>
              <AreaChart data={f.trends}>
                <CartesianGrid stroke="#30342b" strokeDasharray="3 5" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#a4aa9e", fontSize: 10 }}
                />
                <YAxis tick={{ fill: "#a4aa9e", fontSize: 10 }} width={55} />
                <Tooltip {...tooltip} />
                <Area
                  dataKey="amount"
                  stroke="#9fe870"
                  fill="#9fe87022"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Revenue by category</h2>
              <p>Share of collected revenue</p>
            </div>
          </div>
          <div className="rechart">
            <ResponsiveContainer width="100%" height={210}>
              <PieChart>
                <Pie
                  data={categories}
                  dataKey="amount"
                  nameKey="name"
                  innerRadius={60}
                  outerRadius={85}
                  stroke="none"
                >
                  {categories.map((c, i) => (
                    <Cell key={c.name} fill={i ? "#68755d" : "#9fe870"} />
                  ))}
                </Pie>
                <Tooltip {...tooltip} />
              </PieChart>
            </ResponsiveContainer>
            <div className="legend category-legend">
              {categories.map((c, i) => (
                <span key={c.name}>
                  <i className={"key" + (i ? " gray" : "")} />
                  {c.name}
                  <strong>{money(c.amount)}</strong>
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>
      <div className="mini-grid">
        {[
          { title: "Outstanding payments aging", data: aging, key: "name" },
          {
            title: "Monthly collections trend",
            data: monthly.map((m) => ({ name: m.date, amount: m.amount })),
            key: "name",
          },
        ].map((c) => (
          <section className="panel" key={c.title}>
            <div className="panel-head">
              <h2>{c.title}</h2>
            </div>
            <div className="rechart">
              <ResponsiveContainer width="100%" height={190}>
                <BarChart data={c.data}>
                  <XAxis
                    dataKey={c.key}
                    tick={{ fill: "#a4aa9e", fontSize: 10 }}
                  />
                  <YAxis tick={{ fill: "#a4aa9e", fontSize: 10 }} width={55} />
                  <Tooltip {...tooltip} />
                  <Bar dataKey="amount" fill="#9fe870" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        ))}
      </div>
      <h2 className="section-title">Trainer payout breakdown</h2>
      <DataTable
        rows={f.payouts}
        columns={[
          { label: "Trainer", render: (t) => t.name },
          { label: "PT collections", render: (t) => money(t.trainingRevenue) },
          { label: "Payout rule", render: (t) => t.rule },
          {
            label: "Estimated payout",
            render: (t) =>
              t.amount === null ? "Not Configured" : money(t.amount),
          },
        ]}
      />
      <p className="text-muted">
        Payout attribution requires an invoice line linked to a trainer
        subscription. Unlinked historical collections are not assigned to a
        trainer.
      </p>
      <h2 className="section-title">Recent payments</h2>
      <DataTable
        rows={[...f.payments].sort((a, b) =>
          b.paymentDate.localeCompare(a.paymentDate),
        )}
        columns={[
          {
            label: "Member",
            render: (p) =>
              db.members.find((m) => m.id === p.memberId)?.fullName,
          },
          { label: "Receipt", render: (p) => p.id },
          { label: "Date", render: (p) => dateLabel(p.paymentDate) },
          { label: "Method", render: (p) => p.method },
          { label: "Amount collected", render: (p) => money(p.amount) },
        ]}
      />
      <h2 className="section-title">Outstanding invoices</h2>
      <DataTable
        rows={outstanding}
        columns={[
          { label: "Invoice", render: (i) => i.id },
          {
            label: "Member",
            render: (i) =>
              db.members.find((m) => m.id === i.memberId)?.fullName,
          },
          { label: "Amount invoiced", render: (i) => money(i.totalAmount) },
          { label: "Balance due", render: (i) => money(i.outstandingAmount) },
          { label: "Status", render: (i) => <StatusBadge status={i.status} /> },
        ]}
      />
    </>
  );
}
