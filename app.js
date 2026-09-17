// US ServTech — Operations & Finance
// Vanilla JS single-page app. No build step, no framework.
// Backend: Supabase (Postgres + Auth + Realtime). All numbering, invoice
// generation, revenue posting and ledger balances are computed server-side
// by database triggers/functions. The app is split into two modules:
// Operations (Dashboard through Invoices — every role) and Finance (Chart
// of Accounts through Period Close — Owner/Manager only, which is also how
// the database's own row-level security already gates every finance table,
// so an Officer calling a finance RPC directly gets nothing back either).
// Automated postings (revenue, payments, expenses, payroll, depreciation)
// still happen entirely server-side via triggers, exactly as before. This
// file adds exactly one way to write a journal entry by hand — the manual
// Journal Entry form, which calls post_manual_journal_entry() — plus the
// read-only reporting RPCs (trial_balance, income_statement,
// net_income_to_date, cash_flow_statement, general_ledger) and period
// locking (accounting_periods + close/reopen_accounting_period()).

const SUPABASE_URL = "https://xeefkivvlhsxepezypsb.supabase.co";
const SUPABASE_KEY = "sb_publishable_KWvrmZGMETiKmEl1iGNw9A_pKLrUqhX";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// VAT is not stored anywhere in the database — it is applied here the same
// way the database itself applies it when it posts revenue and payment
// journal entries (see migrations 009 and 011): 15%, and only on orders
// tagged "Odoo". Orders tagged "Zoho" carry no VAT. Discount is a flat SAR
// amount taken off the subtotal before VAT. Keeping this formula identical
// to the server's is what keeps the numbers shown here matching the ledger.
const VAT_RATE = 0.15;

const MGMT_ROLES = ["Owner", "Manager"];

// Two modules. Operations is everything through Invoices, for every role.
// Finance is Chart of Accounts onward — gated to Owner/Manager both in the
// module switch below and, independently, by the database's own RLS on
// every finance table, so this is a UI convenience, not the real boundary.
const MODULES = {
  operations: {
    label: "Operations",
    tabs: [
      { id: "dashboard", label: "Dashboard" },
      { id: "customers", label: "Customers" },
      { id: "inquiries", label: "Inquiries" },
      { id: "quotations", label: "Quotations" },
      { id: "workorders", label: "Work Orders" },
      { id: "invoices", label: "Invoices" },
    ],
  },
  finance: {
    label: "Finance",
    tabs: [
      { id: "chartofaccounts", label: "Chart of Accounts" },
      { id: "journalentries", label: "Journal Entries" },
      { id: "generalledger", label: "General Ledger" },
      { id: "trialbalance", label: "Trial Balance" },
      { id: "incomestatement", label: "Income Statement" },
      { id: "balancesheet", label: "Balance Sheet" },
      { id: "cashflow", label: "Cash Flow" },
      { id: "araging", label: "AR Aging" },
      { id: "apaging", label: "AP Aging" },
      { id: "bankaccounts", label: "Bank Accounts" },
      { id: "expenses", label: "Expenses" },
      { id: "employees", label: "Employees" },
      { id: "payroll", label: "Payroll" },
      { id: "fixedassets", label: "Fixed Assets" },
      { id: "periodclose", label: "Period Close" },
    ],
  },
};
function moduleForView(view) {
  for (const mid of Object.keys(MODULES)) {
    if (MODULES[mid].tabs.some((t) => t.id === view)) return mid;
  }
  return "operations";
}
const AGING_BUCKETS = ["0–30 days", "31–60 days", "61–90 days", "90+ days"];

const state = {
  session: null,
  profile: null,
  module: "operations",
  view: "dashboard",
  customers: [],
  inquiries: [],
  quotations: [],
  workOrders: [],
  invoices: [],
  bankAccounts: [],
  expenses: [],
  employees: [],
  payrollRuns: [],
  payrollLinesByRun: {},
  fixedAssets: [],
  accountBalances: [],
  bankBalances: [],
  journalEntries: [],
  journalLinesByJe: {},
  accountingPeriods: [],
  trialBalanceRows: [],
  incomeStatementRows: [],
  balanceSheetRows: [],
  balanceSheetNetIncome: 0,
  cashFlowRows: [],
  cashFlowBeginCash: 0,
  cashFlowEndCash: 0,
  glRows: [],
  glQuery: { account: "", from: "", to: "" },
  arInvoices: [], arTasksByInvoice: {}, arWoById: {},
  apExpenses: [], apPayrollRuns: [], apPayrollNetByRun: {},
  jeDraft: null,        // the in-progress "New journal entry" form — see freshJeDraft()
  periodDraft: { period_label: "", start_date: "", end_date: "" },
  statementDates: {
    trialbalance: { asOf: new Date().toISOString().slice(0, 10) },
    incomestatement: { from: firstOfThisMonth(), to: new Date().toISOString().slice(0, 10) },
    balancesheet: { asOf: new Date().toISOString().slice(0, 10) },
    cashflow: { from: firstOfThisMonth(), to: new Date().toISOString().slice(0, 10) },
  },
  tasksByParent: {},   // parent_id -> [task,...]
  expanded: {},        // "table:id" -> true
  inquiryDraft: null,  // the in-progress "New inquiry" form — see freshInquiryDraft()
  dashboardKpis: null,
  loading: true,
  authBusy: false,
  authError: "",
  toast: null,
};

// ---------------------------------------------------------------- helpers

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function fmtMoney(n) {
  n = Number(n || 0);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return "—";
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function taskTotals(tasks, discount, accountingSystem) {
  // Mirrors maybe_finalize_work_order()'s SQL exactly: each line's own
  // discount comes off its price first, then the order-level discount comes
  // off that sum, then VAT. Keep this identical to the server's formula (see
  // migration 015) or the number shown here will drift from what actually
  // gets posted to the ledger.
  const subtotal = (tasks || []).reduce((s, t) => s + (Number(t.price || 0) - Number(t.discount || 0)), 0);
  const afterDiscount = Math.max(0, subtotal - Number(discount || 0));
  const rate = accountingSystem === "Odoo" ? VAT_RATE : 0;
  const tax = afterDiscount * rate;
  const total = afterDiscount + tax;
  return { subtotal, afterDiscount, tax, total, rate };
}
function pill(text, cls) {
  return `<span class="pill pill-${cls}">${esc(text)}</span>`;
}
function statusPill(status) {
  const cls = { "In Process": "process", "Completed": "completed", "Delivered": "delivered" }[status] || "process";
  return pill(status, cls);
}
function isMgmt() {
  return state.profile && MGMT_ROLES.includes(state.profile.role);
}
function isOwner() {
  return state.profile && state.profile.role === "Owner";
}
function firstOfThisMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function dayBefore(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
// How long an AR/AP item has been outstanding, bucketed the way the AR/AP
// Aging reports group them — see AGING_BUCKETS above.
function agingBucket(dateStr) {
  if (!dateStr) return AGING_BUCKETS[0];
  const days = Math.floor((Date.now() - new Date(dateStr + "T00:00:00").getTime()) / 86400000);
  if (days <= 30) return AGING_BUCKETS[0];
  if (days <= 60) return AGING_BUCKETS[1];
  if (days <= 90) return AGING_BUCKETS[2];
  return AGING_BUCKETS[3];
}
function agingPillCls(bucket) {
  return { [AGING_BUCKETS[0]]: "delivered", [AGING_BUCKETS[1]]: "completed", [AGING_BUCKETS[2]]: "completed", [AGING_BUCKETS[3]]: "cancelled" }[bucket] || "process";
}
// Every account a journal-entry line can be posted to: real Chart of
// Accounts codes (from account_balances, which lists every COA row) plus
// the synthetic CASH-<bank_id> codes bank accounts post under.
function glAccountOptions(selected) {
  const coaOpts = state.accountBalances
    .slice().sort((a, b) => a.code.localeCompare(b.code))
    .map((c) => `<option value="${esc(c.code)}" ${c.code === selected ? "selected" : ""}>${esc(c.code)} — ${esc(c.name)}</option>`).join("");
  const bankOpts = state.bankAccounts
    .map((b) => `<option value="CASH-${b.id}" ${("CASH-" + b.id) === selected ? "selected" : ""}>Cash — ${esc(b.name)}</option>`).join("");
  return `<option value="">— pick account —</option>${coaOpts}${bankOpts}`;
}
function showToast(msg, isError) {
  state.toast = { msg, isError };
  render();
  setTimeout(() => { state.toast = null; renderToastOnly(); }, 3200);
}
function renderToastOnly() {
  const el = document.getElementById("toastHost");
  if (el) el.innerHTML = toastHtml();
}
function toastHtml() {
  if (!state.toast) return "";
  return `<div class="toast ${state.toast.isError ? "error" : ""}">${esc(state.toast.msg)}</div>`;
}
async function guard(promise, okMsg) {
  const { data, error } = await promise;
  if (error) {
    showToast(error.message || "Something went wrong", true);
    throw error;
  }
  if (okMsg) showToast(okMsg, false);
  return data;
}
function fd(form) {
  const out = {};
  new FormData(form).forEach((v, k) => (out[k] = v));
  return out;
}

// ------------------------------------------------------------- data loads

async function loadCustomers() {
  const { data, error } = await sb.from("customers").select("*").order("created_at", { ascending: false });
  if (!error) state.customers = data || [];
}
async function loadBankAccounts() {
  const { data, error } = await sb.from("bank_accounts").select("*").order("created_at");
  if (!error) state.bankAccounts = data || [];
}
async function loadInquiries() {
  const { data, error } = await sb.from("inquiries").select("*").order("created_at", { ascending: false }).limit(200);
  if (!error) state.inquiries = data || [];
}
async function loadQuotations() {
  const { data, error } = await sb.from("quotations").select("*").order("created_at", { ascending: false }).limit(200);
  if (!error) state.quotations = data || [];
}
async function loadWorkOrders() {
  const { data, error } = await sb.from("work_orders").select("*").order("created_at", { ascending: false }).limit(200);
  if (!error) state.workOrders = data || [];
}
async function loadInvoices() {
  const { data, error } = await sb.from("invoices").select("*").order("created_at", { ascending: false }).limit(200);
  if (!error) state.invoices = data || [];
}
async function loadLedger() {
  if (!isMgmt()) return;
  const [a, b] = await Promise.all([
    sb.from("account_balances").select("*").order("code"),
    sb.from("bank_balances").select("*").order("name"),
  ]);
  if (!a.error) state.accountBalances = a.data || [];
  if (!b.error) state.bankBalances = b.data || [];
}
async function loadJournalEntries() {
  if (!isMgmt()) return;
  const { data, error } = await sb.from("journal_entries").select("*")
    .order("je_date", { ascending: false }).order("je_number", { ascending: false }).limit(300);
  if (!error) state.journalEntries = data || [];
}
async function loadJournalLines(jeId) {
  const { data, error } = await sb.from("journal_lines").select("*").eq("journal_entry_id", jeId).order("created_at");
  if (!error) state.journalLinesByJe[jeId] = data || [];
}
async function loadAccountingPeriods() {
  if (!isMgmt()) return;
  const { data, error } = await sb.from("accounting_periods").select("*").order("start_date", { ascending: false });
  if (!error) state.accountingPeriods = data || [];
}
async function loadTrialBalance() {
  if (!isMgmt()) return;
  const { data, error } = await sb.rpc("trial_balance", { p_as_of: state.statementDates.trialbalance.asOf });
  if (!error) state.trialBalanceRows = data || [];
}
async function loadIncomeStatement() {
  if (!isMgmt()) return;
  const { from, to } = state.statementDates.incomestatement;
  const { data, error } = await sb.rpc("income_statement", { p_from: from, p_to: to });
  if (!error) state.incomeStatementRows = data || [];
}
async function loadBalanceSheet() {
  if (!isMgmt()) return;
  const asOf = state.statementDates.balancesheet.asOf;
  const [tb, ni] = await Promise.all([
    sb.rpc("trial_balance", { p_as_of: asOf }),
    sb.rpc("net_income_to_date", { p_as_of: asOf }),
  ]);
  if (!tb.error) state.balanceSheetRows = tb.data || [];
  if (!ni.error) state.balanceSheetNetIncome = ni.data || 0;
}
async function loadCashFlow() {
  if (!isMgmt()) return;
  const { from, to } = state.statementDates.cashflow;
  const [cf, tbBefore, tbTo] = await Promise.all([
    sb.rpc("cash_flow_statement", { p_from: from, p_to: to }),
    sb.rpc("trial_balance", { p_as_of: dayBefore(from) }),
    sb.rpc("trial_balance", { p_as_of: to }),
  ]);
  state.cashFlowRows = cf.error ? [] : (cf.data || []);
  const sumCash = (rows) => (rows || []).filter((r) => r.code && r.code.startsWith("CASH-"))
    .reduce((s, r) => s + Number(r.debit || 0) - Number(r.credit || 0), 0);
  state.cashFlowBeginCash = tbBefore.error ? 0 : sumCash(tbBefore.data);
  state.cashFlowEndCash = tbTo.error ? 0 : sumCash(tbTo.data);
}
async function loadGeneralLedger() {
  if (!isMgmt() || !state.glQuery.account) { state.glRows = []; return; }
  const { data, error } = await sb.rpc("general_ledger", {
    p_account_code: state.glQuery.account,
    p_from: state.glQuery.from || null,
    p_to: state.glQuery.to || null,
  });
  if (!error) state.glRows = data || [];
}
// AR Aging reads each unpaid invoice's own copy of its line items (every
// invoice gets its tasks copied onto it — parent_type 'Invoice' — the
// moment it's created, see maybe_finalize_work_order in migration 015) plus
// its work order's discount/accounting_system, so the total shown here is
// computed with the exact same taskTotals() formula as everywhere else.
async function loadARAging() {
  if (!isMgmt()) return;
  const { data: invs, error } = await sb.from("invoices").select("*").eq("payment_status", "Unpaid").order("invoice_date");
  if (error) return;
  state.arInvoices = invs || [];
  const ids = state.arInvoices.map((i) => i.id);
  const woIds = [...new Set(state.arInvoices.map((i) => i.wo_id).filter(Boolean))];
  const [tasksRes, wosRes] = await Promise.all([
    ids.length ? sb.from("tasks").select("*").eq("parent_type", "Invoice").in("parent_id", ids) : Promise.resolve({ data: [] }),
    woIds.length ? sb.from("work_orders").select("id,discount,accounting_system").in("id", woIds) : Promise.resolve({ data: [] }),
  ]);
  state.arTasksByInvoice = {};
  (tasksRes.data || []).forEach((t) => {
    if (!state.arTasksByInvoice[t.parent_id]) state.arTasksByInvoice[t.parent_id] = [];
    state.arTasksByInvoice[t.parent_id].push(t);
  });
  state.arWoById = {};
  (wosRes.data || []).forEach((w) => { state.arWoById[w.id] = w; });
}
// AP Aging: approved-but-unpaid expenses, plus approved payroll runs not yet
// paid — there's no formal Accounts Payable accrual in this system (expenses
// and payroll only post to the ledger at payment time), so this reads the
// source tables directly rather than a ledger account.
async function loadAPAging() {
  if (!isMgmt()) return;
  const [expRes, prRes] = await Promise.all([
    sb.from("expenses").select("*").eq("status", "Approved").eq("payment_status", "Unpaid").order("expense_date"),
    sb.from("payroll_runs").select("*").eq("status", "Approved").order("approved_at"),
  ]);
  state.apExpenses = expRes.data || [];
  state.apPayrollRuns = prRes.data || [];
  const runIds = state.apPayrollRuns.map((r) => r.id);
  state.apPayrollNetByRun = {};
  if (runIds.length) {
    const { data } = await sb.from("payroll_lines").select("*").in("payroll_run_id", runIds);
    (data || []).forEach((l) => {
      state.apPayrollNetByRun[l.payroll_run_id] = (state.apPayrollNetByRun[l.payroll_run_id] || 0) + Number(l.net_pay || 0);
    });
  }
}
async function loadTasksFor(parentId) {
  const { data, error } = await sb.from("tasks").select("*").eq("parent_id", parentId).order("created_at");
  if (!error) state.tasksByParent[parentId] = data || [];
}
async function loadExpenses() {
  if (!isMgmt()) return;
  const { data, error } = await sb.from("expenses").select("*").order("created_at", { ascending: false }).limit(200);
  if (!error) state.expenses = data || [];
}
async function loadEmployees() {
  if (!isMgmt()) return;
  const { data, error } = await sb.from("employees").select("*").order("created_at", { ascending: false });
  if (!error) state.employees = data || [];
}
async function loadPayrollRuns() {
  if (!isMgmt()) return;
  const { data, error } = await sb.from("payroll_runs").select("*").order("created_at", { ascending: false }).limit(100);
  if (!error) state.payrollRuns = data || [];
}
async function loadPayrollLines(runId) {
  const { data, error } = await sb.from("payroll_lines").select("*").eq("payroll_run_id", runId).order("created_at");
  if (!error) state.payrollLinesByRun[runId] = data || [];
}
async function loadFixedAssets() {
  if (!isMgmt()) return;
  const { data, error } = await sb.from("fixed_assets").select("*").order("created_at", { ascending: false }).limit(300);
  if (!error) state.fixedAssets = data || [];
}
async function loadDashboardKpis() {
  const [openInq, pendingQ, inProcessWO, unpaidInv] = await Promise.all([
    sb.from("inquiries").select("id", { count: "exact", head: true }).is("quote_id", null).is("wo_id", null),
    sb.from("quotations").select("id", { count: "exact", head: true }).eq("status", "Pending"),
    sb.from("work_orders").select("id", { count: "exact", head: true }).in("status", ["In Process", "Completed"]).eq("cancelled", false),
    sb.from("invoices").select("id", { count: "exact", head: true }).eq("payment_status", "Unpaid"),
  ]);
  const kpis = {
    openInquiries: openInq.count || 0,
    pendingQuotations: pendingQ.count || 0,
    workOrdersOpen: inProcessWO.count || 0,
    unpaidInvoices: unpaidInv.count || 0,
    cash: null,
  };
  if (isMgmt()) {
    const { data } = await sb.from("bank_balances").select("current_balance");
    kpis.cash = (data || []).reduce((s, r) => s + Number(r.current_balance || 0), 0);
  }
  state.dashboardKpis = kpis;
}

async function loadView(view) {
  state.loading = true;
  render();
  try {
    if (view === "dashboard") await loadDashboardKpis();
    if (view === "customers") await loadCustomers();
    if (view === "inquiries") await Promise.all([loadInquiries(), state.customers.length ? null : loadCustomers()]);
    if (view === "quotations") await Promise.all([loadQuotations(), state.customers.length ? null : loadCustomers()]);
    if (view === "workorders") await Promise.all([loadWorkOrders(), state.customers.length ? null : loadCustomers()]);
    if (view === "invoices") await Promise.all([loadInvoices(), loadBankAccounts()]);
    if (view === "expenses") await Promise.all([loadExpenses(), loadBankAccounts()]);
    if (view === "employees") await loadEmployees();
    if (view === "payroll") await Promise.all([loadPayrollRuns(), loadEmployees(), loadBankAccounts()]);
    if (view === "fixedassets") await Promise.all([loadFixedAssets(), loadBankAccounts()]);
    if (view === "chartofaccounts") await loadLedger();
    if (view === "bankaccounts") await Promise.all([loadLedger(), loadBankAccounts()]);
    if (view === "journalentries") await Promise.all([loadJournalEntries(), loadLedger(), loadBankAccounts(), loadAccountingPeriods()]);
    if (view === "generalledger") await Promise.all([loadLedger(), loadBankAccounts(), loadGeneralLedger()]);
    if (view === "trialbalance") await loadTrialBalance();
    if (view === "incomestatement") await loadIncomeStatement();
    if (view === "balancesheet") await loadBalanceSheet();
    if (view === "cashflow") await loadCashFlow();
    if (view === "araging") await loadARAging();
    if (view === "apaging") await loadAPAging();
    if (view === "periodclose") await loadAccountingPeriods();
    // keep expanded rows' task lists (journal-entry lines, payroll run lines) fresh
    const openParents = Object.keys(state.expanded).filter((k) => state.expanded[k]);
    await Promise.all(openParents.map((k) => {
      const [table, id] = k.split(":");
      if (table === "payroll") return loadPayrollLines(id);
      if (table === "journalentries") return loadJournalLines(id);
      return loadTasksFor(id);
    }));
  } finally {
    state.loading = false;
    render();
  }
}

// --------------------------------------------------------------- realtime

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { loadView(state.view); }, 400);
}
function setupRealtime() {
  const tables = ["customers", "inquiries", "quotations", "work_orders", "tasks", "invoices", "bank_accounts",
    "journal_entries", "journal_lines", "chart_of_accounts", "accounting_periods",
    "expenses", "employees", "payroll_runs", "payroll_lines", "fixed_assets"];
  const channel = sb.channel("us-servtech-live");
  tables.forEach((t) => {
    channel.on("postgres_changes", { event: "*", schema: "public", table: t }, scheduleRefresh);
  });
  channel.subscribe();
}

// ------------------------------------------------------------------ auth

async function init() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (state.session) await afterLogin();
  state.loading = false;
  render();

  sb.auth.onAuthStateChange(async (_event, session) => {
    const wasIn = !!state.session;
    state.session = session;
    if (session && !wasIn) { await afterLogin(); render(); }
    if (!session) { state.profile = null; render(); }
  });
}
async function afterLogin() {
  const { data: profile } = await sb.from("profiles").select("*").eq("id", state.session.user.id).maybeSingle();
  state.profile = profile;
  if (profile && profile.active) {
    setupRealtime();
    await loadCustomers();
    await loadView("dashboard");
  }
}
window.App = window.App || {};
App.login = async function (ev) {
  ev.preventDefault();
  state.authError = "";
  state.authBusy = true;
  render();
  const { email, password } = fd(ev.target);
  const { error } = await sb.auth.signInWithPassword({ email, password });
  state.authBusy = false;
  if (error) { state.authError = error.message; render(); return false; }
  return false;
};
App.logout = async function () {
  await sb.auth.signOut();
  state.view = "dashboard";
  render();
};

// ------------------------------------------------------------- nav / ui

App.nav = function (view) {
  state.view = view;
  state.module = moduleForView(view);
  loadView(view);
};
// Switching module jumps to that module's first tab. Finance is refused for
// anyone but Owner/Manager here too — belt and braces on top of the RLS
// that already blocks every finance table for an Officer.
App.switchModule = function (mid) {
  if (mid === "finance" && !isMgmt()) return;
  App.nav(MODULES[mid].tabs[0].id);
};
App.toggle = function (table, id) {
  const key = table + ":" + id;
  state.expanded[key] = !state.expanded[key];
  if (state.expanded[key]) {
    if (table === "payroll") {
      if (!state.payrollLinesByRun[id]) loadPayrollLines(id).then(render);
    } else if (table === "journalentries") {
      if (!state.journalLinesByJe[id]) loadJournalLines(id).then(render);
    } else if (!state.tasksByParent[id]) {
      loadTasksFor(id).then(render);
    }
  }
  render();
};
// Jump straight to an account's General Ledger drill-down from wherever
// it's shown (Chart of Accounts, Bank Accounts) — code is either a real
// COA code or a synthetic CASH-<bank_id> one, general_ledger() handles both.
App.viewAccountLedger = function (code) {
  state.glQuery = { account: code, from: "", to: "" };
  App.nav("generalledger");
};

// ------------------------------------------------------------ customers
//
// Customers has no standalone "add" form — it's a read-only directory. New
// customers enter the system the moment they're named on a new Inquiry (the
// only place a customer gets picked or created now that Work Orders can no
// longer be created directly — see resolveCustomerFromDraft below, which
// creates the customers row right then rather than leaving an orphaned
// free-text name on the inquiry.

// Resolves the chosen existing customer, or creates a brand-new customers
// row from the Inquiry draft's "new customer" fields (see freshInquiryDraft
// below) so it shows up in the Customers directory from then on. A brand
// new customer needs at least a Name, Invoice Name and Contact — the form
// shows every other field (VAT, address) too, in case it's already known,
// but doesn't require them; whatever's left blank can be filled in later
// from the Customers directory (App.updateCustomer / renderCustomerEditor).
// Returns the resolved {customer_id, customer}, the string "invalid" if a
// new-customer attempt was missing a required field (a toast has already
// been shown), or null if nothing was picked or typed at all.
async function resolveCustomerFromDraft(d) {
  if (d.customer_id) {
    const c = state.customers.find((x) => x.id === d.customer_id);
    if (c) return { customer_id: c.id, customer: c.display_name };
  }
  const name = (d.customer_name || "").trim();
  const invoiceName = (d.customer_invoice_name || "").trim();
  const contact = (d.customer_contact || "").trim();
  const anyOtherField = ["customer_vat_reg_no", "customer_building_no", "customer_street", "customer_district",
    "customer_postal_code", "customer_city", "customer_state"].some((k) => (d[k] || "").trim());
  if (!name && !invoiceName && !contact && !anyOtherField) return null;
  if (!name || !invoiceName || !contact) {
    showToast("A new customer needs a Name, Invoice Name and Contact", true);
    return "invalid";
  }
  const created = await guard(sb.from("customers").insert({
    display_name: name, invoice_name: invoiceName, contact,
    vat_reg_no: (d.customer_vat_reg_no || "").trim() || null,
    building_no: (d.customer_building_no || "").trim() || null,
    street: (d.customer_street || "").trim() || null,
    district: (d.customer_district || "").trim() || null,
    postal_code: (d.customer_postal_code || "").trim() || null,
    city: (d.customer_city || "").trim() || null,
    state: (d.customer_state || "").trim() || null,
    country: (d.customer_country || "").trim() || "Saudi Arabia",
  }).select().single());
  state.customers.unshift(created);
  return { customer_id: created.id, customer: created.display_name };
}

// The only way customer records get changed once they exist — fills in the
// VAT number and address fields that usually aren't known yet when a lead
// first comes in (see resolveCustomer above).
App.updateCustomer = async function (id, ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  const name = (v.display_name || "").trim();
  if (!name) { showToast("Customer name is required", true); return false; }
  await guard(sb.from("customers").update({
    display_name: name,
    invoice_name: (v.invoice_name || "").trim() || null,
    contact: (v.contact || "").trim() || null,
    company_name: (v.company_name || "").trim() || null,
    email: (v.email || "").trim() || null,
    phone: (v.phone || "").trim() || null,
    mobile: (v.mobile || "").trim() || null,
    vat_reg_no: (v.vat_reg_no || "").trim() || null,
    building_no: (v.building_no || "").trim() || null,
    street: (v.street || "").trim() || null,
    district: (v.district || "").trim() || null,
    postal_code: (v.postal_code || "").trim() || null,
    city: (v.city || "").trim() || null,
    state: (v.state || "").trim() || null,
    country: (v.country || "").trim() || "Saudi Arabia",
  }).eq("id", id), "Customer updated");
  state.expanded["customers:" + id] = false;
  await loadCustomers();
  render();
  return false;
};

// ------------------------------------------------------------- inquiries
//
// The whole point of an Inquiry is to capture what the customer needs in
// one go — who they are and every service they're asking about — rather
// than saving a bare header first and adding items on a second screen. So
// "New inquiry" below is a single draft object (state.inquiryDraft) that
// holds the customer fields AND a growable list of service line items;
// nothing is written to the database until "Create inquiry" is submitted.
// Every field is wired through App.setDraftField/setDraftItemField so that
// a re-render (adding a row, picking an existing customer, a realtime
// refresh landing mid-type) never loses what's already been typed — see
// the comment on those functions for why that matters in this codebase.

function freshInquiryDraft() {
  return {
    customer_id: "",
    customer_name: "", customer_invoice_name: "", customer_contact: "",
    customer_vat_reg_no: "", customer_building_no: "", customer_street: "", customer_district: "",
    customer_postal_code: "", customer_city: "", customer_state: "", customer_country: "Saudi Arabia",
    inquiry_date: new Date().toISOString().slice(0, 10),
    contact_method: "", accounting_system: "",
    discount: "0",
    items: [{ service_type: "", description: "", price: "", discount: "0" }],
  };
}

// Plain typing never triggers a full re-render (see above) — it just writes
// the keystroke into the draft object, exactly like the DOM input already
// shows it, then patches just the totals line directly (so the price/VAT/
// total preview stays live without rebuilding — and de-focusing — the
// input the officer is still typing in). A full re-render later (from an
// unrelated event) rebuilds the same input from this value regardless, so
// nothing is ever lost either way.
function updateDraftTotalsDisplay() {
  const d = state.inquiryDraft;
  const el = document.getElementById("inquiryDraftTotals");
  if (!d || !el) return;
  const t = taskTotals(d.items, d.discount, d.accounting_system);
  el.innerHTML = `Items subtotal (after item discounts): <b>${fmtMoney(t.subtotal)}</b> &nbsp; Order discount: <b>${fmtMoney(d.discount)}</b> &nbsp;
        VAT (${t.rate > 0 ? "15%" : "—"}): <b>${fmtMoney(t.tax)}</b> &nbsp; Total: <b>${fmtMoney(t.total)}</b>`;
}
App.setDraftField = function (field, value) {
  if (!state.inquiryDraft) return;
  state.inquiryDraft[field] = value;
  updateDraftTotalsDisplay();
};
App.setDraftItemField = function (idx, field, value) {
  if (!state.inquiryDraft || !state.inquiryDraft.items[idx]) return;
  state.inquiryDraft.items[idx][field] = value;
  updateDraftTotalsDisplay();
};
App.addDraftItemRow = function () {
  state.inquiryDraft.items.push({ service_type: "", description: "", price: "", discount: "0" });
  render();
};
App.removeDraftItemRow = function (idx) {
  state.inquiryDraft.items.splice(idx, 1);
  if (!state.inquiryDraft.items.length) state.inquiryDraft.items.push({ service_type: "", description: "", price: "", discount: "0" });
  render();
};
App.pickInquiryCustomer = function (id) {
  state.inquiryDraft.customer_id = id;
  render(); // re-render to show/clear that customer's info-on-file panel
};

App.addInquiry = async function (ev) {
  ev.preventDefault();
  const d = state.inquiryDraft;
  if (!d.accounting_system) { showToast("Pick an accounting system — Odoo or Zoho — it's what a work order needs before it can be accepted or delivered", true); return false; }
  const items = d.items.filter((it) => (it.description || "").trim() || Number(it.price || 0) > 0 || it.service_type);
  if (!items.length) { showToast("Add at least one service line item", true); return false; }
  for (const it of items) {
    if (!it.service_type) { showToast("Pick a service — Calibration, Inspection or Card — for every line item", true); return false; }
    if (!(it.description || "").trim()) { showToast("Every line item needs a description", true); return false; }
  }
  const who = await resolveCustomerFromDraft(d);
  if (who === "invalid") return false;
  if (!who) { showToast("Pick a customer or enter a new one's details", true); return false; }

  const inquiry = await guard(sb.from("inquiries").insert({
    customer_id: who.customer_id, customer: who.customer,
    inquiry_date: d.inquiry_date || new Date().toISOString().slice(0, 10),
    contact_method: d.contact_method || null,
    accounting_system: d.accounting_system || null,
    discount: Number(d.discount || 0),
  }).select().single());

  await guard(sb.from("tasks").insert(items.map((it) => ({
    parent_type: "Inquiry", parent_id: inquiry.id,
    service_type: it.service_type,
    description: it.description.trim(),
    price: Number(it.price || 0),
    discount: Number(it.discount || 0),
  }))), "Inquiry added");

  state.inquiryDraft = freshInquiryDraft();
  await loadInquiries();
  render();
  return false;
};
App.convertInquiry = async function (id, kind) {
  const fn = kind === "quotation" ? "convert_inquiry_to_quotation" : "convert_inquiry_to_work_order";
  const arg = { p_inquiry_id: id };
  await guard(sb.rpc(fn, arg), kind === "quotation" ? "Converted to quotation" : "Converted to work order");
  await loadInquiries();
  render();
};

// ------------------------------------------------------------ quotations
//
// No standalone "new quotation" form — a quotation only ever comes from
// accepting a conversion on an Inquiry (App.convertInquiry above).

App.acceptQuotation = async function (id) {
  await guard(sb.rpc("accept_quotation", { p_quote_id: id }), "Quotation accepted — work order created");
  await loadQuotations();
  render();
};
App.rejectQuotation = async function (id) {
  await guard(sb.rpc("reject_quotation", { p_quote_id: id }), "Quotation rejected");
  await loadQuotations();
  render();
};

// ----------------------------------------------------------- work orders
//
// No standalone "new work order" form either — a work order only ever
// comes from an Inquiry, either directly (App.convertInquiry(id,
// 'workorder')) or via a Quotation being accepted (App.acceptQuotation
// above). That's also what keeps a work order from ever appearing with no
// line items and therefore nothing to set a status on.

App.cancelWorkOrder = async function (id) {
  const reason = prompt("Reason for cancelling this work order:");
  if (reason === null) return;
  await guard(sb.from("work_orders").update({ cancelled: true, cancel_reason: reason || null, cancelled_at: new Date().toISOString() }).eq("id", id), "Work order cancelled");
  await loadWorkOrders();
  render();
};

// ------------------------------------------------------------------ tasks

App.addTask = async function (parentType, parentId, ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.description || !v.description.trim()) { showToast("Item description is required", true); return false; }
  if (!v.service_type) { showToast("Pick a service — Calibration, Inspection or Card", true); return false; }
  await guard(sb.from("tasks").insert({
    parent_type: parentType, parent_id: parentId,
    service_type: v.service_type,
    description: v.description.trim(),
    price: Number(v.price || 0),
    discount: Number(v.discount || 0),
  }));
  ev.target.reset();
  await loadTasksFor(parentId);
  render();
  return false;
};
App.updateTaskStatus = async function (taskId, parentId, status) {
  await guard(sb.from("tasks").update({ status }).eq("id", taskId));
  await loadTasksFor(parentId);
  render();
};
App.deleteTask = async function (taskId, parentId) {
  if (!confirm("Remove this line item?")) return;
  await guard(sb.from("tasks").delete().eq("id", taskId));
  await loadTasksFor(parentId);
  render();
};

// ---------------------------------------------------------------- invoices

App.markInvoicePaid = async function (id, ev) {
  const bankId = ev.target.value;
  if (!bankId) return;
  await guard(sb.from("invoices").update({
    payment_status: "Paid", paid_from: bankId, paid_at: new Date().toISOString(), marked_paid_by: state.session.user.id,
  }).eq("id", id), "Invoice marked paid");
  await loadInvoices();
  render();
};

// ---------------------------------------------------------------- expenses

App.addExpense = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.amount || Number(v.amount) <= 0) { showToast("Enter an amount", true); return false; }
  await guard(sb.from("expenses").insert({
    expense_date: v.expense_date || new Date().toISOString().slice(0, 10),
    category: v.category || null, vendor: v.vendor || null,
    cost_type: v.cost_type || "Overhead", amount: Number(v.amount),
    description: v.description || null, requested_by: state.session.user.id,
  }), "Expense added — pending approval");
  ev.target.reset();
  await loadExpenses();
  render();
  return false;
};
App.approveExpense = async function (id) {
  await guard(sb.from("expenses").update({ status: "Approved", approved_by: state.session.user.id, approved_at: new Date().toISOString() }).eq("id", id), "Expense approved");
  await loadExpenses();
  render();
};
App.rejectExpense = async function (id) {
  await guard(sb.from("expenses").update({ status: "Rejected", approved_by: state.session.user.id, approved_at: new Date().toISOString() }).eq("id", id), "Expense rejected");
  await loadExpenses();
  render();
};
App.payExpense = async function (id, ev) {
  const bankId = ev.target.value;
  if (!bankId) return;
  await guard(sb.from("expenses").update({ payment_status: "Paid", paid_from: bankId, paid_at: new Date().toISOString() }).eq("id", id), "Expense paid");
  await loadExpenses();
  render();
};

// --------------------------------------------------------------- employees

App.addEmployee = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.name || !v.name.trim()) { showToast("Employee name is required", true); return false; }
  await guard(sb.from("employees").insert({
    name: v.name.trim(), role: v.role || null, monthly_salary: v.monthly_salary ? Number(v.monthly_salary) : null,
  }), "Employee added");
  ev.target.reset();
  await loadEmployees();
  render();
  return false;
};
App.toggleEmployeeActive = async function (id, active) {
  await guard(sb.from("employees").update({ active: !active }).eq("id", id));
  await loadEmployees();
  render();
};

// ----------------------------------------------------------------- payroll

App.addPayrollRun = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.period || !v.period.trim()) { showToast("Enter a pay period, e.g. 2026-09", true); return false; }
  await guard(sb.from("payroll_runs").insert({ period: v.period.trim(), created_by: state.session.user.id }), "Payroll run created");
  ev.target.reset();
  await loadPayrollRuns();
  render();
  return false;
};
App.addPayrollLine = async function (runId, ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  const emp = state.employees.find((e) => e.id === v.employee_id);
  if (!emp) { showToast("Pick an employee", true); return false; }
  const gross = v.gross_salary ? Number(v.gross_salary) : Number(emp.monthly_salary || 0);
  const net = v.net_pay ? Number(v.net_pay) : gross;
  await guard(sb.from("payroll_lines").insert({
    payroll_run_id: runId, employee_id: emp.id, employee_name: emp.name, gross_salary: gross, net_pay: net,
  }));
  ev.target.reset();
  await loadPayrollLines(runId);
  render();
  return false;
};
App.deletePayrollLine = async function (id, runId) {
  await guard(sb.from("payroll_lines").delete().eq("id", id));
  await loadPayrollLines(runId);
  render();
};
App.approvePayrollRun = async function (id) {
  await guard(sb.from("payroll_runs").update({ status: "Approved", approved_by: state.session.user.id, approved_at: new Date().toISOString() }).eq("id", id), "Payroll run approved");
  await loadPayrollRuns();
  render();
};
App.payPayrollRun = async function (id, ev) {
  const bankId = ev.target.value;
  if (!bankId) return;
  await guard(sb.from("payroll_runs").update({ status: "Paid", paid_from: bankId, paid_at: new Date().toISOString() }).eq("id", id), "Payroll paid");
  await loadPayrollRuns();
  render();
};

// ------------------------------------------------------------ fixed assets

App.addFixedAsset = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.name || !v.name.trim()) { showToast("Asset name is required", true); return false; }
  if (!v.cost || Number(v.cost) <= 0) { showToast("Enter a cost", true); return false; }
  if (!v.paid_from) { showToast("Pick which bank paid for it", true); return false; }
  await guard(sb.from("fixed_assets").insert({
    name: v.name.trim(), category: v.category || null, cost: Number(v.cost),
    purchase_date: v.purchase_date || new Date().toISOString().slice(0, 10),
    useful_life_months: v.useful_life_months ? Number(v.useful_life_months) : 36,
    paid_from: v.paid_from,
  }), "Asset recorded");
  ev.target.reset();
  await loadFixedAssets();
  render();
  return false;
};
App.runDepreciation = async function () {
  const n = await guard(sb.rpc("run_monthly_depreciation"));
  showToast(n > 0 ? `Depreciated ${n} asset${n === 1 ? "" : "s"} for this month` : "Nothing to depreciate this month — already up to date", false);
  await loadFixedAssets();
  await loadLedger();
  render();
};

// ------------------------------------------------------------ bank accounts

App.addBankAccount = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.name || !v.name.trim()) { showToast("Bank account name is required", true); return false; }
  await guard(sb.from("bank_accounts").insert({
    name: v.name.trim(), account_type: v.account_type || null, account_number: v.account_number || null,
    opening_balance: Number(v.opening_balance || 0),
  }), "Bank account added");
  ev.target.reset();
  await loadBankAccounts();
  await loadLedger();
  render();
  return false;
};

// ------------------------------------------------------------ chart of accounts
//
// The database itself only lets the Owner insert or rename an account
// (chart_of_accounts_owner_write / _owner_update policies) — a Manager can
// read balances but not restructure the chart. This form is hidden from a
// Manager for the same reason; if it weren't, the insert would just fail.

App.addChartAccount = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.code || !v.code.trim()) { showToast("Account code is required", true); return false; }
  if (!v.name || !v.name.trim()) { showToast("Account name is required", true); return false; }
  if (!v.account_type) { showToast("Pick an account type", true); return false; }
  await guard(sb.from("chart_of_accounts").insert({
    code: v.code.trim(), name: v.name.trim(), account_type: v.account_type,
  }), "Account added");
  ev.target.reset();
  await loadLedger();
  render();
  return false;
};

// ------------------------------------------------------------ journal entries
//
// The one place this app writes a journal entry by hand — everything else
// (revenue, payments, expense/payroll payouts, asset purchases,
// depreciation) posts itself via server-side triggers. Same state-bound
// draft pattern as the Inquiry form (see freshInquiryDraft above): plain
// typing never re-renders, it just patches the totals line directly, so a
// realtime refresh landing mid-type can't wipe an unfinished entry.

function freshJeDraft() {
  return {
    je_date: new Date().toISOString().slice(0, 10),
    memo: "",
    lines: [
      { account_code: "", debit: "", credit: "" },
      { account_code: "", debit: "", credit: "" },
    ],
  };
}
function jeDraftTotals() {
  const lines = state.jeDraft.lines;
  const debit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const credit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  return { debit, credit, balanced: debit > 0 && Math.abs(debit - credit) < 0.005 };
}
function updateJeDraftTotals() {
  const el = document.getElementById("jeDraftTotals");
  if (!el) return;
  const t = jeDraftTotals();
  el.innerHTML = `Total debit: <b>${fmtMoney(t.debit)}</b> &nbsp; Total credit: <b>${fmtMoney(t.credit)}</b> &nbsp;
    <span class="balance-flag ${t.balanced ? "ok" : "bad"}">${t.balanced ? "Balanced" : "Not balanced"}</span>`;
}
App.setJeField = function (field, value) {
  state.jeDraft[field] = value;
};
App.setJeLineField = function (idx, field, value) {
  state.jeDraft.lines[idx][field] = value;
  updateJeDraftTotals();
};
App.addJeLineRow = function () {
  state.jeDraft.lines.push({ account_code: "", debit: "", credit: "" });
  render();
};
App.removeJeLineRow = function (idx) {
  state.jeDraft.lines.splice(idx, 1);
  if (state.jeDraft.lines.length < 2) state.jeDraft.lines.push({ account_code: "", debit: "", credit: "" });
  render();
};
App.postJournalEntry = async function (ev) {
  ev.preventDefault();
  const d = state.jeDraft;
  const lines = d.lines.filter((l) => l.account_code && (Number(l.debit || 0) > 0 || Number(l.credit || 0) > 0));
  if (lines.length < 2) { showToast("A journal entry needs at least two lines", true); return false; }
  const debit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const credit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(debit - credit) >= 0.005) { showToast("Debits and credits must balance", true); return false; }
  if (!d.memo || !d.memo.trim()) { showToast("Enter a memo describing this entry", true); return false; }
  await guard(sb.rpc("post_manual_journal_entry", {
    p_je_date: d.je_date || new Date().toISOString().slice(0, 10),
    p_memo: d.memo.trim(),
    p_lines: lines.map((l) => ({ account_code: l.account_code, debit: Number(l.debit || 0), credit: Number(l.credit || 0) })),
  }), "Journal entry posted");
  state.jeDraft = freshJeDraft();
  await Promise.all([loadJournalEntries(), loadLedger()]);
  render();
  return false;
};

// ------------------------------------------------------------ general ledger

App.setGlAccount = function (value) {
  state.glQuery.account = value;
};
App.setGlField = function (field, value) {
  state.glQuery[field] = value;
};
App.runGlQuery = async function (ev) {
  ev.preventDefault();
  await loadGeneralLedger();
  render();
  return false;
};

// -------------------------------------------------------- financial statements

App.setStatementDate = function (stmt, field, value) {
  state.statementDates[stmt][field] = value;
};
App.runStatement = async function (stmt, ev) {
  ev.preventDefault();
  if (stmt === "trialbalance") await loadTrialBalance();
  if (stmt === "incomestatement") await loadIncomeStatement();
  if (stmt === "balancesheet") await loadBalanceSheet();
  if (stmt === "cashflow") await loadCashFlow();
  render();
  return false;
};

// ------------------------------------------------------------- period close

App.setPeriodField = function (field, value) {
  state.periodDraft[field] = value;
};
App.createPeriod = async function (ev) {
  ev.preventDefault();
  const pd = state.periodDraft;
  if (!pd.period_label.trim() || !pd.start_date || !pd.end_date) { showToast("Fill in a label, start date and end date", true); return false; }
  if (pd.end_date < pd.start_date) { showToast("End date must be on or after the start date", true); return false; }
  await guard(sb.from("accounting_periods").insert({
    period_label: pd.period_label.trim(), start_date: pd.start_date, end_date: pd.end_date,
  }), "Period created");
  state.periodDraft = { period_label: "", start_date: "", end_date: "" };
  await loadAccountingPeriods();
  render();
  return false;
};
App.closePeriodAction = async function (id) {
  if (!confirm("Close this period? No new or edited posting dated inside it will be allowed for anyone — including automated postings — until it's reopened.")) return;
  await guard(sb.rpc("close_accounting_period", { p_period_id: id }), "Period closed");
  await loadAccountingPeriods();
  render();
};
App.reopenPeriodAction = async function (id) {
  await guard(sb.rpc("reopen_accounting_period", { p_period_id: id }), "Period reopened");
  await loadAccountingPeriods();
  render();
};

// ====================================================================
// RENDER
// ====================================================================

function render() {
  const app = document.getElementById("app");
  document.documentElement.dataset.module = state.module || "operations";
  if (state.loading && !state.profile && !state.session) { app.innerHTML = `<div class="empty-state">Loading…</div>`; return; }
  if (!state.session) { app.innerHTML = renderLogin(); return; }
  if (!state.profile) { app.innerHTML = `<div class="empty-state">Loading your profile…</div>`; return; }
  if (!state.profile.active) { app.innerHTML = renderDisabled(); return; }
  app.innerHTML = renderShell();
}

// Placeholder monogram badge — see .logo-badge in index.html. Swap for the
// company's actual logo file the moment it arrives; nothing else changes.
const LOGO_MARK = `<span class="logo-badge">UST</span>`;

function renderLogin() {
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-brand">${LOGO_MARK}<h1>US ServTech</h1></div>
      <p class="sub">Operations &amp; Finance — sign in with your company login.</p>
      <form onsubmit="return App.login(event)">
        <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="username"></div>
        <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>
        <button class="btn btn-primary" type="submit" style="width:100%" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Signing in…" : "Sign in"}</button>
        <div class="error-msg">${esc(state.authError)}</div>
      </form>
    </div>
  </div>`;
}
function renderDisabled() {
  return `
  <div class="login-wrap">
    <div class="login-card">
      <h1>Account disabled</h1>
      <p class="sub">Your login has been deactivated. Contact the owner to restore access.</p>
      <button class="btn btn-ghost" onclick="App.logout()">Sign out</button>
    </div>
  </div>`;
}
function renderShell() {
  const mod = state.module;
  const showFinance = isMgmt();
  const moduleBtns = `
    <button class="mod-operations ${mod === "operations" ? "active" : ""}" onclick="App.switchModule('operations')">Operations</button>
    ${showFinance ? `<button class="mod-finance ${mod === "finance" ? "active" : ""}" onclick="App.switchModule('finance')">Finance</button>` : ""}`;
  const tabs = MODULES[mod] ? MODULES[mod].tabs : MODULES.operations.tabs;
  const subnavHtml = tabs.map((t) =>
    `<button class="${state.view === t.id ? "active" : ""}" onclick="App.nav('${t.id}')">${t.label}</button>`
  ).join("");
  return `
  <div class="topbar">
    <div class="brand">${LOGO_MARK}<span>US ServTech<span class="tag">Operations &amp; Finance</span></span></div>
    <div class="module-switch">${moduleBtns}</div>
    <div class="who"><b>${esc(state.profile.name || state.session.user.email)}</b> · ${esc(state.profile.role)}
      <button class="btn btn-ghost btn-sm" onclick="App.logout()">Sign out</button>
    </div>
  </div>
  <div class="subnav">${subnavHtml}</div>
  <main>${state.loading ? `<div class="empty-state">Loading…</div>` : renderView()}</main>
  <div id="toastHost">${toastHtml()}</div>`;
}
function renderView() {
  switch (state.view) {
    case "dashboard": return renderDashboard();
    case "customers": return renderCustomers();
    case "inquiries": return renderInquiries();
    case "quotations": return renderQuotations();
    case "workorders": return renderWorkOrders();
    case "invoices": return renderInvoices();
    case "expenses": return isMgmt() ? renderExpenses() : mgmtOnlyView();
    case "employees": return isMgmt() ? renderEmployees() : mgmtOnlyView();
    case "payroll": return isMgmt() ? renderPayroll() : mgmtOnlyView();
    case "fixedassets": return isMgmt() ? renderFixedAssets() : mgmtOnlyView();
    case "chartofaccounts": return isMgmt() ? renderChartOfAccounts() : mgmtOnlyView();
    case "bankaccounts": return isMgmt() ? renderBankAccounts() : mgmtOnlyView();
    case "journalentries": return isMgmt() ? renderJournalEntries() : mgmtOnlyView();
    case "generalledger": return isMgmt() ? renderGeneralLedger() : mgmtOnlyView();
    case "trialbalance": return isMgmt() ? renderTrialBalance() : mgmtOnlyView();
    case "incomestatement": return isMgmt() ? renderIncomeStatement() : mgmtOnlyView();
    case "balancesheet": return isMgmt() ? renderBalanceSheet() : mgmtOnlyView();
    case "cashflow": return isMgmt() ? renderCashFlow() : mgmtOnlyView();
    case "araging": return isMgmt() ? renderARAging() : mgmtOnlyView();
    case "apaging": return isMgmt() ? renderAPAging() : mgmtOnlyView();
    case "periodclose": return isMgmt() ? renderPeriodClose() : mgmtOnlyView();
    default: return "";
  }
}
function mgmtOnlyView() {
  return `<div class="empty-state">Not available for your role.</div>`;
}

// ---------------------------------------------------------- Dashboard

function renderDashboard() {
  const k = state.dashboardKpis || {};
  const tiles = [
    ["Open inquiries", k.openInquiries],
    ["Pending quotations", k.pendingQuotations],
    ["Work orders open", k.workOrdersOpen],
    ["Unpaid invoices", k.unpaidInvoices],
  ];
  if (isMgmt() && k.cash !== null && k.cash !== undefined) tiles.push(["Total cash (SAR)", fmtMoney(k.cash)]);
  return `
  <h2 class="page-title">Dashboard</h2>
  <p class="page-sub">Welcome back, ${esc((state.profile.name || "").split(" ")[0] || "there")}. Everything below is live.</p>
  <div class="kpi-grid">
    ${tiles.map(([label, value]) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value === undefined || value === null ? "—" : value}</div></div>`).join("")}
  </div>
  <div class="card">
    <h3>Where to go next</h3>
    <p class="subtle">New business starts on <b>Inquiries</b>. Convert an inquiry to a <b>Quotation</b> or straight to a <b>Work Order</b>.
    Mark line items Delivered on a work order and its invoice and revenue posting happen automatically.
    Payments are recorded on <b>Invoices</b>.${isMgmt() ? " Switch to the <b>Finance</b> module above for the chart of accounts, journal entries and every financial statement." : ""}</p>
  </div>`;
}

// ---------------------------------------------------------- Customers

function customerOptions(selectedId) {
  return `<option value="">— pick existing customer —</option>` +
    state.customers.map((c) => `<option value="${c.id}" ${c.id === selectedId ? "selected" : ""}>${esc(c.display_name)}${c.company_name ? " — " + esc(c.company_name) : ""}</option>`).join("");
}
function renderCustomers() {
  return `
  <h2 class="page-title">Customers</h2>
  <p class="page-sub">${state.customers.length} customer${state.customers.length === 1 ? "" : "s"} on file. New customers are added automatically — with a Name, Invoice Name and Contact — the first time they're named on an inquiry or work order. VAT and the address usually aren't known yet at that point; open Edit here to fill them in once they arrive.</p>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Name</th><th>Invoice name</th><th>Contact</th><th>City</th><th>VAT no.</th><th></th></tr></thead>
      <tbody>
        ${state.customers.length ? state.customers.map((c) => {
          const key = "customers:" + c.id;
          const open = !!state.expanded[key];
          return `
          <tr class="clickable" onclick="App.toggle('customers','${c.id}')">
            <td>${esc(c.customer_number)}</td>
            <td>${esc(c.display_name)}</td>
            <td>${esc(c.invoice_name)}</td>
            <td>${esc(c.contact)}</td>
            <td>${esc(c.city)}</td>
            <td>${esc(c.vat_reg_no)}</td>
            <td onclick="event.stopPropagation()"><button class="link-btn" onclick="App.toggle('customers','${c.id}')">${open ? "close" : "edit"}</button></td>
          </tr>
          ${open ? `<tr><td colspan="7">${renderCustomerEditor(c)}</td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="7" class="empty-state">No customers yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function renderCustomerEditor(c) {
  return `
  <div class="wo-detail">
    <form onsubmit="return App.updateCustomer('${c.id}',event)">
      <div class="form-row">
        <div class="field"><label>Customer name</label><input name="display_name" value="${esc(c.display_name)}" required></div>
        <div class="field"><label>Invoice name</label><input name="invoice_name" value="${esc(c.invoice_name)}"></div>
        <div class="field"><label>Contact</label><input name="contact" value="${esc(c.contact)}"></div>
        <div class="field"><label>Company name</label><input name="company_name" value="${esc(c.company_name)}"></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>Email</label><input name="email" type="email" value="${esc(c.email)}"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(c.phone)}"></div>
        <div class="field"><label>Mobile</label><input name="mobile" value="${esc(c.mobile)}"></div>
        <div class="field"><label>VAT registration no.</label><input name="vat_reg_no" value="${esc(c.vat_reg_no)}"></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>Building no.</label><input name="building_no" value="${esc(c.building_no)}"></div>
        <div class="field"><label>Street</label><input name="street" value="${esc(c.street)}"></div>
        <div class="field"><label>District</label><input name="district" value="${esc(c.district)}"></div>
        <div class="field"><label>Postal code</label><input name="postal_code" value="${esc(c.postal_code)}"></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>City</label><input name="city" value="${esc(c.city)}"></div>
        <div class="field"><label>State / Province</label><input name="state" value="${esc(c.state)}"></div>
        <div class="field"><label>Country</label><input name="country" value="${esc(c.country) || "Saudi Arabia"}"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Save</button></div>
      </div>
    </form>
  </div>`;
}

// ---------------------------------------------------------- Tasks editor

// One customer may need several different services on the same order —
// calibration of a batch of tools, an inspection, a card — so each line
// item picks which of these it is. Kept to exactly these three because
// that's what's costed and certified differently downstream.
const SERVICE_TYPES = ["Calibration", "Inspection", "Card"];

function renderTasksEditor(parentType, parentId, discount, accountingSystem, showStatus) {
  const tasks = state.tasksByParent[parentId] || [];
  const t = taskTotals(tasks, discount, accountingSystem);
  // A work order's line items are fixed the moment it's created — they come
  // from whichever inquiry or quotation it was converted from, and the
  // database itself now refuses any insert or delete against them (see
  // migration 019), for every role, no exceptions. Same for a Delivered
  // item's status: once set, it's permanently locked, not just for
  // Officers. This function still serves Inquiry/Quotation detail rows too
  // (parentType "Inquiry"/"Quotation"), where adding or removing items
  // stays open, since those are still being drafted.
  const itemsLocked = parentType === "Work Order";
  return `
  <div class="wo-detail">
    <table>
      <thead><tr><th>Service</th><th>Description</th><th class="right">Price (SAR)</th><th class="right">Discount (SAR)</th>${showStatus ? "<th>Status</th>" : ""}${itemsLocked ? "" : "<th></th>"}</tr></thead>
      <tbody>
        ${tasks.length ? tasks.map((tk) => {
          const statusLocked = showStatus && tk.status === "Delivered";
          return `
          <tr>
            <td>${esc(tk.service_type) || "—"}</td>
            <td>${esc(tk.description)}</td>
            <td class="right">${fmtMoney(tk.price)}</td>
            <td class="right">${fmtMoney(tk.discount)}</td>
            ${showStatus ? `<td>
              ${statusLocked
                ? `${statusPill(tk.status)}<div class="subtle">locked — final</div>`
                : `<select onchange="App.updateTaskStatus('${tk.id}','${parentId}',this.value)">
                    ${["In Process", "Completed", "Delivered"].map((s) => `<option value="${s}" ${s === tk.status ? "selected" : ""}>${s}</option>`).join("")}
                  </select>`}
            </td>` : ""}
            ${itemsLocked ? "" : `<td><button class="link-btn" onclick="App.deleteTask('${tk.id}','${parentId}')">remove</button></td>`}
          </tr>`;
        }).join("") : `<tr><td colspan="${showStatus ? 6 : 5}" class="empty-state">No line items yet.</td></tr>`}
      </tbody>
    </table>
    ${itemsLocked
      ? `<p class="subtle" style="margin-top:10px">Line items are fixed once a work order is created — they came from the inquiry or quotation it was converted from and can't be added to or removed by anyone.</p>`
      : `<form class="form-row" style="margin-top:10px" onsubmit="return App.addTask('${parentType}','${parentId}',event)">
      <div class="field"><label>Service</label>
        <select name="service_type" required>
          <option value="">— pick —</option>
          ${SERVICE_TYPES.map((s) => `<option value="${s}">${s}</option>`).join("")}
        </select>
      </div>
      <div class="field"><label>Description</label><input name="description" required placeholder="e.g. Torque wrench 0–200 Nm"></div>
      <div class="field"><label>Price (SAR)</label><input name="price" type="number" step="0.01" min="0" required></div>
      <div class="field"><label>Discount (SAR)</label><input name="discount" type="number" step="0.01" min="0" value="0"></div>
      <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" type="submit">Add item</button></div>
    </form>`}
    <div class="totals-line">
      Items subtotal (after item discounts): <b>${fmtMoney(t.subtotal)}</b> &nbsp; Order discount: <b>${fmtMoney(discount)}</b> &nbsp;
      VAT (${t.rate > 0 ? "15%" : "—"}): <b>${fmtMoney(t.tax)}</b> &nbsp; Total: <b>${fmtMoney(t.total)}</b>
      <span class="subtle">— computed here for display; not stored.</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------- Inquiries

// Shown in the New Inquiry form once an existing customer is picked, so the
// officer sees what's already on file instead of having to go check the
// Customers directory separately.
function renderCustomerInfoPanel(c) {
  const addrLine1 = [c.building_no, c.street, c.district].filter(Boolean).join(", ");
  const addrLine2 = [c.postal_code, c.city, c.state, c.country].filter(Boolean).join(", ");
  return `
  <div class="wo-detail" style="margin-top:10px">
    <div class="form-row">
      <div class="field"><label>Invoice name</label>${esc(c.invoice_name) || "<span class=\"subtle\">not on file</span>"}</div>
      <div class="field"><label>Contact</label>${esc(c.contact) || "<span class=\"subtle\">not on file</span>"}</div>
      <div class="field"><label>VAT registration no.</label>${esc(c.vat_reg_no) || "<span class=\"subtle\">not on file</span>"}</div>
    </div>
    <div class="form-row" style="margin-top:8px">
      <div class="field" style="flex:2"><label>Address</label>${addrLine1 || addrLine2 ? `${esc(addrLine1)}${addrLine1 && addrLine2 ? "<br>" : ""}${esc(addrLine2)}` : `<span class="subtle">not on file</span>`}</div>
    </div>
    <div class="subtle" style="margin-top:6px">Anything missing gets filled in from the Customers directory — Edit on ${esc(c.display_name)}.</div>
  </div>`;
}

// Shown instead of the panel above when there's no existing customer picked
// — every field the business needs is here (see App.updateCustomer for the
// same set), but only Name, Invoice Name and Contact are required; the rest
// can come later from the Customers directory once it's known.
function renderNewCustomerFields(d) {
  return `
  <div class="form-row" style="margin-top:10px">
    <div class="field"><label>New customer — Name</label><input value="${esc(d.customer_name)}" oninput="App.setDraftField('customer_name',this.value)" placeholder="Required"></div>
    <div class="field"><label>Invoice name</label><input value="${esc(d.customer_invoice_name)}" oninput="App.setDraftField('customer_invoice_name',this.value)" placeholder="Required"></div>
    <div class="field"><label>Contact</label><input value="${esc(d.customer_contact)}" oninput="App.setDraftField('customer_contact',this.value)" placeholder="Required — phone or email"></div>
    <div class="field"><label>VAT registration no.</label><input value="${esc(d.customer_vat_reg_no)}" oninput="App.setDraftField('customer_vat_reg_no',this.value)"></div>
  </div>
  <div class="form-row" style="margin-top:10px">
    <div class="field"><label>Building no.</label><input value="${esc(d.customer_building_no)}" oninput="App.setDraftField('customer_building_no',this.value)"></div>
    <div class="field"><label>Street</label><input value="${esc(d.customer_street)}" oninput="App.setDraftField('customer_street',this.value)"></div>
    <div class="field"><label>District</label><input value="${esc(d.customer_district)}" oninput="App.setDraftField('customer_district',this.value)"></div>
    <div class="field"><label>Postal code</label><input value="${esc(d.customer_postal_code)}" oninput="App.setDraftField('customer_postal_code',this.value)"></div>
  </div>
  <div class="form-row" style="margin-top:10px">
    <div class="field"><label>City</label><input value="${esc(d.customer_city)}" oninput="App.setDraftField('customer_city',this.value)"></div>
    <div class="field"><label>State / Province</label><input value="${esc(d.customer_state)}" oninput="App.setDraftField('customer_state',this.value)"></div>
    <div class="field"><label>Country</label><input value="${esc(d.customer_country)}" oninput="App.setDraftField('customer_country',this.value)"></div>
  </div>`;
}

function renderInquiries() {
  if (!state.inquiryDraft) state.inquiryDraft = freshInquiryDraft();
  const d = state.inquiryDraft;
  const pickedCustomer = d.customer_id ? state.customers.find((c) => c.id === d.customer_id) : null;
  const draftTotals = taskTotals(d.items, d.discount, d.accounting_system);
  return `
  <h2 class="page-title">Inquiries</h2>
  <p class="page-sub">Capture the customer and every service they're asking about in one go, then convert it to a quotation or straight to a work order.</p>
  <div class="card">
    <h3>New inquiry</h3>
    <form onsubmit="return App.addInquiry(event)">
      <div class="form-row">
        <div class="field"><label>Customer on file</label>
          <select onchange="App.pickInquiryCustomer(this.value)">${customerOptions(d.customer_id)}</select>
        </div>
        <div class="field"><label>Date</label><input type="date" value="${esc(d.inquiry_date)}" oninput="App.setDraftField('inquiry_date',this.value)"></div>
        <div class="field"><label>Contact method</label><input value="${esc(d.contact_method)}" oninput="App.setDraftField('contact_method',this.value)" placeholder="Phone / Email / Visit"></div>
        <div class="field"><label>Accounting system *</label>
          <select required onchange="App.setDraftField('accounting_system',this.value)">
            <option value="" ${!d.accounting_system ? "selected" : ""}>— pick —</option>
            <option ${d.accounting_system === "Odoo" ? "selected" : ""}>Odoo</option>
            <option ${d.accounting_system === "Zoho" ? "selected" : ""}>Zoho</option>
          </select>
        </div>
      </div>
      ${pickedCustomer ? renderCustomerInfoPanel(pickedCustomer) : renderNewCustomerFields(d)}

      <h4 style="margin-top:16px;margin-bottom:8px">Services required</h4>
      <table>
        <thead><tr><th>Service</th><th>Description</th><th class="right">Price (SAR)</th><th class="right">Discount (SAR)</th><th></th></tr></thead>
        <tbody>
          ${d.items.map((it, idx) => `
          <tr>
            <td>
              <select onchange="App.setDraftItemField(${idx},'service_type',this.value)">
                <option value="">— pick —</option>
                ${SERVICE_TYPES.map((s) => `<option value="${s}" ${it.service_type === s ? "selected" : ""}>${s}</option>`).join("")}
              </select>
            </td>
            <td><input value="${esc(it.description)}" oninput="App.setDraftItemField(${idx},'description',this.value)" placeholder="e.g. Torque wrench 0–200 Nm"></td>
            <td class="right"><input type="number" step="0.01" min="0" style="width:110px" value="${esc(it.price)}" oninput="App.setDraftItemField(${idx},'price',this.value)"></td>
            <td class="right"><input type="number" step="0.01" min="0" style="width:110px" value="${esc(it.discount)}" oninput="App.setDraftItemField(${idx},'discount',this.value)"></td>
            <td>${d.items.length > 1 ? `<button type="button" class="link-btn" onclick="App.removeDraftItemRow(${idx})">remove</button>` : ""}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="App.addDraftItemRow()">+ Add another service</button>

      <div class="form-row" style="margin-top:14px">
        <div class="field"><label>Overall discount on whole price (SAR)</label><input type="number" step="0.01" min="0" value="${esc(d.discount)}" oninput="App.setDraftField('discount',this.value)"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Create inquiry</button></div>
      </div>
      <div class="totals-line" id="inquiryDraftTotals">Items subtotal (after item discounts): <b>${fmtMoney(draftTotals.subtotal)}</b> &nbsp; Order discount: <b>${fmtMoney(d.discount)}</b> &nbsp;
        VAT (${draftTotals.rate > 0 ? "15%" : "—"}): <b>${fmtMoney(draftTotals.tax)}</b> &nbsp; Total: <b>${fmtMoney(draftTotals.total)}</b></div>
    </form>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Customer</th><th>Date</th><th>System</th><th>Result</th><th></th></tr></thead>
      <tbody>
        ${state.inquiries.length ? state.inquiries.map((q) => {
          const key = "inquiries:" + q.id;
          const open = !!state.expanded[key];
          const resultLabel = q.wo_number ? `WO ${q.wo_number}` : q.quote_number ? `Quote ${q.quote_number}` : pill("Open", "pending");
          const canConvert = !q.wo_id && !q.quote_id;
          return `
          <tr class="clickable" onclick="App.toggle('inquiries','${q.id}')">
            <td>${esc(q.inquiry_number)}</td><td>${esc(q.customer)}</td><td>${fmtDate(q.inquiry_date)}</td>
            <td>${esc(q.accounting_system) || "—"}</td><td>${resultLabel}</td>
            <td onclick="event.stopPropagation()">${canConvert ? `
              <button class="btn btn-ghost btn-sm" onclick="App.convertInquiry('${q.id}','quotation')">To quotation</button>
              <button class="btn btn-ghost btn-sm" onclick="App.convertInquiry('${q.id}','workorder')">To work order</button>` : ""}
            </td>
          </tr>
          ${open ? `<tr><td colspan="6">${renderTasksEditor("Inquiry", q.id, q.discount, q.accounting_system, false)}</td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="6" class="empty-state">No inquiries yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------- Quotations

function renderQuotations() {
  return `
  <h2 class="page-title">Quotations</h2>
  <p class="page-sub">Quotations come from Inquiries — convert an inquiry to a quotation there. Accepting one here creates its work order automatically.</p>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Customer</th><th>Date</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.quotations.length ? state.quotations.map((q) => {
          const key = "quotations:" + q.id;
          const open = !!state.expanded[key];
          return `
          <tr class="clickable" onclick="App.toggle('quotations','${q.id}')">
            <td>${esc(q.quote_number)}</td><td>${esc(q.customer)}</td><td>${fmtDate(q.quote_date)}</td>
            <td>${statusPillForQuote(q.status)}${q.wo_number ? ` → WO ${esc(q.wo_number)}` : ""}</td>
            <td onclick="event.stopPropagation()">${q.status === "Pending" ? `
              <button class="btn btn-ghost btn-sm" onclick="App.acceptQuotation('${q.id}')">Accept</button>
              <button class="btn btn-ghost btn-sm" onclick="App.rejectQuotation('${q.id}')">Reject</button>` : ""}
            </td>
          </tr>
          ${open ? `<tr><td colspan="5">${renderTasksEditor("Quotation", q.id, q.discount, q.accounting_system, false)}</td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="5" class="empty-state">No quotations yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}
function statusPillForQuote(s) {
  return pill(s, { Pending: "pending", Accepted: "accepted", Rejected: "rejected" }[s] || "pending");
}

// ---------------------------------------------------------- Work Orders

function renderWorkOrders() {
  return `
  <h2 class="page-title">Work Orders</h2>
  <p class="page-sub">Work orders come from Inquiries — convert one directly, or accept its Quotation. Line items are fixed the moment a work order is created — no one can add or remove one afterward. Mark each item Delivered as it's finished; once every item on an order is Delivered, its invoice and revenue posting happen by themselves, and a Delivered item's status is then locked for good.</p>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Customer</th><th>Date</th><th>Status</th><th>Invoice</th><th></th></tr></thead>
      <tbody>
        ${state.workOrders.length ? state.workOrders.map((w) => {
          const key = "workorders:" + w.id;
          const open = !!state.expanded[key];
          const inv = state.invoices.find((i) => i.wo_id === w.id);
          return `
          <tr class="clickable" onclick="App.toggle('workorders','${w.id}')">
            <td>${esc(w.wo_number)}</td><td>${esc(w.customer)}</td><td>${fmtDate(w.wo_date)}</td>
            <td>${w.cancelled ? pill("Cancelled", "cancelled") : statusPill(w.status)}</td>
            <td>${inv ? esc(inv.invoice_number) + " " + pill(inv.payment_status, inv.payment_status === "Paid" ? "paid" : "unpaid") : "—"}</td>
            <td onclick="event.stopPropagation()">${!w.cancelled ? `<button class="btn btn-ghost btn-sm" onclick="App.cancelWorkOrder('${w.id}')">Cancel</button>` : ""}</td>
          </tr>
          ${open ? `<tr><td colspan="6">${renderTasksEditor("Work Order", w.id, w.discount, w.accounting_system, true)}</td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="6" class="empty-state">No work orders yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------- Invoices

function renderInvoices() {
  return `
  <h2 class="page-title">Invoices</h2>
  <p class="page-sub">Invoices appear here automatically once a work order is fully delivered.</p>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Work order</th><th>Customer</th><th>Date</th><th class="right">Total (SAR)</th><th>Status</th>${isMgmt() ? "<th>Mark paid</th>" : ""}</tr></thead>
      <tbody>
        ${state.invoices.length ? state.invoices.map((inv) => {
          const wo = state.workOrders.find((w) => w.id === inv.wo_id);
          const tasks = wo ? (state.tasksByParent[wo.id] || null) : null;
          const total = tasks ? taskTotals(tasks, wo.discount, wo.accounting_system).total : null;
          return `
          <tr>
            <td>${esc(inv.invoice_number)}</td><td>${wo ? esc(wo.wo_number) : "—"}</td><td>${esc(inv.customer)}</td>
            <td>${fmtDate(inv.invoice_date)}</td>
            <td class="right">${total !== null ? fmtMoney(total) : `<button class="link-btn" onclick="App.toggle('workorders','${wo ? wo.id : ""}');App.nav('workorders')">view on work order</button>`}</td>
            <td>${pill(inv.payment_status, inv.payment_status === "Paid" ? "paid" : "unpaid")}${inv.paid_at ? `<div class="subtle">${fmtDateTime(inv.paid_at)}</div>` : ""}</td>
            ${isMgmt() ? `<td>${inv.payment_status === "Unpaid" ? `
              <select onchange="App.markInvoicePaid('${inv.id}',event)">
                <option value="">Pick bank…</option>
                ${state.bankAccounts.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
              </select>` : (inv.paid_from ? esc((state.bankAccounts.find((b) => b.id === inv.paid_from) || {}).name || "") : "")}</td>` : ""}
          </tr>`;
        }).join("") : `<tr><td colspan="${isMgmt() ? 7 : 6}" class="empty-state">No invoices yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------- Expenses

function expensePillCls(status) {
  return { Pending: "pending", Approved: "accepted", Rejected: "rejected" }[status] || "pending";
}
function renderExpenses() {
  return `
  <h2 class="page-title">Expenses</h2>
  <p class="page-sub">Every expense needs approving, then paying — paying it is what posts it to the ledger and deducts it from the bank.</p>
  <div class="card">
    <h3>New expense</h3>
    <form onsubmit="return App.addExpense(event)">
      <div class="form-row">
        <div class="field"><label>Date</label><input type="date" name="expense_date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Category</label><input name="category" placeholder="Fuel, Rent, Supplies…"></div>
        <div class="field"><label>Vendor</label><input name="vendor"></div>
        <div class="field"><label>Type</label><select name="cost_type"><option value="Direct Cost">Direct Cost</option><option value="Overhead" selected>Overhead</option></select></div>
        <div class="field"><label>Amount (SAR)</label><input name="amount" type="number" step="0.01" min="0.01" required></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>Description</label><input name="description"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add</button></div>
      </div>
    </form>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Date</th><th>Category</th><th>Vendor</th><th class="right">Amount</th><th>Status</th><th>Payment</th><th></th></tr></thead>
      <tbody>
        ${state.expenses.length ? state.expenses.map((e) => `
          <tr>
            <td>${esc(e.expense_number)}</td><td>${fmtDate(e.expense_date)}</td><td>${esc(e.category)}</td><td>${esc(e.vendor)}</td>
            <td class="right">${fmtMoney(e.amount)}</td>
            <td>${pill(e.status, expensePillCls(e.status))}</td>
            <td>${e.status === "Approved" ? pill(e.payment_status, e.payment_status === "Paid" ? "paid" : "unpaid") : "—"}</td>
            <td>
              ${e.status === "Pending" ? `
                <button class="btn btn-ghost btn-sm" onclick="App.approveExpense('${e.id}')">Approve</button>
                <button class="btn btn-ghost btn-sm" onclick="App.rejectExpense('${e.id}')">Reject</button>` : ""}
              ${e.status === "Approved" && e.payment_status === "Unpaid" ? `
                <select onchange="App.payExpense('${e.id}',event)">
                  <option value="">Pay from…</option>
                  ${state.bankAccounts.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
                </select>` : ""}
            </td>
          </tr>`).join("") : `<tr><td colspan="8" class="empty-state">No expenses yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// --------------------------------------------------------------- Employees

function renderEmployees() {
  return `
  <h2 class="page-title">Employees</h2>
  <p class="page-sub">The people you run payroll for.</p>
  <div class="card">
    <h3>Add an employee</h3>
    <form onsubmit="return App.addEmployee(event)">
      <div class="form-row">
        <div class="field"><label>Name *</label><input name="name" required></div>
        <div class="field"><label>Role</label><input name="role"></div>
        <div class="field"><label>Monthly salary (SAR)</label><input name="monthly_salary" type="number" step="0.01" min="0"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add</button></div>
      </div>
    </form>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>Name</th><th>Role</th><th class="right">Monthly salary</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.employees.length ? state.employees.map((e) => `
          <tr>
            <td>${esc(e.name)}</td><td>${esc(e.role)}</td><td class="right">${e.monthly_salary !== null ? fmtMoney(e.monthly_salary) : "—"}</td>
            <td>${e.active ? pill("Active", "delivered") : pill("Inactive", "cancelled")}</td>
            <td><button class="link-btn" onclick="App.toggleEmployeeActive('${e.id}',${e.active})">${e.active ? "deactivate" : "reactivate"}</button></td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty-state">No employees yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ----------------------------------------------------------------- Payroll

function payrollPillCls(status) {
  return { Draft: "pending", Approved: "process", Paid: "paid" }[status] || "pending";
}
function renderPayroll() {
  const activeEmployees = state.employees.filter((e) => e.active);
  return `
  <h2 class="page-title">Payroll</h2>
  <p class="page-sub">Create a run for the period, add each employee's line, approve it, then pay it — paying is what posts it to the ledger.</p>
  <div class="card">
    <h3>New payroll run</h3>
    <form onsubmit="return App.addPayrollRun(event)">
      <div class="form-row">
        <div class="field"><label>Period</label><input name="period" placeholder="e.g. 2026-09" required></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Create run</button></div>
      </div>
    </form>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Period</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.payrollRuns.length ? state.payrollRuns.map((r) => {
          const key = "payroll:" + r.id;
          const open = !!state.expanded[key];
          const lines = state.payrollLinesByRun[r.id] || [];
          const netTotal = lines.reduce((s, l) => s + Number(l.net_pay || 0), 0);
          return `
          <tr class="clickable" onclick="App.toggle('payroll','${r.id}')">
            <td>${esc(r.pr_number)}</td><td>${esc(r.period)}</td><td>${pill(r.status, payrollPillCls(r.status))}</td>
            <td onclick="event.stopPropagation()">
              ${r.status === "Draft" ? `<button class="btn btn-ghost btn-sm" onclick="App.approvePayrollRun('${r.id}')">Approve</button>` : ""}
              ${r.status === "Approved" ? `
                <select onchange="App.payPayrollRun('${r.id}',event)">
                  <option value="">Pay from…</option>
                  ${state.bankAccounts.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
                </select>` : ""}
            </td>
          </tr>
          ${open ? `<tr><td colspan="4"><div class="wo-detail">
            <table>
              <thead><tr><th>Employee</th><th class="right">Gross</th><th class="right">Net pay</th><th></th></tr></thead>
              <tbody>
                ${lines.length ? lines.map((l) => `
                  <tr><td>${esc(l.employee_name)}</td><td class="right">${fmtMoney(l.gross_salary)}</td><td class="right">${fmtMoney(l.net_pay)}</td>
                  <td>${r.status === "Draft" ? `<button class="link-btn" onclick="App.deletePayrollLine('${l.id}','${r.id}')">remove</button>` : ""}</td></tr>
                `).join("") : `<tr><td colspan="4" class="empty-state">No lines yet.</td></tr>`}
              </tbody>
            </table>
            ${r.status === "Draft" ? `
              <form class="form-row" style="margin-top:10px" onsubmit="return App.addPayrollLine('${r.id}',event)">
                <div class="field"><label>Employee</label><select name="employee_id" required>
                  <option value="">— pick —</option>
                  ${activeEmployees.map((e) => `<option value="${e.id}">${esc(e.name)}${e.monthly_salary ? " — " + fmtMoney(e.monthly_salary) : ""}</option>`).join("")}
                </select></div>
                <div class="field"><label>Gross (SAR)</label><input name="gross_salary" type="number" step="0.01" min="0" placeholder="defaults to salary"></div>
                <div class="field"><label>Net pay (SAR)</label><input name="net_pay" type="number" step="0.01" min="0" placeholder="defaults to gross"></div>
                <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" type="submit">Add line</button></div>
              </form>` : ""}
            <div class="totals-line">Net total: <b>${fmtMoney(netTotal)}</b></div>
          </div></td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="4" class="empty-state">No payroll runs yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ------------------------------------------------------------ Fixed Assets

function renderFixedAssets() {
  return `
  <h2 class="page-title">Fixed Assets</h2>
  <p class="page-sub">Recording a purchase posts it to the ledger immediately. Depreciation runs once a month, on demand.</p>
  <div class="card">
    <h3>Record a purchase</h3>
    <form onsubmit="return App.addFixedAsset(event)">
      <div class="form-row">
        <div class="field"><label>Name *</label><input name="name" required></div>
        <div class="field"><label>Category</label><input name="category"></div>
        <div class="field"><label>Cost (SAR)</label><input name="cost" type="number" step="0.01" min="0.01" required></div>
        <div class="field"><label>Purchase date</label><input type="date" name="purchase_date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Useful life (months)</label><input name="useful_life_months" type="number" step="1" min="1" value="36"></div>
        <div class="field"><label>Paid from *</label><select name="paid_from" required>
          <option value="">— pick bank —</option>
          ${state.bankAccounts.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
        </select></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add</button></div>
      </div>
    </form>
  </div>
  <div class="card">
    <div class="form-row" style="margin-bottom:12px">
      <button class="btn btn-ghost btn-sm" onclick="App.runDepreciation()">Run this month's depreciation</button>
      <span class="subtle">Safe to click any time — each asset only depreciates once per calendar month.</span>
    </div>
    <table>
      <thead><tr><th>No.</th><th>Name</th><th>Category</th><th class="right">Cost</th><th class="right">Accum. depr.</th><th class="right">Book value</th><th>Status</th></tr></thead>
      <tbody>
        ${state.fixedAssets.length ? state.fixedAssets.map((a) => `
          <tr>
            <td>${esc(a.asset_number)}</td><td>${esc(a.name)}</td><td>${esc(a.category)}</td>
            <td class="right">${fmtMoney(a.cost)}</td><td class="right">${fmtMoney(a.accumulated_depreciation)}</td>
            <td class="right">${fmtMoney(Number(a.cost) - Number(a.accumulated_depreciation || 0))}</td>
            <td>${a.status === "Active" ? pill("Active", "delivered") : pill("Disposed", "cancelled")}</td>
          </tr>`).join("") : `<tr><td colspan="7" class="empty-state">No fixed assets yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------- Chart of Accounts

function renderChartOfAccounts() {
  const owner = isOwner();
  return `
  <h2 class="page-title">Chart of Accounts</h2>
  <p class="page-sub">Every account everything else in Finance posts against. Balances are live, as of right now.${owner ? "" : " Only the Owner can add or rename accounts."}</p>
  ${owner ? `
  <div class="card">
    <h3>Add account</h3>
    <form onsubmit="return App.addChartAccount(event)">
      <div class="form-row">
        <div class="field"><label>Code</label><input name="code" placeholder="e.g. 2300" required></div>
        <div class="field"><label>Name</label><input name="name" required></div>
        <div class="field"><label>Type</label>
          <select name="account_type" required>
            <option value="">— pick —</option>
            ${["Asset", "ContraAsset", "Liability", "Equity", "ContraEquity", "Revenue", "Expense"].map((t) => `<option value="${t}">${t}</option>`).join("")}
          </select>
        </div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add</button></div>
      </div>
    </form>
  </div>` : ""}
  <div class="card">
    <table>
      <thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="right">Balance (SAR)</th><th></th></tr></thead>
      <tbody>
        ${state.accountBalances.length ? state.accountBalances.slice().sort((a, b) => a.code.localeCompare(b.code)).map((a) => `
          <tr>
            <td>${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(a.account_type)}</td>
            <td class="right">${fmtMoney(a.balance)}</td>
            <td><button class="link-btn" onclick="App.viewAccountLedger('${a.code}')">view ledger</button></td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty-state">No accounts yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------- Bank Accounts

function renderBankAccounts() {
  return `
  <h2 class="page-title">Bank Accounts</h2>
  <p class="page-sub">Cash balances update live as invoices are paid, and as expenses, payroll and asset purchases are paid out.</p>
  <div class="card">
    <table>
      <thead><tr><th>Account</th><th>Type</th><th>Number</th><th class="right">Current balance (SAR)</th><th></th></tr></thead>
      <tbody>
        ${state.bankBalances.length ? state.bankBalances.map((b) => {
          const acc = state.bankAccounts.find((x) => x.id === b.id) || {};
          return `<tr><td>${esc(b.name)}</td><td>${esc(acc.account_type)}</td><td>${esc(acc.account_number)}</td><td class="right">${fmtMoney(b.current_balance)}</td>
            <td><button class="link-btn" onclick="App.viewAccountLedger('CASH-${b.id}')">view ledger</button></td></tr>`;
        }).join("") : `<tr><td colspan="5" class="empty-state">No bank accounts yet.</td></tr>`}
      </tbody>
    </table>
    <form class="form-row" style="margin-top:14px" onsubmit="return App.addBankAccount(event)">
      <div class="field"><label>Add bank — name</label><input name="name" required></div>
      <div class="field"><label>Type</label><input name="account_type" placeholder="Current / Savings"></div>
      <div class="field"><label>Account number</label><input name="account_number"></div>
      <div class="field"><label>Opening balance (SAR)</label><input name="opening_balance" type="number" step="0.01" value="0"></div>
      <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" type="submit">Add</button></div>
    </form>
  </div>`;
}

// ---------------------------------------------------------- Journal Entries

function renderJournalEntries() {
  if (!state.jeDraft) state.jeDraft = freshJeDraft();
  const d = state.jeDraft;
  const t = jeDraftTotals();
  return `
  <h2 class="page-title">Journal Entries</h2>
  <p class="page-sub">Manual entries for anything that doesn't post itself — corrections, accruals, opening balances. Every entry must balance before it posts, and can't be dated inside a closed period.</p>
  <div class="card">
    <h3>New journal entry</h3>
    <form onsubmit="return App.postJournalEntry(event)">
      <div class="form-row">
        <div class="field"><label>Date</label><input type="date" value="${esc(d.je_date)}" oninput="App.setJeField('je_date',this.value)"></div>
        <div class="field" style="flex:3"><label>Memo</label><input value="${esc(d.memo)}" oninput="App.setJeField('memo',this.value)" placeholder="What is this entry for?"></div>
      </div>
      <table style="margin-top:12px">
        <thead><tr><th>Account</th><th class="right">Debit (SAR)</th><th class="right">Credit (SAR)</th><th></th></tr></thead>
        <tbody>
          ${d.lines.map((l, idx) => `
          <tr>
            <td><select onchange="App.setJeLineField(${idx},'account_code',this.value)">${glAccountOptions(l.account_code)}</select></td>
            <td class="right"><input type="number" step="0.01" min="0" style="width:120px" value="${esc(l.debit)}" oninput="App.setJeLineField(${idx},'debit',this.value)"></td>
            <td class="right"><input type="number" step="0.01" min="0" style="width:120px" value="${esc(l.credit)}" oninput="App.setJeLineField(${idx},'credit',this.value)"></td>
            <td>${d.lines.length > 2 ? `<button type="button" class="link-btn" onclick="App.removeJeLineRow(${idx})">remove</button>` : ""}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="App.addJeLineRow()">+ Add another line</button>
      <div class="form-row" style="margin-top:14px">
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Post entry</button></div>
      </div>
      <div class="totals-line" id="jeDraftTotals">Total debit: <b>${fmtMoney(t.debit)}</b> &nbsp; Total credit: <b>${fmtMoney(t.credit)}</b> &nbsp;
        <span class="balance-flag ${t.balanced ? "ok" : "bad"}">${t.balanced ? "Balanced" : "Not balanced"}</span></div>
    </form>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Date</th><th>Memo</th><th>Source</th><th></th></tr></thead>
      <tbody>
        ${state.journalEntries.length ? state.journalEntries.map((je) => {
          const key = "journalentries:" + je.id;
          const open = !!state.expanded[key];
          const lines = state.journalLinesByJe[je.id] || [];
          return `
          <tr class="clickable" onclick="App.toggle('journalentries','${je.id}')">
            <td>${esc(je.je_number)}</td><td>${fmtDate(je.je_date)}</td><td>${esc(je.memo)}</td>
            <td>${je.source === "manual" ? pill("Manual", "pending") : esc(je.source)}</td>
            <td><button class="link-btn" onclick="event.stopPropagation();App.toggle('journalentries','${je.id}')">${open ? "close" : "view lines"}</button></td>
          </tr>
          ${open ? `<tr><td colspan="5"><div class="wo-detail">
            <table>
              <thead><tr><th>Account</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead>
              <tbody>
                ${lines.length ? lines.map((l) => `<tr><td>${esc(l.account_code)}</td><td class="right">${fmtMoney(l.debit)}</td><td class="right">${fmtMoney(l.credit)}</td></tr>`).join("") : `<tr><td colspan="3" class="empty-state">Loading…</td></tr>`}
              </tbody>
            </table>
          </div></td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="5" class="empty-state">No journal entries yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------- General Ledger

function renderGeneralLedger() {
  const q = state.glQuery;
  return `
  <h2 class="page-title">General Ledger</h2>
  <p class="page-sub">Pick an account to see every entry posted to it, with a running balance.</p>
  <div class="card">
    <form class="form-row" onsubmit="return App.runGlQuery(event)">
      <div class="field"><label>Account</label><select onchange="App.setGlAccount(this.value)">${glAccountOptions(q.account)}</select></div>
      <div class="field"><label>From</label><input type="date" value="${esc(q.from)}" oninput="App.setGlField('from',this.value)"></div>
      <div class="field"><label>To</label><input type="date" value="${esc(q.to)}" oninput="App.setGlField('to',this.value)"></div>
      <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" type="submit">Filter</button></div>
    </form>
  </div>
  <div class="card">
    ${!q.account ? `<div class="empty-state">Pick an account above.</div>` : `
    <table>
      <thead><tr><th>No.</th><th>Date</th><th>Memo</th><th>Source</th><th class="right">Debit</th><th class="right">Credit</th><th class="right">Balance</th></tr></thead>
      <tbody>
        ${state.glRows.length ? state.glRows.map((r) => `
          <tr><td>${esc(r.je_number)}</td><td>${fmtDate(r.je_date)}</td><td>${esc(r.memo)}</td><td>${esc(r.source)}</td>
          <td class="right">${Number(r.debit) ? fmtMoney(r.debit) : "—"}</td><td class="right">${Number(r.credit) ? fmtMoney(r.credit) : "—"}</td>
          <td class="right">${fmtMoney(r.running_balance)}</td></tr>
        `).join("") : `<tr><td colspan="7" class="empty-state">No activity on this account${q.from || q.to ? " in this range" : ""}.</td></tr>`}
      </tbody>
    </table>`}
  </div>`;
}

// -------------------------------------------------------------- Trial Balance

function renderTrialBalance() {
  const asOf = state.statementDates.trialbalance.asOf;
  const rows = state.trialBalanceRows;
  const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
  const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
  return `
  <h2 class="page-title">Trial Balance</h2>
  <div class="card">
    <form class="statement-meta" onsubmit="return App.runStatement('trialbalance',event)">
      <div class="field"><label>As of</label><input type="date" value="${esc(asOf)}" oninput="App.setStatementDate('trialbalance','asOf',this.value)"></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="submit">Run</button></div>
    </form>
    <div class="statement-head"><div class="co">US ServTech</div><div class="title">Trial Balance</div><div class="period">As of ${fmtDate(asOf)}</div></div>
    <table>
      <thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead>
      <tbody>
        ${rows.length ? rows.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(r.account_type)}</td>
          <td class="right">${Number(r.debit) ? fmtMoney(r.debit) : "—"}</td><td class="right">${Number(r.credit) ? fmtMoney(r.credit) : "—"}</td></tr>`).join("")
          : `<tr><td colspan="5" class="empty-state">No activity as of this date.</td></tr>`}
        <tr class="total-row"><td colspan="3">Total</td><td class="right">${fmtMoney(totalDebit)}</td><td class="right">${fmtMoney(totalCredit)}</td></tr>
      </tbody>
    </table>
    <div style="margin-top:10px"><span class="balance-flag ${balanced ? "ok" : "bad"}">${balanced ? "Balanced" : "Out of balance — check recent postings"}</span></div>
  </div>`;
}

// ---------------------------------------------------------- Income Statement

function renderIncomeStatement() {
  const { from, to } = state.statementDates.incomestatement;
  const rows = state.incomeStatementRows;
  const revenue = rows.filter((r) => r.account_type === "Revenue");
  const expense = rows.filter((r) => r.account_type === "Expense");
  const totalRevenue = revenue.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalExpense = expense.reduce((s, r) => s + Number(r.amount || 0), 0);
  const netIncome = totalRevenue - totalExpense;
  return `
  <h2 class="page-title">Income Statement</h2>
  <div class="card">
    <form class="statement-meta" onsubmit="return App.runStatement('incomestatement',event)">
      <div class="field"><label>From</label><input type="date" value="${esc(from)}" oninput="App.setStatementDate('incomestatement','from',this.value)"></div>
      <div class="field"><label>To</label><input type="date" value="${esc(to)}" oninput="App.setStatementDate('incomestatement','to',this.value)"></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="submit">Run</button></div>
    </form>
    <div class="statement-head"><div class="co">US ServTech</div><div class="title">Income Statement</div><div class="period">${fmtDate(from)} – ${fmtDate(to)}</div></div>
    <table>
      <thead><tr><th colspan="2">Revenue</th></tr></thead>
      <tbody>
        ${revenue.length ? revenue.map((r) => `<tr><td class="indent">${esc(r.name)}</td><td class="right">${fmtMoney(r.amount)}</td></tr>`).join("") : `<tr><td class="indent empty-state" colspan="2">No revenue in this period.</td></tr>`}
        <tr class="subtotal-row"><td>Total revenue</td><td class="right">${fmtMoney(totalRevenue)}</td></tr>
      </tbody>
      <thead><tr><th colspan="2">Expenses</th></tr></thead>
      <tbody>
        ${expense.length ? expense.map((r) => `<tr><td class="indent">${esc(r.name)}</td><td class="right">${fmtMoney(r.amount)}</td></tr>`).join("") : `<tr><td class="indent empty-state" colspan="2">No expenses in this period.</td></tr>`}
        <tr class="subtotal-row"><td>Total expenses</td><td class="right">${fmtMoney(totalExpense)}</td></tr>
      </tbody>
      <tbody><tr class="total-row"><td>Net income</td><td class="right">${fmtMoney(netIncome)}</td></tr></tbody>
    </table>
  </div>`;
}

// ------------------------------------------------------------- Balance Sheet

function renderBalanceSheet() {
  const asOf = state.statementDates.balancesheet.asOf;
  const rows = state.balanceSheetRows;
  const assets = rows.filter((r) => r.account_type === "Asset" || r.account_type === "ContraAsset");
  const liabilities = rows.filter((r) => r.account_type === "Liability");
  const equity = rows.filter((r) => (r.account_type === "Equity" || r.account_type === "ContraEquity") && r.code !== "3100");
  const assetAmt = (r) => r.account_type === "ContraAsset" ? -(Number(r.credit || 0) - Number(r.debit || 0)) : Number(r.debit || 0) - Number(r.credit || 0);
  const creditAmt = (r) => Number(r.credit || 0) - Number(r.debit || 0);
  const totalAssets = assets.reduce((s, r) => s + assetAmt(r), 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + creditAmt(r), 0);
  const equityFromAccounts = equity.reduce((s, r) => s + creditAmt(r), 0);
  const netIncome = Number(state.balanceSheetNetIncome || 0);
  const totalEquity = equityFromAccounts + netIncome;
  const balanced = Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01;
  return `
  <h2 class="page-title">Balance Sheet</h2>
  <div class="card">
    <form class="statement-meta" onsubmit="return App.runStatement('balancesheet',event)">
      <div class="field"><label>As of</label><input type="date" value="${esc(asOf)}" oninput="App.setStatementDate('balancesheet','asOf',this.value)"></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="submit">Run</button></div>
    </form>
    <div class="statement-head"><div class="co">US ServTech</div><div class="title">Balance Sheet</div><div class="period">As of ${fmtDate(asOf)}</div></div>
    <table>
      <thead><tr><th colspan="2">Assets</th></tr></thead>
      <tbody>
        ${assets.length ? assets.map((r) => `<tr><td class="indent">${esc(r.name)}</td><td class="right">${assetAmt(r) < 0 ? "(" + fmtMoney(-assetAmt(r)) + ")" : fmtMoney(assetAmt(r))}</td></tr>`).join("") : `<tr><td class="indent empty-state" colspan="2">No asset activity.</td></tr>`}
        <tr class="subtotal-row"><td>Total assets</td><td class="right">${fmtMoney(totalAssets)}</td></tr>
      </tbody>
      <thead><tr><th colspan="2">Liabilities</th></tr></thead>
      <tbody>
        ${liabilities.length ? liabilities.map((r) => `<tr><td class="indent">${esc(r.name)}</td><td class="right">${fmtMoney(creditAmt(r))}</td></tr>`).join("") : `<tr><td class="indent empty-state" colspan="2">No liabilities.</td></tr>`}
        <tr class="subtotal-row"><td>Total liabilities</td><td class="right">${fmtMoney(totalLiabilities)}</td></tr>
      </tbody>
      <thead><tr><th colspan="2">Equity</th></tr></thead>
      <tbody>
        ${equity.map((r) => `<tr><td class="indent">${esc(r.name)}</td><td class="right">${fmtMoney(creditAmt(r))}</td></tr>`).join("")}
        <tr><td class="indent">Retained earnings (cumulative net income)</td><td class="right">${fmtMoney(netIncome)}</td></tr>
        <tr class="subtotal-row"><td>Total equity</td><td class="right">${fmtMoney(totalEquity)}</td></tr>
      </tbody>
      <tbody><tr class="total-row"><td>Total liabilities &amp; equity</td><td class="right">${fmtMoney(totalLiabilities + totalEquity)}</td></tr></tbody>
    </table>
    <div style="margin-top:10px"><span class="balance-flag ${balanced ? "ok" : "bad"}">${balanced ? "Balanced" : "Out of balance"}</span>
      <span class="subtle" style="margin-left:8px">Retained earnings is computed from all-time net income since there's no year-end closing step — see Income Statement for the breakdown.</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------- Cash Flow Statement

function renderCashFlow() {
  const { from, to } = state.statementDates.cashflow;
  const rows = state.cashFlowRows;
  const byCategory = { Operating: [], Investing: [], Financing: [] };
  rows.forEach((r) => { (byCategory[r.category] || (byCategory[r.category] = [])).push(r); });
  const catTotal = (cat) => (byCategory[cat] || []).reduce((s, r) => s + Number(r.amount || 0), 0);
  const netChange = ["Operating", "Investing", "Financing"].reduce((s, c) => s + catTotal(c), 0);
  const begin = Number(state.cashFlowBeginCash || 0), end = Number(state.cashFlowEndCash || 0);
  const reconciles = Math.abs((begin + netChange) - end) < 0.01;
  const section = (cat, label) => `
    <thead><tr><th colspan="3">${label}</th></tr></thead>
    <tbody>
      ${(byCategory[cat] || []).length ? byCategory[cat].map((r) => `<tr><td class="indent">${esc(r.memo)}</td><td>${fmtDate(r.je_date)}</td><td class="right">${fmtMoney(r.amount)}</td></tr>`).join("")
        : `<tr><td class="indent empty-state" colspan="3">No ${label.toLowerCase()} activity.</td></tr>`}
      <tr class="subtotal-row"><td colspan="2">Net cash from ${label.toLowerCase()}</td><td class="right">${fmtMoney(catTotal(cat))}</td></tr>
    </tbody>`;
  return `
  <h2 class="page-title">Cash Flow Statement</h2>
  <div class="card">
    <form class="statement-meta" onsubmit="return App.runStatement('cashflow',event)">
      <div class="field"><label>From</label><input type="date" value="${esc(from)}" oninput="App.setStatementDate('cashflow','from',this.value)"></div>
      <div class="field"><label>To</label><input type="date" value="${esc(to)}" oninput="App.setStatementDate('cashflow','to',this.value)"></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="submit">Run</button></div>
    </form>
    <div class="statement-head"><div class="co">US ServTech</div><div class="title">Cash Flow Statement — Direct Method</div><div class="period">${fmtDate(from)} – ${fmtDate(to)}</div></div>
    <table>
      ${section("Operating", "Operating activities")}
      ${section("Investing", "Investing activities")}
      ${section("Financing", "Financing activities")}
      <tbody>
        <tr class="total-row"><td colspan="2">Net change in cash</td><td class="right">${fmtMoney(netChange)}</td></tr>
        <tr><td colspan="2">Cash at start of period</td><td class="right">${fmtMoney(begin)}</td></tr>
        <tr class="total-row"><td colspan="2">Cash at end of period</td><td class="right">${fmtMoney(end)}</td></tr>
      </tbody>
    </table>
    <div style="margin-top:10px"><span class="balance-flag ${reconciles ? "ok" : "bad"}">${reconciles ? "Reconciles" : "Does not reconcile — check for postings outside this range"}</span></div>
  </div>`;
}

// -------------------------------------------------------------------- AR Aging

function renderARAging() {
  const rowsData = state.arInvoices.map((inv) => {
    const wo = state.arWoById[inv.wo_id] || {};
    const tasks = state.arTasksByInvoice[inv.id] || [];
    const total = taskTotals(tasks, wo.discount, wo.accounting_system).total;
    return { inv, total, bucket: agingBucket(inv.invoice_date) };
  });
  const bucketTotal = (b) => rowsData.filter((r) => r.bucket === b).reduce((s, r) => s + r.total, 0);
  const grandTotal = rowsData.reduce((s, r) => s + r.total, 0);
  return `
  <h2 class="page-title">AR Aging</h2>
  <p class="page-sub">Unpaid invoices, grouped by how long they've been outstanding since the invoice date.</p>
  <div class="kpi-grid">
    ${AGING_BUCKETS.map((b) => `<div class="kpi"><div class="label">${b}</div><div class="value">${fmtMoney(bucketTotal(b))}</div></div>`).join("")}
    <div class="kpi accent"><div class="label">Total outstanding</div><div class="value">${fmtMoney(grandTotal)}</div></div>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>Invoice</th><th>Customer</th><th>Invoice date</th><th>Bucket</th><th class="right">Amount (SAR)</th></tr></thead>
      <tbody>
        ${rowsData.length ? rowsData.map((r) => `
          <tr><td>${esc(r.inv.invoice_number)}</td><td>${esc(r.inv.customer)}</td><td>${fmtDate(r.inv.invoice_date)}</td>
          <td>${pill(r.bucket, agingPillCls(r.bucket))}</td>
          <td class="right">${fmtMoney(r.total)}</td></tr>`).join("") : `<tr><td colspan="5" class="empty-state">Nothing outstanding — every invoice is paid.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// -------------------------------------------------------------------- AP Aging

function renderAPAging() {
  const rowsData = [
    ...state.apExpenses.map((e) => ({ type: "Expense", number: e.expense_number, who: e.vendor || e.category || "—", date: e.expense_date, amount: Number(e.amount || 0) })),
    ...state.apPayrollRuns.map((r) => ({ type: "Payroll", number: r.pr_number, who: "Period " + r.period, date: (r.approved_at || r.created_at || "").slice(0, 10), amount: Number(state.apPayrollNetByRun[r.id] || 0) })),
  ].map((r) => ({ ...r, bucket: agingBucket(r.date) }));
  const bucketTotal = (b) => rowsData.filter((r) => r.bucket === b).reduce((s, r) => s + r.amount, 0);
  const grandTotal = rowsData.reduce((s, r) => s + r.amount, 0);
  return `
  <h2 class="page-title">AP Aging</h2>
  <p class="page-sub">Approved but unpaid expenses and payroll runs — what the company currently owes.</p>
  <div class="kpi-grid">
    ${AGING_BUCKETS.map((b) => `<div class="kpi"><div class="label">${b}</div><div class="value">${fmtMoney(bucketTotal(b))}</div></div>`).join("")}
    <div class="kpi accent"><div class="label">Total payable</div><div class="value">${fmtMoney(grandTotal)}</div></div>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>Type</th><th>No.</th><th>Vendor / Period</th><th>Date</th><th>Bucket</th><th class="right">Amount (SAR)</th></tr></thead>
      <tbody>
        ${rowsData.length ? rowsData.map((r) => `
          <tr><td>${esc(r.type)}</td><td>${esc(r.number)}</td><td>${esc(r.who)}</td><td>${fmtDate(r.date)}</td>
          <td>${pill(r.bucket, agingPillCls(r.bucket))}</td>
          <td class="right">${fmtMoney(r.amount)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty-state">Nothing payable right now.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ----------------------------------------------------------------- Period Close

function renderPeriodClose() {
  const pd = state.periodDraft;
  return `
  <h2 class="page-title">Period Close</h2>
  <p class="page-sub">Closing a period blocks any new posting dated inside it — for anyone, including the automated postings from work orders, expenses and payroll. Reopen it to make corrections.</p>
  <div class="card">
    <h3>Create a period</h3>
    <form onsubmit="return App.createPeriod(event)">
      <div class="form-row">
        <div class="field"><label>Label</label><input value="${esc(pd.period_label)}" oninput="App.setPeriodField('period_label',this.value)" placeholder="e.g. September 2026" required></div>
        <div class="field"><label>Start date</label><input type="date" value="${esc(pd.start_date)}" oninput="App.setPeriodField('start_date',this.value)" required></div>
        <div class="field"><label>End date</label><input type="date" value="${esc(pd.end_date)}" oninput="App.setPeriodField('end_date',this.value)" required></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Create</button></div>
      </div>
    </form>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>Period</th><th>Start</th><th>End</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.accountingPeriods.length ? state.accountingPeriods.map((p) => `
          <tr>
            <td>${esc(p.period_label)}</td><td>${fmtDate(p.start_date)}</td><td>${fmtDate(p.end_date)}</td>
            <td>${p.status === "Open" ? pill("Open", "open") : pill("Closed", "closed")}</td>
            <td>${p.status === "Open"
              ? `<button class="btn btn-ghost btn-sm" onclick="App.closePeriodAction('${p.id}')">Close</button>`
              : `<button class="btn btn-ghost btn-sm" onclick="App.reopenPeriodAction('${p.id}')">Reopen</button>`}</td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty-state">No accounting periods yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// -------------------------------------------------------------------- go

init();
