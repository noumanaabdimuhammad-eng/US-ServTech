// US ServTech — Operations & Finance
// Vanilla JS single-page app. No build step, no framework.
// Backend: Supabase (Postgres + Auth + Realtime). All numbering, invoice
// generation, revenue posting and ledger balances are computed server-side
// by database triggers/functions. The app is split into two modules —
// Operations (Dashboard through Invoices) and Finance (Chart of Accounts
// through Period Close, plus the Owner-only Team screen) — and five roles:
// Owner and Manager get everything; Operations Staff gets full Operations,
// no Finance; Viewer gets read-only Operations, no Finance; Approver gets
// only Finance's Invoices & Expenses corner (mark invoices paid, approve/
// reject/pay expenses). See OPS_WRITE_ROLES/OPS_VIEW_ROLES/FINANCE_VIEW_ROLES
// below for the exact boundaries. All of it is independently enforced by the
// database's own row-level security on every table — and, for the handful
// of RPCs that bypass RLS by being SECURITY DEFINER, by an explicit role
// check inside each function — so a role calling something directly it
// isn't UI-offered gets nothing back either; this file's gating is for a
// clean UI, not the actual security boundary.
// Automated postings (revenue, payments, expenses, payroll, depreciation)
// still happen entirely server-side via triggers, exactly as before. This
// file adds exactly one way to write a journal entry by hand — the manual
// Journal Entry form, which always saves as a Draft first (save_journal_
// entry_draft / update_journal_entry_draft) and only counts toward any
// financial statement once explicitly posted (post_journal_entry_draft) —
// plus the read-only reporting RPCs (trial_balance, income_statement,
// net_income_to_date, cash_flow_statement, general_ledger), which all
// exclude drafts, and period locking (accounting_periods +
// close/reopen_accounting_period()).

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
// Five roles as of the RBAC rollout: Owner/Manager unchanged (full access to
// everything). Operations Staff = full Operations, no Finance at all. Viewer
// = read-only across Operations, no Finance at all. Approver = Finance only,
// and only its Invoices & Expenses corner (mark invoices paid, approve/
// reject/pay expenses) — no Payroll, Journal Entries, Reports, Chart of
// Accounts management, or Employees. All of this is independently enforced
// by RLS on every table (and, for the handful of RPCs that bypass RLS by
// being SECURITY DEFINER, by an explicit role check inside each function) —
// these helpers just keep the UI from offering controls that would fail.
const OPS_WRITE_ROLES = ["Owner", "Manager", "Operations Staff"];
const OPS_VIEW_ROLES = ["Owner", "Manager", "Operations Staff", "Viewer"];
const FINANCE_VIEW_ROLES = ["Owner", "Manager", "Approver"];
// The only Finance tabs an Approver can reach — see MODULES.finance.groups' "Invoices & Expenses".
const APPROVER_FINANCE_TABS = ["financeinvoices", "cashcollections", "expenses"];
// Every role the Team screen's role picker offers, and every role the
// manage-employee Edge Function accepts on account creation.
const ALL_ROLES = ["Owner", "Manager", "Operations Staff", "Approver", "Viewer"];

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
      { id: "financedashboard", label: "Dashboard" },
      { id: "chartofaccounts", label: "Chart of Accounts" },
      { id: "journalentries", label: "Journal Entries" },
      { id: "generalledger", label: "General Ledger" },
      { id: "bankaccounts", label: "Bank Accounts" },
      { id: "financeinvoices", label: "Invoices" },
      { id: "cashcollections", label: "Cash Collections" },
      { id: "expenses", label: "Expenses" },
      { id: "trialbalance", label: "Trial Balance" },
      { id: "incomestatement", label: "Income Statement" },
      { id: "balancesheet", label: "Balance Sheet" },
      { id: "cashflow", label: "Cash Flow" },
      { id: "araging", label: "AR Aging" },
      { id: "apaging", label: "AP Aging" },
      { id: "assetsliabilities", label: "Assets & Liabilities" },
      { id: "employees", label: "Employees" },
      { id: "payroll", label: "Payroll" },
      { id: "assetregister", label: "Asset Register" },
      { id: "importdata", label: "Import Data" },
      { id: "periodclose", label: "Period Close" },
      { id: "team", label: "Team" },
    ],
    // Odoo-style segregation: the flat tab list above still drives routing
    // (moduleForView, permissions, etc.) — this just groups those same tab
    // ids into labeled clusters for the subnav, so Finance doesn't read as
    // one long flat row. Whichever group contains the current view is the
    // one shown expanded; clicking a group jumps to its first tab.
    groups: [
      { label: "Overview", tabs: ["financedashboard"] },
      { label: "Accounting", tabs: ["chartofaccounts", "journalentries", "generalledger", "bankaccounts"] },
      { label: "Invoices & Expenses", tabs: ["financeinvoices", "cashcollections", "expenses"] },
      { label: "Reports", tabs: ["trialbalance", "incomestatement", "balancesheet", "cashflow", "araging", "apaging", "assetsliabilities"] },
      { label: "Payroll & Assets", tabs: ["employees", "payroll", "assetregister"] },
      { label: "Configuration", tabs: ["importdata", "periodclose", "team"] },
    ],
  },
};
function moduleForView(view) {
  for (const mid of Object.keys(MODULES)) {
    if (MODULES[mid].tabs.some((t) => t.id === view)) return mid;
  }
  return "operations";
}
// Which Finance tab ids the current role may see in the subnav / route to.
// Owner sees everything including Team; Manager sees everything except Team
// (Owner-only, since it manages logins); Approver sees only Invoices &
// Expenses; everyone else sees none (Finance module itself is hidden for them).
function financeVisibleTabIds() {
  if (isOwner()) return MODULES.finance.tabs.map((t) => t.id);
  if (isMgmt()) return MODULES.finance.tabs.map((t) => t.id).filter((id) => id !== "team");
  if (isApprover()) return APPROVER_FINANCE_TABS.slice();
  return [];
}
const AGING_BUCKETS = ["0–30 days", "31–60 days", "61–90 days", "90+ days"];
// Fixed display order for the Chart of Accounts' collapsible groups — matches
// the Add-account type dropdown, and is the order Odoo lists account types in.
const ACCOUNT_TYPES = ["Asset", "ContraAsset", "Liability", "Equity", "ContraEquity", "Revenue", "Expense"];

// Codes several database trigger functions post to directly (revenue
// recognition, depreciation, invoice/payroll payment, asset purchase — see
// maybe_finalize_work_order, run_monthly_depreciation, post_invoice_payment,
// post_payroll_payment, post_asset_purchase). Deleting one of these would
// break those triggers the next time they fire, so the Chart of Accounts
// screen never offers Delete for them — renaming or retyping is still fine.
const SYSTEM_ACCOUNT_CODES = ["1100", "1200", "1250", "2100", "4000", "5100", "5200"];

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
  cashCollections: [],
  selectedCash: {},   // cash_collections.id -> true, for the Cash Collections confirm-screen checkboxes
  expenses: [],
  employees: [],
  team: [],           // profiles list for the Team (employee logins) screen — Owner only
  teamBusy: false,    // true while an Edge Function call (create/deactivate/reactivate/reset) is in flight
  teamError: "",
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
  jeEditingId: null,    // set while editing an existing Draft entry (null = creating a new one)
  jeFilter: { search: "", status: "", from: "", to: "" },
  coaSearch: "",
  coaCollapsed: {},     // account_type -> true when that group is collapsed
  coaEditingCode: null, // code of the account currently shown as an inline edit row (null = none)
  periodDraft: { period_label: "", start_date: "", end_date: "" },
  statementDates: {
    trialbalance: { asOf: new Date().toISOString().slice(0, 10) },
    incomestatement: { from: firstOfThisMonth(), to: new Date().toISOString().slice(0, 10) },
    balancesheet: { asOf: new Date().toISOString().slice(0, 10) },
    cashflow: { from: firstOfThisMonth(), to: new Date().toISOString().slice(0, 10) },
    financedashboard: { from: firstOfThisMonth(), to: new Date().toISOString().slice(0, 10) },
  },
  financeDashboardPreset: "thismonth", // which quick period button is active, or "" once custom dates are run
  financeDashboardMetrics: ["revenue", "expense"], // which KPI tiles are selected onto the trend chart
  financeDashboard: {
    revenue: 0, expense: 0, netIncome: 0, netCashFlow: 0,
    beginCash: 0, endCash: 0, arTotal: 0, apTotal: 0,
    trend: [], // last 6 months: [{ label, revenue, expense, netIncome, netCashFlow, cashOnHand, arOutstanding, apOutstanding }, ...]
  },
  tasksByParent: {},   // parent_id -> [task,...]
  invoiceTasksByInvoice: {}, // invoice_id -> its own copy of line items (see loadInvoiceTasks)
  importPreview: null, // { rows: [...], fileName } — the parsed-but-not-yet-committed Zoho import
  importBusy: false,
  importResult: null,  // { inserted_count, total_amount, skipped: [...] } from the last import
  expanded: {},        // "table:id" -> true
  inquiryDraft: null,  // the in-progress "New inquiry" form — see freshInquiryDraft()
  dashboardKpis: null,
  loading: true,
  authBusy: false,
  authError: "",
  toast: null,
  sidebarOpen: false, // off-canvas sidebar state on narrow screens — ignored by the CSS above the mobile breakpoint
  sidebarCollapsed: false, // desktop icon-only sidebar toggle — persisted below via localStorage
  openSubnavGroup: null, // index into the active module's groups[] whose dropdown is force-open (touch fallback — desktop opens on :hover)
};
// Remembers the collapsed/expanded sidebar choice across visits. Wrapped in
// try/catch since localStorage can throw (private browsing, blocked storage)
// — falling back to the default (expanded) is fine either way.
try { state.sidebarCollapsed = localStorage.getItem("usst_sidebar_collapsed") === "1"; } catch (e) {}

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
function isApprover() {
  return state.profile && state.profile.role === "Approver";
}
// Can write to Operations tables (customers, inquiries, quotations, work
// orders, tasks, certificates) — Owner/Manager/Operations Staff.
function canOpsWrite() {
  return state.profile && OPS_WRITE_ROLES.includes(state.profile.role);
}
// Can see the Operations module at all — adds Viewer (read-only) on top of canOpsWrite().
function canViewOperations() {
  return state.profile && OPS_VIEW_ROLES.includes(state.profile.role);
}
// Can see the Finance module at all — Owner/Manager (everything) or Approver (Invoices & Expenses only).
function canViewFinance() {
  return state.profile && FINANCE_VIEW_ROLES.includes(state.profile.role);
}
// Can reach the Invoices/Expenses screens and their approve/reject/mark-paid actions.
function canApproveOrManage() {
  return isMgmt() || isApprover();
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
// ---- month math for the Finance Dashboard's period presets and trend chart
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function monthBounds(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function addMonths(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  return new Date(d.getFullYear(), d.getMonth() + n, 1).toISOString().slice(0, 10);
}
function monthLabel(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}
function quarterBounds(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const qStartMonth = Math.floor(d.getMonth() / 3) * 3;
  const start = new Date(d.getFullYear(), qStartMonth, 1);
  const end = new Date(d.getFullYear(), qStartMonth + 3, 0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function yearBounds(dateStr) {
  const y = new Date(dateStr + "T00:00:00").getFullYear();
  return { start: `${y}-01-01`, end: `${y}-12-31` };
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
// The Expense-type accounts an expense can be coded to (Travel, Overhead,
// Direct Cost, …) — same Chart of Accounts data as glAccountOptions, just
// scoped to one type so the picker only shows accounts that make sense here.
function expenseAccountOptions(selected) {
  const opts = state.accountBalances
    .filter((c) => c.account_type === "Expense")
    .slice().sort((a, b) => a.code.localeCompare(b.code))
    .map((c) => `<option value="${esc(c.code)}" ${c.code === selected ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  return `<option value="">— pick account —</option>${opts}`;
}
function accountName(code) {
  const a = state.accountBalances.find((c) => c.code === code);
  return a ? a.name : (code || "—");
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
// ------------------------------------------------------------ excel export
// Every Finance list/report screen can export what's currently on screen.
// `sheets` is [{ name, rows: [{Header: value, ...}, ...] }] — plain objects,
// one per row, keys become column headers. Requires the SheetJS (xlsx)
// library loaded from index.html.
function exportRowsToExcel(filename, sheets) {
  if (typeof XLSX === "undefined") { showToast("Excel export isn't available right now — try reloading the page", true); return; }
  const wb = XLSX.utils.book_new();
  sheets.forEach((s) => {
    const ws = XLSX.utils.json_to_sheet(s.rows && s.rows.length ? s.rows : [{ " ": "No data for this selection" }]);
    XLSX.utils.book_append_sheet(wb, ws, (s.name || "Sheet1").slice(0, 31));
  });
  XLSX.writeFile(wb, filename);
  showToast("Exported " + filename);
}
function todayStamp() {
  return new Date().toISOString().slice(0, 10);
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
// Cash custody trail: who's holding cash collected from customers, pending
// the Owner/Manager/Approver confirming they've physically received it (see
// App.logCashCollection / App.confirmSelectedCash). RLS already scopes what
// comes back — Operations Staff only ever see their own rows here.
async function loadCashCollections() {
  const { data, error } = await sb.from("cash_collections")
    .select("*, invoice:invoices(invoice_number,customer), collector:profiles!cash_collections_collected_by_fkey(name), confirmer:profiles!cash_collections_confirmed_by_fkey(name)")
    .order("collected_at", { ascending: false })
    .limit(500);
  if (!error) state.cashCollections = data || [];
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
// Every invoice gets its own copy of its line items the moment it's
// created (parent_type 'Invoice' tasks — see maybe_finalize_work_order and
// import_historical_invoices), independent of whatever work order it came
// from (imported historical invoices have none at all). Loading these in
// bulk for whatever's currently in state.invoices is what lets the
// Invoices screen show a real total for every row, not just ones whose
// work order happened to already be expanded elsewhere.
async function loadInvoiceTasks() {
  const ids = state.invoices.map((i) => i.id);
  if (!ids.length) { state.invoiceTasksByInvoice = {}; return; }
  const { data, error } = await sb.from("tasks").select("*").eq("parent_type", "Invoice").in("parent_id", ids);
  if (error) return;
  const map = {};
  (data || []).forEach((t) => { (map[t.parent_id] = map[t.parent_id] || []).push(t); });
  state.invoiceTasksByInvoice = map;
}
async function loadLedger() {
  if (!canApproveOrManage()) return;
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
// Same total-outstanding math as renderARAging/renderAPAging use for their
// own tables — pulled out here so the dashboard's cards agree with those
// screens exactly, without re-deriving the formula.
function computeArTotal() {
  return state.arInvoices.reduce((s, inv) => {
    const wo = state.arWoById[inv.wo_id] || {};
    const tasks = state.arTasksByInvoice[inv.id] || [];
    return s + taskTotals(tasks, wo.discount, wo.accounting_system).total;
  }, 0);
}
function computeApTotal() {
  const expTotal = state.apExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const prTotal = state.apPayrollRuns.reduce((s, r) => s + Number(state.apPayrollNetByRun[r.id] || 0), 0);
  return expTotal + prTotal;
}
// AR/AP outstanding have no historical "as of" query anywhere else in the
// app (loadARAging/loadAPAging only ever fetch what's unpaid right now), so
// the Finance Dashboard's trend chart reconstructs each month-end snapshot
// itself from paid_at: an invoice/expense/payroll run counts as outstanding
// as of date D when it existed by D (invoice_date/expense_date/approved_at
// <= D) and either was never paid or was paid after D. Expenses/payroll
// runs use their CURRENT status (Approved), since approval date isn't
// tracked historically — a fair approximation, and the same one the AP
// Aging screen itself relies on for "as of today".
async function loadFinanceTrendHistory(trendMonths) {
  const [invRes, expRes, prRes] = await Promise.all([
    sb.from("invoices").select("id,invoice_date,paid_at,wo_id"),
    sb.from("expenses").select("id,expense_date,paid_at,amount,status"),
    sb.from("payroll_runs").select("id,approved_at,paid_at,status"),
  ]);
  const invoices = invRes.data || [];
  const expenses = expRes.data || [];
  const payrollRuns = prRes.data || [];
  const invIds = invoices.map((i) => i.id);
  const woIds = [...new Set(invoices.map((i) => i.wo_id).filter(Boolean))];
  const prIds = payrollRuns.map((r) => r.id);
  const [tasksRes, wosRes, plRes] = await Promise.all([
    invIds.length ? sb.from("tasks").select("*").eq("parent_type", "Invoice").in("parent_id", invIds) : Promise.resolve({ data: [] }),
    woIds.length ? sb.from("work_orders").select("id,discount,accounting_system").in("id", woIds) : Promise.resolve({ data: [] }),
    prIds.length ? sb.from("payroll_lines").select("payroll_run_id,net_pay").in("payroll_run_id", prIds) : Promise.resolve({ data: [] }),
  ]);
  const tasksByInvoice = {};
  (tasksRes.data || []).forEach((t) => (tasksByInvoice[t.parent_id] = tasksByInvoice[t.parent_id] || []).push(t));
  const woById = {};
  (wosRes.data || []).forEach((w) => { woById[w.id] = w; });
  const netByRun = {};
  (plRes.data || []).forEach((l) => { netByRun[l.payroll_run_id] = (netByRun[l.payroll_run_id] || 0) + Number(l.net_pay || 0); });
  const outstandingAsOf = (dateStr, paidAt) => !paidAt || paidAt.slice(0, 10) > dateStr;

  return trendMonths.map((m) => {
    const asOf = m.end;
    const arOutstanding = invoices
      .filter((inv) => inv.invoice_date <= asOf && outstandingAsOf(asOf, inv.paid_at))
      .reduce((s, inv) => {
        const wo = woById[inv.wo_id] || {};
        return s + taskTotals(tasksByInvoice[inv.id] || [], wo.discount, wo.accounting_system).total;
      }, 0);
    const apExpenses = expenses
      .filter((e) => e.status === "Approved" && e.expense_date <= asOf && outstandingAsOf(asOf, e.paid_at))
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const apPayroll = payrollRuns
      .filter((r) => r.status === "Approved" && r.approved_at && r.approved_at.slice(0, 10) <= asOf && outstandingAsOf(asOf, r.paid_at))
      .reduce((s, r) => s + Number(netByRun[r.id] || 0), 0);
    return { arOutstanding, apOutstanding: apExpenses + apPayroll };
  });
}
// The Finance Dashboard: sales/expenses/net-income/net-cash-flow for the
// selected period, cash and AR/AP outstanding as of today, and a trailing
// 6-month trend for all seven KPIs (independent of the period picker, so
// there's always a "where are we headed" view even for a one-day range).
async function loadFinanceDashboard() {
  if (!isMgmt()) return;
  const { from, to } = state.statementDates.financedashboard;
  const trendMonths = [5, 4, 3, 2, 1, 0].map((i) => monthBounds(addMonths(to, -i)));
  const sumCash = (rows) => (rows || []).filter((r) => r.code && r.code.startsWith("CASH-"))
    .reduce((s, r) => s + Number(r.debit || 0) - Number(r.credit || 0), 0);
  const [isRes, cfRes, tbBefore, tbTo, trendHistory, ...rest] = await Promise.all([
    sb.rpc("income_statement", { p_from: from, p_to: to }),
    sb.rpc("cash_flow_statement", { p_from: from, p_to: to }),
    sb.rpc("trial_balance", { p_as_of: dayBefore(from) }),
    sb.rpc("trial_balance", { p_as_of: to }),
    loadFinanceTrendHistory(trendMonths),
    ...trendMonths.map((m) => sb.rpc("income_statement", { p_from: m.start, p_to: m.end })),
    ...trendMonths.map((m) => sb.rpc("cash_flow_statement", { p_from: m.start, p_to: m.end })),
    ...trendMonths.map((m) => sb.rpc("trial_balance", { p_as_of: m.end })),
    loadARAging(),
    loadAPAging(),
  ]);
  const n = trendMonths.length;
  const isTrendRes = rest.slice(0, n);
  const cfTrendRes = rest.slice(n, n * 2);
  const tbTrendRes = rest.slice(n * 2, n * 3);
  const isRows = isRes.error ? [] : (isRes.data || []);
  const revenue = isRows.filter((r) => r.account_type === "Revenue").reduce((s, r) => s + Number(r.amount || 0), 0);
  const expense = isRows.filter((r) => r.account_type === "Expense").reduce((s, r) => s + Number(r.amount || 0), 0);
  const cfRows = cfRes.error ? [] : (cfRes.data || []);
  const netCashFlow = cfRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const trend = trendMonths.map((m, idx) => {
    const isR = isTrendRes[idx] && !isTrendRes[idx].error ? (isTrendRes[idx].data || []) : [];
    const cfR = cfTrendRes[idx] && !cfTrendRes[idx].error ? (cfTrendRes[idx].data || []) : [];
    const tbR = tbTrendRes[idx] && !tbTrendRes[idx].error ? (tbTrendRes[idx].data || []) : [];
    const rev = isR.filter((x) => x.account_type === "Revenue").reduce((s, x) => s + Number(x.amount || 0), 0);
    const exp = isR.filter((x) => x.account_type === "Expense").reduce((s, x) => s + Number(x.amount || 0), 0);
    return {
      label: monthLabel(m.start),
      revenue: rev, expense: exp, netIncome: rev - exp,
      netCashFlow: cfR.reduce((s, x) => s + Number(x.amount || 0), 0),
      cashOnHand: sumCash(tbR),
      arOutstanding: trendHistory[idx].arOutstanding,
      apOutstanding: trendHistory[idx].apOutstanding,
    };
  });
  state.financeDashboard = {
    revenue, expense, netIncome: revenue - expense, netCashFlow,
    beginCash: tbBefore.error ? 0 : sumCash(tbBefore.data),
    endCash: tbTo.error ? 0 : sumCash(tbTo.data),
    arTotal: computeArTotal(), apTotal: computeApTotal(),
    trend,
  };
}
async function loadTasksFor(parentId) {
  const { data, error } = await sb.from("tasks").select("*").eq("parent_id", parentId).order("created_at");
  if (!error) state.tasksByParent[parentId] = data || [];
}
async function loadExpenses() {
  if (!canApproveOrManage()) return;
  const { data, error } = await sb.from("expenses").select("*").order("created_at", { ascending: false }).limit(200);
  if (!error) state.expenses = data || [];
}
async function loadEmployees() {
  if (!isMgmt()) return;
  const { data, error } = await sb.from("employees").select("*").order("created_at", { ascending: false });
  if (!error) state.employees = data || [];
}
// Employee LOGINS (profiles), for the Owner-only Team screen — distinct from
// loadEmployees() above, which is the separate payroll roster (no login).
async function loadTeam() {
  if (!isOwner()) return;
  const { data, error } = await sb.from("profiles").select("*").order("created_at", { ascending: true });
  if (!error) state.team = data || [];
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
    if (view === "invoices") { await Promise.all([loadInvoices(), loadBankAccounts(), loadCashCollections()]); await loadInvoiceTasks(); }
    if (view === "financeinvoices") { await Promise.all([loadInvoices(), loadBankAccounts(), loadCashCollections()]); await loadInvoiceTasks(); }
    if (view === "importdata") await loadBankAccounts();
    if (view === "cashcollections") await Promise.all([loadInvoices(), loadBankAccounts(), loadLedger(), loadCashCollections()]);
    if (view === "expenses") await Promise.all([loadExpenses(), loadBankAccounts(), loadLedger()]);
    if (view === "employees") await loadEmployees();
    if (view === "payroll") await Promise.all([loadPayrollRuns(), loadEmployees(), loadBankAccounts()]);
    if (view === "assetregister") await Promise.all([loadFixedAssets(), loadBankAccounts()]);
    if (view === "assetsliabilities") await loadLedger();
    if (view === "financedashboard") await loadFinanceDashboard();
    if (view === "chartofaccounts") await loadLedger();
    if (view === "bankaccounts") await Promise.all([loadLedger(), loadBankAccounts()]);
    if (view === "journalentries") await Promise.all([loadJournalEntries(), loadLedger(), loadBankAccounts(), loadAccountingPeriods()]);
    if (view === "generalledger") await Promise.all([loadLedger(), loadBankAccounts(), loadGeneralLedger()]);
    if (view === "trialbalance") await loadTrialBalance();
    if (view === "incomestatement") await loadIncomeStatement();
    if (view === "balancesheet") await loadBalanceSheet();
    if (view === "cashflow") await loadCashFlow();
    if (view === "araging") await loadARAging();
    if (view === "apaging") await Promise.all([loadAPAging(), loadLedger()]);
    if (view === "periodclose") await loadAccountingPeriods();
    if (view === "team") await loadTeam();
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
// Guarded so a stray double-call (e.g. afterLogin() ever running twice —
// see the afterLoginDone guard below) can't try to register postgres_changes
// callbacks on an already-subscribed channel, which supabase-js rejects
// outright ("cannot add postgres_changes callbacks... after subscribe()").
let realtimeChannel = null;
function setupRealtime() {
  if (realtimeChannel) return;
  const tables = ["customers", "inquiries", "quotations", "work_orders", "tasks", "invoices", "bank_accounts",
    "journal_entries", "journal_lines", "chart_of_accounts", "accounting_periods",
    "expenses", "employees", "payroll_runs", "payroll_lines", "fixed_assets", "cash_collections"];
  const channel = sb.channel("us-servtech-live");
  tables.forEach((t) => {
    channel.on("postgres_changes", { event: "*", schema: "public", table: t }, scheduleRefresh);
  });
  channel.subscribe();
  realtimeChannel = channel;
}
function teardownRealtime() {
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// ------------------------------------------------------------------ auth

async function init() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (state.session) await afterLogin();
  state.loading = false;
  render();

  sb.auth.onAuthStateChange((_event, session) => {
    const wasIn = !!state.session;
    state.session = session;
    if (session && !wasIn) {
      // IMPORTANT: do not await Supabase calls directly inside this callback.
      // supabase-js v2 holds an internal auth lock for the duration of this
      // callback, and afterLogin() below issues sb.from(...) queries that
      // need that same lock to attach the auth token — awaiting them here
      // deadlocks the client, which is exactly what caused the "stuck on
      // Signing in..." bug (it only ever resolved after a manual page
      // refresh re-ran init() from scratch). Deferring with setTimeout lets
      // this callback return first and release the lock before the queries run.
      setTimeout(async () => {
        await afterLogin();
        render();
      }, 0);
    }
    if (!session) { state.profile = null; teardownRealtime(); render(); }
  });
}
// App.login sets state.session and calls afterLogin() directly (see below),
// and onAuthStateChange's own SIGNED_IN handling can also reach it — both
// exist so a sign-in never depends on just one signal (that's the login-hang
// fix). Exactly when each fires relative to the other isn't guaranteed, so
// this dedupes concurrent/duplicate calls onto a single in-flight run —
// without it, both paths racing could call setupRealtime() twice on the same
// realtime channel topic, which supabase-js rejects the second time.
let afterLoginPromise = null;
function afterLogin() {
  if (!afterLoginPromise) afterLoginPromise = afterLoginImpl().finally(() => { afterLoginPromise = null; });
  return afterLoginPromise;
}
async function afterLoginImpl() {
  const { data: profile } = await sb.from("profiles").select("*").eq("id", state.session.user.id).maybeSingle();
  state.profile = profile;
  if (profile && profile.active) {
    setupRealtime();
    // Approver has no Operations access at all, so land them on Finance's
    // Invoices & Expenses instead of the Operations dashboard, and skip the
    // Operations-only customers preload (RLS would just return nothing for
    // them anyway, so it'd be a wasted round trip).
    if (isApprover()) {
      state.module = "finance";
      state.view = "financeinvoices";
      await loadView("financeinvoices");
    } else {
      await loadCustomers();
      await loadView("dashboard");
    }
  }
}
window.App = window.App || {};
App.login = async function (ev) {
  ev.preventDefault();
  state.authError = "";
  state.authBusy = true;
  render();
  const { email, password } = fd(ev.target);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  state.authBusy = false;
  if (error) { state.authError = error.message; render(); return false; }
  // Drive the transition into the app directly here rather than relying on
  // the onAuthStateChange listener to do it. Previously this function only
  // called signInWithPassword and waited for onAuthStateChange to notice the
  // new session, load the profile, and render -- if that event was ever
  // delayed or missed (Supabase's SIGNED_IN notification is not guaranteed
  // to fire immediately), the button stayed stuck on "Signing in..."
  // forever, and only a manual page refresh (which re-runs init()'s own
  // direct getSession() check) recovered. Setting state.session and calling
  // afterLogin()/render() here makes a successful sign-in self-sufficient.
  // onAuthStateChange's own SIGNED_IN handling below still runs after this
  // (e.g. for other tabs signing in), but its `wasIn` guard skips re-running
  // afterLogin() since state.session is already set by the time it fires.
  state.session = data.session;
  await afterLogin();
  render();
  return false;
};
App.logout = async function () {
  await sb.auth.signOut();
  teardownRealtime();
  state.view = "dashboard";
  render();
};

// ------------------------------------------------------------- nav / ui

App.nav = function (view) {
  state.view = view;
  state.module = moduleForView(view);
  state.sidebarOpen = false; // no-op on desktop (sidebar's always visible there); closes the off-canvas panel on mobile
  state.openSubnavGroup = null; // close any tapped-open subnav dropdown
  loadView(view);
};
App.toggleSidebar = function (v) {
  state.sidebarOpen = typeof v === "boolean" ? v : !state.sidebarOpen;
  render();
};
// Desktop-only icon-only sidebar collapse (the off-canvas mobile panel above
// always shows in full, regardless of this — see the max-width:860px
// override in index.html).
App.toggleSidebarCollapse = function () {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  try { localStorage.setItem("usst_sidebar_collapsed", state.sidebarCollapsed ? "1" : "0"); } catch (e) {}
  render();
};
// The top subnav's grouped dropdowns (Accounting, Invoices & Expenses,
// Reports, …) open on hover/focus via CSS alone — this is purely the touch
// fallback, so tapping a group's name on a device with no real hover still
// opens it. A document-level click-away listener (registered once, below)
// closes it again on an outside tap.
App.toggleSubnavGroup = function (gi) {
  state.openSubnavGroup = state.openSubnavGroup === gi ? null : gi;
  render();
};
document.addEventListener("click", (e) => {
  if (state.openSubnavGroup !== null && !e.target.closest(".subnav-dropdown")) {
    state.openSubnavGroup = null;
    render();
  }
});
// Switching module jumps to that module's first tab. Finance is refused for
// anyone but Owner/Manager here too — belt and braces on top of the RLS
// that already blocks every finance table for an Officer.
App.switchModule = function (mid) {
  if (mid === "finance" && !canViewFinance()) return;
  if (mid === "operations" && !canViewOperations()) return;
  if (mid === "finance") {
    // Jump to the first tab this role is actually allowed to see (Approver
    // can't reach "financedashboard", Finance's normal first tab).
    const visible = financeVisibleTabIds();
    const firstTab = MODULES.finance.tabs.find((t) => visible.includes(t.id));
    if (firstTab) App.nav(firstTab.id);
    return;
  }
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
  try {
    await guard(sb.from("tasks").update({ status }).eq("id", taskId));
  } catch (e) {
    render(); // revert the <select> to the real stored status — the DB rejected the change (e.g. completion gate)
    return;
  }
  await loadTasksFor(parentId);
  render();
};
// Certificate/card number for one Work Order line item — required (per the
// completion gate trigger, enforce_wo_completion_gate) before that item can
// be marked Delivered, on every work order created since the gate shipped.
App.updateTaskCertNumber = async function (taskId, parentId, value) {
  await guard(sb.from("tasks").update({ cert_number: value.trim() || null }).eq("id", taskId));
  await loadTasksFor(parentId);
  render();
};
// The Odoo/ZATCA invoice reference for a whole work order — required (same
// gate) before an Odoo-system work order can be fully Delivered.
App.updateWoOdooNumber = async function (id, value) {
  try {
    await guard(sb.from("work_orders").update({ odoo_invoice_number: value.trim() || null }).eq("id", id));
  } catch (e) { render(); return; }
  await loadWorkOrders();
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

// ----------------------------------------------------- cash collections
// Most sales are cash: an employee collects it from the customer and logs
// that here (still Unpaid — this is only the employee's claim). Owner/
// Manager/Approver later confirm the weekly handover on the Cash
// Collections screen, which is what actually marks the invoice Paid and
// moves the cash into Cash in Hand (see confirm_cash_collections()).
App.logCashCollection = async function (invoiceId) {
  const { data: amount, error: terr } = await sb.rpc("invoice_total", { p_invoice_id: invoiceId });
  if (terr) { showToast(terr.message, true); return; }
  await guard(sb.from("cash_collections").insert({
    invoice_id: invoiceId, collected_by: state.session.user.id, amount: amount,
  }), "Logged as cash collected — pending confirmation");
  await loadCashCollections();
  render();
};
App.voidCashCollection = async function (id) {
  if (!confirm("Undo this cash collection entry?")) return;
  await guard(sb.rpc("void_cash_collection", { p_id: id }), "Cash collection entry undone");
  await Promise.all([loadCashCollections(), loadInvoices()]);
  render();
};
App.toggleCashSelect = function (id) {
  state.selectedCash[id] = !state.selectedCash[id];
  render();
};
App.toggleCashSelectAllFor = function (employeeId) {
  const ids = state.cashCollections.filter((c) => c.status === "pending" && c.collected_by === employeeId).map((c) => c.id);
  const allSelected = ids.length > 0 && ids.every((id) => state.selectedCash[id]);
  ids.forEach((id) => { state.selectedCash[id] = !allSelected; });
  render();
};
App.confirmSelectedCash = async function () {
  const ids = Object.keys(state.selectedCash).filter((k) => state.selectedCash[k]);
  if (!ids.length) { showToast("Select at least one collection to confirm", true); return; }
  const result = await guard(sb.rpc("confirm_cash_collections", { p_ids: ids }));
  const row = Array.isArray(result) ? result[0] : result;
  showToast(`Confirmed ${row.confirmed_count} invoice(s) — SAR ${fmtMoney(row.total_amount)} moved to Cash in Hand`);
  state.selectedCash = {};
  await Promise.all([loadInvoices(), loadCashCollections(), loadBankAccounts()]);
  render();
};

// ---------------------------------------------------------------- expenses

App.addExpense = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.amount || Number(v.amount) <= 0) { showToast("Enter an amount", true); return false; }
  if (!v.account_code) { showToast("Pick which account this posts to", true); return false; }
  await guard(sb.from("expenses").insert({
    expense_date: v.expense_date || new Date().toISOString().slice(0, 10),
    account_code: v.account_code, vendor: v.vendor || null,
    amount: Number(v.amount),
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
App.exportExpenses = function () {
  const rows = state.expenses.map((e) => ({
    "No.": e.expense_number, Date: e.expense_date, Account: accountName(e.account_code), Vendor: e.vendor || "—",
    Description: e.description || "—", "Amount (SAR)": Number(e.amount || 0), Status: e.status, Payment: e.payment_status,
  }));
  exportRowsToExcel(`expenses-${todayStamp()}.xlsx`, [{ name: "Expenses", rows }]);
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

// ------------------------------------------------------- Team (employee logins)
// Distinct from the payroll roster above: this manages actual sign-in
// accounts (profiles + their Supabase Auth user), Owner-only. Creating,
// deactivating/banning, reactivating and resetting a password all need the
// service-role key, so they go through the manage-employee Edge Function —
// the client never touches that key. Role changes and name edits are plain
// profiles updates (the Owner-only branch of the existing profiles_update
// RLS policy already allows this, no Edge Function needed for those).
async function callManageEmployee(action, payload) {
  const { data, error } = await sb.functions.invoke("manage-employee", { body: { action, ...payload } });
  if (error) {
    let msg = error.message || "Request failed";
    try {
      const ctx = error.context;
      if (ctx && typeof ctx.json === "function") {
        const body = await ctx.json();
        if (body && body.error) msg = body.error;
      }
    } catch (_) { /* keep the generic message */ }
    showToast(msg, true);
    return null;
  }
  if (data && data.error) { showToast(data.error, true); return null; }
  return data;
}
App.createTeamMember = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.name || !v.name.trim()) { showToast("Name is required", true); return false; }
  if (!v.email || !v.email.trim()) { showToast("Email is required", true); return false; }
  if (!ALL_ROLES.includes(v.role)) { showToast("Pick a role", true); return false; }
  if (!v.password || v.password.length < 8) { showToast("Temporary password must be at least 8 characters", true); return false; }
  state.teamBusy = true; render();
  const result = await callManageEmployee("create", { name: v.name.trim(), email: v.email.trim(), role: v.role, password: v.password });
  state.teamBusy = false;
  if (result) {
    showToast(`Account created for ${v.email.trim()}`);
    ev.target.reset();
    await loadTeam();
  }
  render();
  return false;
};
App.changeTeamMemberRole = async function (id, role) {
  await guard(sb.from("profiles").update({ role }).eq("id", id), "Role updated");
  await loadTeam();
  render();
};
App.deactivateTeamMember = async function (id, name) {
  if (!confirm(`Deactivate ${name}? They'll be signed out and unable to sign back in until reactivated.`)) return;
  state.teamBusy = true; render();
  const result = await callManageEmployee("deactivate", { user_id: id });
  state.teamBusy = false;
  if (result) { showToast(`${name} deactivated`); await loadTeam(); }
  render();
};
App.reactivateTeamMember = async function (id, name) {
  state.teamBusy = true; render();
  const result = await callManageEmployee("reactivate", { user_id: id });
  state.teamBusy = false;
  if (result) { showToast(`${name} reactivated`); await loadTeam(); }
  render();
};
App.resetTeamMemberPassword = async function (id, name) {
  const password = prompt(`New temporary password for ${name} (at least 8 characters):`);
  if (!password) return;
  if (password.length < 8) { showToast("Password must be at least 8 characters", true); return; }
  state.teamBusy = true; render();
  const result = await callManageEmployee("reset_password", { user_id: id, password });
  state.teamBusy = false;
  if (result) showToast(`Password reset for ${name}`);
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
App.setCoaSearch = function (value) {
  state.coaSearch = value;
  render();
};
App.toggleCoaGroup = function (type) {
  state.coaCollapsed[type] = !state.coaCollapsed[type];
  render();
};
App.startEditChartAccount = function (code) {
  state.coaEditingCode = code;
  render();
};
App.cancelEditChartAccount = function () {
  state.coaEditingCode = null;
  render();
};
App.saveChartAccount = async function (code) {
  const nameInput = document.getElementById(`coaEditName-${code}`);
  const typeSelect = document.getElementById(`coaEditType-${code}`);
  const name = ((nameInput && nameInput.value) || "").trim();
  const account_type = typeSelect && typeSelect.value;
  if (!name) { showToast("Account name is required", true); return; }
  if (!account_type) { showToast("Pick an account type", true); return; }
  await guard(sb.from("chart_of_accounts").update({ name, account_type }).eq("code", code), "Account updated");
  state.coaEditingCode = null;
  await loadLedger();
  render();
};
// Deleting an account is blocked in two ways: system-critical codes that
// trigger functions post to directly are never offered Delete at all (see
// SYSTEM_ACCOUNT_CODES); anything else is checked here for existing
// journal_lines or expenses referencing it first, since journal_lines has
// no FK to enforce that itself (see the 024 migration's comment).
App.deleteChartAccount = async function (code, name) {
  if (SYSTEM_ACCOUNT_CODES.includes(code)) {
    showToast("This account is used automatically by the system and can't be deleted", true);
    return;
  }
  const [jlRes, expRes] = await Promise.all([
    sb.from("journal_lines").select("id", { count: "exact", head: true }).eq("account_code", code),
    sb.from("expenses").select("id", { count: "exact", head: true }).eq("account_code", code),
  ]);
  const txnCount = (jlRes.count || 0) + (expRes.count || 0);
  if (txnCount > 0) {
    showToast(`Can't delete "${name}" — ${txnCount} transaction${txnCount === 1 ? "" : "s"} reference it`, true);
    return;
  }
  if (!confirm(`Delete "${name}" (${code})? This can't be undone.`)) return;
  await guard(sb.from("chart_of_accounts").delete().eq("code", code), "Account deleted");
  await loadLedger();
  render();
};
App.exportChartOfAccounts = function () {
  exportRowsToExcel(`chart-of-accounts-${todayStamp()}.xlsx`, [
    { name: "Chart of Accounts", rows: state.accountBalances.slice().sort((a, b) => a.code.localeCompare(b.code)).map((a) => ({
      "Code": a.code, "Account": a.name, "Type": a.account_type, "Balance (SAR)": Number(a.balance || 0),
    })) },
  ]);
};

// ------------------------------------------------------------ journal entries
//
// The one place this app writes a journal entry by hand — everything else
// (revenue, payments, expense/payroll payouts, asset purchases,
// depreciation) posts itself via server-side triggers. Odoo-style workflow:
// a manual entry always saves as a Draft first — it doesn't touch any
// financial statement yet — and only counts once someone explicitly clicks
// Post. A Draft can still be edited or discarded; a Posted entry can't be
// touched again (same read-only-once-final pattern used everywhere else in
// this app). Same state-bound draft pattern as the Inquiry form (see
// freshInquiryDraft above): plain typing never re-renders, it just patches
// the totals line directly, so a realtime refresh landing mid-type can't
// wipe an unfinished entry.

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
// Loads an existing Draft entry's lines (if not already loaded) back into
// the form above so it can be changed before posting.
App.editJournalEntryDraft = async function (id) {
  const je = state.journalEntries.find((j) => j.id === id);
  if (!je || je.status !== "draft") return;
  if (!state.journalLinesByJe[id]) await loadJournalLines(id);
  const lines = state.journalLinesByJe[id] || [];
  state.jeDraft = {
    je_date: je.je_date,
    memo: je.memo || "",
    lines: lines.length
      ? lines.map((l) => ({ account_code: l.account_code, debit: Number(l.debit) || "", credit: Number(l.credit) || "" }))
      : [{ account_code: "", debit: "", credit: "" }, { account_code: "", debit: "", credit: "" }],
  };
  state.jeEditingId = id;
  render();
  const form = document.getElementById("jeForm");
  if (form) form.scrollIntoView({ behavior: "smooth", block: "start" });
};
App.cancelJeEdit = function () {
  state.jeEditingId = null;
  state.jeDraft = freshJeDraft();
  render();
};
// Validates the draft in the form and either creates a new Draft entry or
// saves changes to the one being edited — never posts directly. Posting is
// its own explicit action (App.postJournalEntryDraft) on a saved Draft.
App.saveJournalEntryDraft = async function (ev) {
  ev.preventDefault();
  const d = state.jeDraft;
  const lines = d.lines.filter((l) => l.account_code && (Number(l.debit || 0) > 0 || Number(l.credit || 0) > 0));
  if (lines.length < 2) { showToast("A journal entry needs at least two lines", true); return false; }
  const debit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const credit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(debit - credit) >= 0.005) { showToast("Debits and credits must balance", true); return false; }
  if (!d.memo || !d.memo.trim()) { showToast("Enter a memo describing this entry", true); return false; }
  const p_lines = lines.map((l) => ({ account_code: l.account_code, debit: Number(l.debit || 0), credit: Number(l.credit || 0) }));
  const p_je_date = d.je_date || new Date().toISOString().slice(0, 10);
  if (state.jeEditingId) {
    await guard(sb.rpc("update_journal_entry_draft", {
      p_je_id: state.jeEditingId, p_je_date, p_memo: d.memo.trim(), p_lines,
    }), "Draft updated");
  } else {
    await guard(sb.rpc("save_journal_entry_draft", {
      p_je_date, p_memo: d.memo.trim(), p_lines,
    }), "Saved as draft — post it below when it's ready");
  }
  state.jeEditingId = null;
  state.jeDraft = freshJeDraft();
  await Promise.all([loadJournalEntries(), loadLedger()]);
  render();
  return false;
};
App.postJournalEntryDraft = async function (id) {
  if (!confirm("Post this entry? It will immediately count toward every financial statement, and can't be edited or unposted afterward.")) return;
  await guard(sb.rpc("post_journal_entry_draft", { p_je_id: id }), "Journal entry posted");
  await Promise.all([loadJournalEntries(), loadLedger()]);
  render();
};
App.discardJournalEntryDraft = async function (id) {
  if (!confirm("Discard this draft? This can't be undone.")) return;
  await guard(sb.rpc("discard_journal_entry_draft", { p_je_id: id }), "Draft discarded");
  await loadJournalEntries();
  render();
};
App.setJeFilter = function (field, value) {
  state.jeFilter[field] = value;
  render();
};
// Client-side filter over the already-loaded page of entries (search text
// over memo/number, status, and date range) — mirrors the Odoo list-view
// search bar without needing a round trip for every keystroke.
function filteredJournalEntries() {
  const f = state.jeFilter;
  const q = (f.search || "").trim().toLowerCase();
  return state.journalEntries.filter((je) => {
    if (q && !((je.je_number || "").toLowerCase().includes(q) || (je.memo || "").toLowerCase().includes(q))) return false;
    if (f.status && je.status !== f.status) return false;
    if (f.from && je.je_date < f.from) return false;
    if (f.to && je.je_date > f.to) return false;
    return true;
  });
}
App.exportJournalEntries = async function () {
  const rows = filteredJournalEntries();
  if (!rows.length) { showToast("Nothing to export for this filter", true); return; }
  const ids = rows.map((r) => r.id);
  const { data: lines, error } = await sb.from("journal_lines").select("*").in("journal_entry_id", ids).order("journal_entry_id").order("created_at");
  if (error) { showToast(error.message, true); return; }
  const byJe = {};
  (lines || []).forEach((l) => { (byJe[l.journal_entry_id] = byJe[l.journal_entry_id] || []).push(l); });
  const jeNumberById = {}; rows.forEach((je) => { jeNumberById[je.id] = je.je_number; });
  exportRowsToExcel(`journal-entries-${todayStamp()}.xlsx`, [
    { name: "Entries", rows: rows.map((je) => ({
      "No.": je.je_number, "Date": je.je_date, "Memo": je.memo, "Source": je.source,
      "Status": je.status === "draft" ? "Draft" : "Posted",
    })) },
    { name: "Lines", rows: (lines || []).map((l) => ({
      "Entry No.": jeNumberById[l.journal_entry_id] || "", "Account": l.account_code,
      "Debit": Number(l.debit || 0), "Credit": Number(l.credit || 0),
    })) },
  ]);
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
App.exportGeneralLedger = function () {
  if (!state.glQuery.account) { showToast("Pick an account first", true); return; }
  if (!state.glRows.length) { showToast("No activity to export for this account", true); return; }
  exportRowsToExcel(`general-ledger-${state.glQuery.account}-${todayStamp()}.xlsx`, [
    { name: "General Ledger", rows: state.glRows.map((r) => ({
      "No.": r.je_number, "Date": r.je_date, "Memo": r.memo, "Source": r.source,
      "Debit": Number(r.debit || 0), "Credit": Number(r.credit || 0), "Balance": Number(r.running_balance || 0),
    })) },
  ]);
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
App.exportTrialBalance = function () {
  exportRowsToExcel(`trial-balance-${state.statementDates.trialbalance.asOf}.xlsx`, [
    { name: "Trial Balance", rows: state.trialBalanceRows.map((r) => ({
      "Code": r.code, "Account": r.name, "Type": r.account_type,
      "Debit": Number(r.debit || 0), "Credit": Number(r.credit || 0),
    })) },
  ]);
};
App.exportIncomeStatement = function () {
  const rows = state.incomeStatementRows;
  exportRowsToExcel(`income-statement-${state.statementDates.incomestatement.from}-to-${state.statementDates.incomestatement.to}.xlsx`, [
    { name: "Income Statement", rows: rows.map((r) => ({ "Account": r.name, "Type": r.account_type, "Amount (SAR)": Number(r.amount || 0) })) },
  ]);
};
App.exportBalanceSheet = function () {
  const rows = state.balanceSheetRows;
  const assetAmt = (r) => r.account_type === "ContraAsset" ? -(Number(r.credit || 0) - Number(r.debit || 0)) : Number(r.debit || 0) - Number(r.credit || 0);
  const creditAmt = (r) => Number(r.credit || 0) - Number(r.debit || 0);
  const out = [];
  rows.filter((r) => r.account_type === "Asset" || r.account_type === "ContraAsset").forEach((r) => out.push({ Section: "Asset", Account: r.name, "Amount (SAR)": assetAmt(r) }));
  rows.filter((r) => r.account_type === "Liability").forEach((r) => out.push({ Section: "Liability", Account: r.name, "Amount (SAR)": creditAmt(r) }));
  rows.filter((r) => (r.account_type === "Equity" || r.account_type === "ContraEquity") && r.code !== "3100").forEach((r) => out.push({ Section: "Equity", Account: r.name, "Amount (SAR)": creditAmt(r) }));
  out.push({ Section: "Equity", Account: "Retained earnings (cumulative net income)", "Amount (SAR)": Number(state.balanceSheetNetIncome || 0) });
  exportRowsToExcel(`balance-sheet-${state.statementDates.balancesheet.asOf}.xlsx`, [{ name: "Balance Sheet", rows: out }]);
};
App.exportCashFlow = function () {
  const rows = state.cashFlowRows;
  exportRowsToExcel(`cash-flow-${state.statementDates.cashflow.from}-to-${state.statementDates.cashflow.to}.xlsx`, [
    { name: "Cash Flow", rows: rows.map((r) => ({ "Category": r.category, "Source": r.source, "Memo": r.memo, "Date": r.je_date, "Amount (SAR)": Number(r.amount || 0) })) },
  ]);
};

// ------------------------------------------------------------ Finance Dashboard

const FINANCE_DASH_PRESETS = [
  { id: "thismonth", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "thisquarter", label: "This quarter" },
  { id: "thisyear", label: "This year" },
];
// The 7 KPI tiles on the Finance Dashboard double as a trend-chart legend:
// clicking one toggles its line on the trailing-6-month chart below. `key`
// matches both the field on state.financeDashboard and on each state.financeDashboard.trend[i].
const FINANCE_KPI_METRICS = [
  { key: "revenue", label: "Sales", color: "#0e7a4d" },
  { key: "expense", label: "Expenses", color: "#b3261e" },
  { key: "netIncome", label: "Net income", color: "#2563eb" },
  { key: "netCashFlow", label: "Net cash flow", color: "#92650a" },
  { key: "cashOnHand", label: "Cash on hand", color: "#0d9488" },
  { key: "arOutstanding", label: "AR outstanding", color: "#7c3aed" },
  { key: "apOutstanding", label: "AP outstanding", color: "#475467" },
];
App.toggleFinanceMetric = function (key) {
  const sel = state.financeDashboardMetrics;
  const idx = sel.indexOf(key);
  if (idx >= 0) {
    if (sel.length === 1) return; // keep at least one line on the chart
    sel.splice(idx, 1);
  } else {
    sel.push(key);
  }
  render();
};
App.setFinanceDashboardDate = function (field, value) {
  state.statementDates.financedashboard[field] = value;
  state.financeDashboardPreset = "custom";
};
App.setFinanceDashboardPreset = async function (preset) {
  const today = todayIso();
  let range;
  if (preset === "thismonth") range = monthBounds(today);
  else if (preset === "lastmonth") range = monthBounds(addMonths(today, -1));
  else if (preset === "thisquarter") range = quarterBounds(today);
  else if (preset === "thisyear") range = yearBounds(today);
  else range = { start: state.statementDates.financedashboard.from, end: state.statementDates.financedashboard.to };
  state.financeDashboardPreset = preset;
  state.statementDates.financedashboard = { from: range.start, to: range.end };
  await loadFinanceDashboard();
  render();
};
App.runFinanceDashboard = async function (ev) {
  ev.preventDefault();
  state.financeDashboardPreset = "custom";
  await loadFinanceDashboard();
  render();
  return false;
};
App.exportFinanceDashboard = function () {
  const d = state.financeDashboard;
  const { from, to } = state.statementDates.financedashboard;
  const summary = [
    { Metric: "Sales (revenue)", "Amount (SAR)": d.revenue },
    { Metric: "Expenses", "Amount (SAR)": d.expense },
    { Metric: "Net income", "Amount (SAR)": d.netIncome },
    { Metric: "Net cash flow", "Amount (SAR)": d.netCashFlow },
    { Metric: "Cash on hand (period end)", "Amount (SAR)": d.endCash },
    { Metric: "AR outstanding (as of today)", "Amount (SAR)": d.arTotal },
    { Metric: "AP outstanding (as of today)", "Amount (SAR)": d.apTotal },
  ];
  const trend = d.trend.map((m) => ({
    Month: m.label, Sales: m.revenue, Expenses: m.expense, "Net income": m.netIncome,
    "Net cash flow": m.netCashFlow, "Cash on hand": m.cashOnHand,
    "AR outstanding": m.arOutstanding, "AP outstanding": m.apOutstanding,
  }));
  exportRowsToExcel(`finance-dashboard-${from}-to-${to}.xlsx`, [
    { name: "Summary", rows: summary },
    { name: "6-Month Trend", rows: trend },
  ]);
};

// -------------------------------------------------------------- AR/AP aging

App.exportARAging = function () {
  const rows = state.arInvoices.map((inv) => {
    const wo = state.arWoById[inv.wo_id] || {};
    const tasks = state.arTasksByInvoice[inv.id] || [];
    const total = taskTotals(tasks, wo.discount, wo.accounting_system).total;
    return { "Invoice": inv.invoice_number, "Customer": inv.customer, "Invoice date": inv.invoice_date, "Bucket": agingBucket(inv.invoice_date), "Amount (SAR)": total };
  });
  exportRowsToExcel(`ar-aging-${todayStamp()}.xlsx`, [{ name: "AR Aging", rows }]);
};
App.exportAPAging = function () {
  const rows = [
    ...state.apExpenses.map((e) => ({ Type: "Expense", "No.": e.expense_number, "Vendor / Period": e.vendor || accountName(e.account_code), Date: e.expense_date, "Amount (SAR)": Number(e.amount || 0) })),
    ...state.apPayrollRuns.map((r) => ({ Type: "Payroll", "No.": r.pr_number, "Vendor / Period": "Period " + r.period, Date: (r.approved_at || r.created_at || "").slice(0, 10), "Amount (SAR)": Number(state.apPayrollNetByRun[r.id] || 0) })),
  ].map((r) => ({ ...r, Bucket: agingBucket(r.Date) }));
  exportRowsToExcel(`ap-aging-${todayStamp()}.xlsx`, [{ name: "AP Aging", rows }]);
};
App.exportAssetsLiabilities = function () {
  const types = ["Asset", "ContraAsset", "Liability"];
  const rows = state.accountBalances.filter((a) => types.includes(a.account_type)).slice().sort((a, b) => a.code.localeCompare(b.code));
  exportRowsToExcel(`assets-liabilities-${todayStamp()}.xlsx`, [
    { name: "Assets & Liabilities", rows: rows.map((a) => ({ Code: a.code, Account: a.name, Type: a.account_type, "Balance (SAR)": Number(a.balance || 0) })) },
  ]);
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

// US ServTech company logo (embedded as a data URI so it always loads —
// no separate file to keep in sync with index.html/app.js on every deploy).
// See .logo-badge in index.html for sizing.
const LOGO_MARK = `<img class="logo-badge" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAAC3CAMAAAAb1iN0AAABgFBMVEUbqdYqztMVaNwgqsIbUqAXasEA/wAewNlVqqoMUH8dsr8inMAhm8AAAKoQT6Qetb0A/78fx8dV/6r///8AAAAPd7YZh7gSaLIclrsaqcMYo74hl7sSWaoDVaoAf38A//8AAP8Af/8DqawEfbsdtMgXZq8clsMVZq4VZq4XZq8Yh8IXZq8WZq8ioscReLMhnMIZh7gWZq8YhrcTWakPd7YXibYcl7saqsEAqv8Od7QPd7UZh7gNdrQZiLgbmbsYh7cbmbwclbsNe8EQeLUEvL0jk7kamLkSWqoescIgu84YhrcaqcEclrsdssMSWagessIclbsds8MYo74Zpb0Ypb4xf7ECZZkbqcEoqdAaqMEcssMKmMgXo70YpL4SWqkYpb0apsQaqMAzu7wUXJwFmpoimLsgmLwpqK8bqsEhl7swmMopVakka7QhmLwAAH8hmLwgl7wAP38AP78ds8IgrcESWqkAZswSWqogwdIqf9QzmZkYSpUPTK4auMgjh7Uks84+uVjrAAAAgHRSTlMWGARWI/8B/wMIMqXZA/5CBEkDAQD9/f38/fz9/QUCAQECBQf8zf4RLrD+To/+MP0wbM8vzxVOMQOMb5BQbi9OctD+rwYRE86s/q7Rj9ROkLAwkC+yBQWyC3BPC2vNdVUVTAgKBTKOCJF0CAcJVgKuzQQEcTOQBbH/BgUKDBIQDjYiOYMAABZ+SURBVHja7Z2HV9vI1sDJtrevfP1KlmyrWJKb3I1Nx8YU0xMggVBCQkJIb5vsZvvuv/7dOyPZciGm7B60PE3OCS7SoJ9unZmrYQj+zdpQABwAB8ABcAAcAAfAAXAAHAAHwAFwABwAB8ABcAAcAP87AmtqZwskfN2AF4YWWGs2m1VsxRfXHHioUYhgk7CJ1Ow6GNcY2ICRXMQFZsiJSRi7xsBjsJbrELBol42vri+wDkdSS6MdYrEI6rUFNqCWiHQBJ+pgXlvgeZjJ9QBPgnJtgVXYaAM7Gi2Wd66tDWvwtNeEyYiNawrcz4TRT0/71ojPCGye5nVNeJ7rA7ziWzd9NmAdTlNRM7bRB1gUf0Nl72sCRsz/wLoO08X+yOiMG32Bi5rZTyuoj5jfgTUFJhPi9DbEtD7XP5OQ+gDbkzwLU7sPbz67d7V552BgPQaTNsbWxgi0LlWLOVll7W5O6gcsCpXxiTwxtuWpIu/eqiw/wNjtY2CU77jNsglpbQF0g4MyC8Vhg+zydoRhgZptC2WyhBiXso4nfd6Q5TARx/wLjPIdtwWGgfH2cx3GNGR+tH8Eqgr3ZFnqFbDQaqItTiLymMa0+WSjIEvhMCNW/Qqsk3wFB1iK5N7dJk+1v75P5rklh6UeYCEUCrWACXkFkU0NfnseQW0IU5PDo6f48CsHJvnOCg4wI5a3jh6uLu/BvKY9Y/L1AksMN9SWMDMFcXIBYORdjo4Jc+LRq0vEhgbIN+u5dGKT5HDYugOP50m+4S5gMRTqBSbk6Y1CIdIClv0K3Ob1AEt4vUfaU8bbCczF2wdYlBIsdvkeWEVe5/KdC2cXLd+DXfJXDrDrpMVQ1Atr23Y7SPHD/A6MvG15eXT6UDuA23K3gAXCDcXT2VJpCtvExPhcBRMQ2+H1AMs+BVbgfqgv8CjMG6syk1UbGFUhXsokO8ZIarU+vSKiOotdApa/9SfwzX7AuQ04gC0r3AFcCC2WUvws8xsFm2GoJp/0GKoz5r8AMKZD37eJW4GpMKrCqNwWMN2DSPYL8nGmouldWRobQDRnGh4nLfsWWNOTvSLOvcX02FFoDpwr/DNPHv2U5EkzkG0Bw3DB98Co1KUe4MKJBg8chSbgQu7tCSaOn0wVNbRs9fW/cm1gvyYeihLvBMYxE8Dvh3ILOCe9/sR0SOfAcE12Umn/Ascg1WXECRwjegSce9uEM05hoJRrzBT8DIxKne0QsSRVQTt0gWV5Bs4+mkfFNrfY8FC2fAusqUoHcGINWi4ar3xkgPF267UOD0i+PgZGEWe8Ok0a/cySW7znnOTV5uH2qoXA3/oWGInTgseID+BI5hIm3vNP1cxD867la2Dmt1ydTqwAPLTCssN7kbl2Ax7fXfav06IRxA2hBWxPM42W+TTNxdYWVPhpaXnTv8Dz8MFue60iPDpkKi1vwUXXy1RoLu37FxiUdbEFXF6AbznvHXK5FyY2rnCedmiQyY1aomvENprwHpmwLNcuM9OqAfgW2IQPP7SBXROWL7l6oGk+lvBdAnYCUx0AwyhTaPirtgGZFjRXl6VWspUHg+WGt68tcAydlNUGbtJclmxt/YV5BwAbmGe0gMXKNrowJL6txa4r8Dx6ZTnsDBHFOZZnWX9lCx4EbMLWsiw7wPYcRaUrHcz+6cAqYKovO+tj9jiLSoeaBtcTWCFLPUSvLHIRc2Brz79VdhcH1mNsnkoHmnF3gWcnAO5Y8lGfTEmNtZvKMgvPO893TtEEftujJjp9jSeyM93Tvd2o3jftGQpV1dr5TKtXz8uBwLryDZtCf5UaBligRFJqA99Fl6X2nHCeRLpl//Na57j7/E03eGexMc0TVwZksF3AOp+BTKZK6XgozYHDYS/wve5hP50wPJxKpfL5fLFYO6nhb3q0WasV8/nU8PAwKMOs8QOq7JLmN0d/fQydd44d9svm0OjtWnH0Bv5XzKfyo/wnfnMMo+0+1RZbs7l7dOBy/moYjx3M349+fdyfuFfCCsLyZc8s6LsE7HotBjzaNWxQ4e/3F6M8btH6Ig4cF+CWReUAQigaXYSbUWxuZBNXaN7g1rJlrd+63b6iN3Cfjop+sbQshyPYjcxOF+Sw0000CUvUp8D61N8wnXg1tVKWIlL4zl4VFX4Mj7DWH1CnGnv5ed/Cig5gHZIurBc4zI14Fp3WnXCsW77KYosGeSXrAfzOgfHiQtGbDLh9RKLwBLRRC9uy1RoVK/yu4N259UNYiuCZYoQVTzjA1E0LOBQdpnseg3pFtOlXFmSCgwNY+sGyMO1VEXh92Vru6206gWOQEkJ9gJkRhwh4tSvr0NUWL/FIkry6oM27wELoJlp4NOS9IxEcasHSMhGvunOeKnzPgO/D0brFgEOi1AYWQvdRLZbafaqkw0/YOJ2X0Ijy0g3qVQ5j3ku6vG6xMd38YGAPr5CFN0MMONwG3urs5DP4roVrJxJ4r4dAHUNguSCKlewwFS0Nx13eBCkgZS7/sChFtR7yUWYMhhlvFD3X6F1HjkylsRt8l01RTdwS9SlUsgrJV4O1AvUq2rZNQg/ZjQW0NzS/NQa8Si9nzg+sQIMqOWReq4KZ1p2HHRJGG0B9pftcLjcah6tLH57ib9Ng8+HISL2oMOerAzgOrb5RkPA6lm+RLwizYSYT8Xu+8o4apaAOHqFrmspMEXB4n7pJch/O++RvFHidE6JRMddYmZysCLOzoVC6CndQIXJP4Ce8gEN6+RwenQ84jYq0QZU6XKeFigZbtzs8gUKywftcLv7vi0fz//1/0Ol6+Yqi55M1pER3gjk5n+od4bfvOM5+YQr7cx9ru4HA8rq3G7dPjXp8ESmE/lO07i3QVU9N8Kq/O7IUya1pTzEGH9LLmbMACx3AB3iJbE2UW6EJ9253OAJaNEfgBLpexTAMc2GXX9v87u7ujy9MWhpn/SosYTDVvIS81rqh6SQCSd7QmDlOsTAQN3UnK1FMpSqKYcs6MFRDcSbPHlGfB6xPqlmWoiEZ7VYxnAiOWctGLiIlJtk9bNDLvkXbXcD5dhkdSlTZhrUc8YZFB/jhUdc0PasSsNegX+T3qj472kiFJAJWFRiRaSm9cILHqzDHfuFEWxc02A2TJz9tGPqikZCi4v84M4mKSZW7Y/AWDV5eO5h/+ujGO3p5Fhv2AAsECCM5qS3iPBxpXSAKl/3cJLa1J2sPDWbD/yDjq09lbt68+Q1o7fmvEjpea3kJxtSv39GDA4UNkozp/jYP8Ca6tU7gTepzivUJNSoa2ugU4BhsJDCAy+vr66ur6Nwl6965gdEwak6NHVO6CdB7VmKybJ7eRhedyOXQ9e5Rn+SlE6xua5EZ4LZBRR8mqa5kLX+AMRNeF1i/RfgRpjGc0uAz5rmQUfTmlhzz5InkpW3eJ4wk8IwZvQt4JSGxxUlsEqJb55cwplbNCHuEI8J0erzHKFQtGRJaIZb54CXM79qJx7D+Zn5v9V2jjE1g4WZ5/SklQ2YjIbLFG2W7zJat6p6ZUJWA8V8ncDvxmCbgkU7zMRCYV2Gw7mQKS4/OBzxLgG95wXuEStQqvamLCqmK7VStEa9s/YBRx0kthfgwGE9xhJUrJBK8zjYkL7MJBJVdNC1m6HVGXt72VMRo0MTsUpZ6gHmf/Nx6N/BcgtI0Xs4rnTEsdUq4onztPsMREbnXUnuJzXG83kSBKTQ5YWvTAa6UjjEL2KRIHmH3nfpc3WR3TdebZedxkA1S7sSMV3s0jDto4ZFeCVdKP+OB9T5PziCwjErG7mpIQH07r5d2jHiEqzQX8VSfYRzegmp9eub585l7W4wXbRRHObVilXo0EJiImYhR9SXDMSyVm64g1LnRLHjvpQYH5MMj3tu76faJA+AiexqszUODX7RhdM2JlUwG/VoZb+IFgG2MFE2p0BbxRG8XuhZrf1bDRJ68sHMZGFgR2KKQ++5dmcU3NCyuiJpe5YmwSHaX2+jQHQTGZDoh9g53qE/8j7QDr44NZnkUMIbQhtlTgNTK9PICwHPwApNW7qcjFJlhwBJaOcHCzuPdp9vbH6koz0QJS7x0YN8iSUtVXXMcPJWeM3ND23/QtXhTZQbuBZ6nPndYoR9pB505RaCUeVVJ8gzYHleOMW8hYHviLMCiF1gUqhqGAMmp/g6RjnfnAi+Pk8mkaVarzYOF5loC8yPKlT1tlBxa7rX2U6who4nhfTdc43cSHDT9w2b3rSx3A3doVbXCLnTtBrBCP/QX4ylYwahlj8MOKkiZAt3ZgG1mWc7TC+gYlGbDQ9zdh1tRzb00+lUBU6l92L81szY5Pp69f/8+2ZsUQQkuUOilXk1NbcdwlrdIy8+6BByDORvvt+pR8s+ftfp8r2I2yuKI2LhzGEmQp5otITCLLByYzdAMAgbYyU9PlsV2qXPF3KYnk5yGGVWXmzZhalbgRZgJ8tEiXvz6I7j1N0w8bHKXiwiMtwLzEVONlW2RXZLSPVQRal0Bz4QJUlov8JLb55ffY3IOE27s5NEOh1owN4tvswy4IrBbMBiY6Vqx3oauo4FIkug+0tCt0zr6D9uNwRYKWJAxKnkTDyhGIuGwhdmVAXVmeaGkc9dUyM5y4O+7w53KvYnaL/FYVPQ3aBYTjNNtBDc+y8aYO6QfgvPZQGDVZBamMWgWJl/Qc2kss6BZiO5kC3Oi9WUczUv8IQBhdvW/8GLcOS1KEk5yFJ038ciYUpmlC/nOEbGmvnImlIY1pTdnnRUqam/iEUoPM21QID/XQo5n6PkqUpgvv0NgBTL4xZf3zyhhUMe4W6EH0jATUovtUn4Rcw+9i3j+1iplFiyxmJt4CsYYBy7PZdBGoBYOr67vkwhVSKZD8cXFRcVRYB3U0mJ08fubvfmMriXjs6EeYNan6wKAza3G49kU8FmQTHwxfh++oY5L+PJmv8nfoVPnjw9YeMdk97ErYpYZTfVqH+jooKvVKo7SnPEhjhUWqtv8S+PokdGeMqXhrHLsHTYqCvQLdjq8zMa9v4r1+RNNo7m/mF588eq4NTWud3Skn3upxWCBTSyCUm0/rpGo/Ee3NDzDP7xPHuejKN2j5N5ZRBrex5RTKkGSvV8o3o9iY+RQ1NZnitbR73mBx4DS+kRZ/clN9J0dHHrH+O6uQ5p3BUTvt+yhU3N+6O4n/D10HaR73aOuq0qM+tQ7D8Vf5H2va63+NU0/7+qh/sLJ0F6Y5RZxomzGLlyx1Cuw3nmRjiWNzphw1mVL9YLLpWNMspLUjEFR9Ir40suHapKaibqooszQ2JWdZBLgFUP+TH+FXyov4f17Pu+JL0FJ0gF4A9iZirLDQ8pLhfe0wxg/017Su2NQd9jHsXMCa1Cl6JvYgG2vUovVS+6YFUN3Si2dipfgjZpKK2n2NplO4XcKfsxaKpNNYbx5qWeyL9P8E809M5Mljc9k+dt4hqauAdIpflxm2Omhj6yHPl3isZHgY9UF7sDcbUnMS+pxKZ1MoQSQLP0SUulMnORRSsVpolaJ4096m2Y8JYAS/qTjSxkMN+mXx4qSzKTJM2eom2wpmTLTGVIFdqaiZJwOkx/PWwFAe1YwGddgh2VUf8wuHVSEncaWSsYhG08No2ipZV+lUxizkiR4HNRmswicTsbTnyFwGugYjMGZeBZbKpWOvScy7C2LtwTYmTHnzFI6Rf3HM+eJw45Sxxo0OCw0hgyvGZeHYtolJZzCpqTiKL54Nq3QO1TfNHvYC+VE/KEkASMQItLPVCqbpcNL2JIpQkUJw7GWLWkmnuM9E/uiDpP9YvGngcecGZ7CW1TqondLA/MPkDCaKKZFqNdJdp3xVJb9RKnSUekSAes7eHDWOSBD6s26cD4owSuS8Cu8D+x9Mk6eDTUgxDs6rw3TZBqf7sg9QeJ8m/iSnjqZYS2ZooUlJQUpepeCbfbpK0gp5kcFzRP/kammWgfokMTvaAZA4R/gJ1yQvD98Y3408Tyn/z4iHlhr+YRP4uVmoNkixgFhHj77g0KxOigZjLW++SPKhwYC12Q+FZ8bYcS2Q1w2L1xATIkQS6kVnkvh/6rCJm54pq3znnWV/jlJMzsgBu1MWlPchStVb+XorTP5W+UCwDSWTvBnDNlDDiYbw9NcSLl6wa0arrjKa+BjPDejIckhnkE1Nudsd4Jv+0IyjoFZ9S+wpiqL0WhUCIcRmk2xajDhlBnYK8kLhGMctxdN3bfACnzHahFCzqPOWyYcQL7ChWxXzHP7agzndSWm+RVYdYsvUMj8Udi7BoYndUKwOXH+fMQ4fKxPf63414YVp7qGNZGVbK0+ILXOzznz1lOdo9ZB4oVpWg2o7emaL4Hd8imnhUS2/LoHKGSYqnDfNa46cWGwdzahuTENP0JtdeMKC5A/uY/Hx8VoZ0PFlq27twFeuMizqNZnunw85nVjBO9VjSptTD8CK049YLRLzJb14QaY7+HN1JxAG/VMmINrQ9FPVZ/86wQH1q8LlKc+8iGw+kaJ9m0hIbH6EIC2rciPMyG7i1qn4pJ4C/9swlfwpBCRCmu+BHZDUl/mEI1NaZ7FRDHbNkNWTpkppCLf2l35HuaUVT6hMHmFe6YNnZ4RDUc/0Qj5DbARBDHPVkixQe0JsSp9jLirtHpUZ3Udl58y+VOAUcCh02n5AkcJr1uneZTk1HilMjfVheHU1T+4i64dpVyddOpN/AkMPKs8DdYpkB1nkMxlmVQBOJVPOgMWgy9Sje6tWsyvQ7E11Xul+5oOfWIU10Mc6qSlZEuojE+1BwNmPp83TcPZ6cIYvXdHdnB/m2zPEPVfqb76sKTC8eKnYN3Hxm2xPFkvVjsYdgn2ULb+Zi3Rb3g6zQfSrdIRXwLTHPFiHzUWenZESyTQ+Tbevn3y/PkMtq07h4e0RLq8vH5rkzp63bC9pRSzfgVu1fd7accn5iqd26E5+4MVcrxSy63WsqylfTLjr0YaCVvoqvDzKTARpztEO5dnlspWyxNMsM6OWlJ7S0PZYs9w7LNYW51pSGtFZ3jltqkr3GB8aNAM29/dfTxoODhFgZV7pGpxenKjQbtptSTLxCrL60sf9n/n8bi21mjMkE9Ljjs1yezelfwLjMQfqVaE4U6ofN9VPWa4kxYLJycjI2i12J5tPdvb+/zh5q/uqbWZRmOtSBpBpWs0onRNI+XfnUuJeJumsWxxsnOMoMVM8/ShcPNkrSFtjJg0KtTYJCOtkrR4r3COZ/BuOoyYbbhqnGkK8unJyNqGlJBoV1oYi3lmO45LrUcb/AyMxDuTdei7cYcGm/ubQ7u7Brbbow8fzDx5+y4ioTNbqVMpQ+cptNKbpcKe9+BvYKaA/ZeETbj1g+XsRoTuGd1XocAS5t9AH+utzPkGIDUMPp7Tal2poZw2jTHq8LrByfljLdpYXzOlapsr3i3/cn/2QAMjzPfkdbandZLl8VMzi9hV/3WAS/6dB5WejpK6NxAXp/y7TcAlgZ2/1NK9Xbp5bf8ajwYnPbT0rIR/90W4NLDZgyuwpzSvKTCSOeU9rSf4sGWuMbDpPpziGRxcaa7850s4L3bShkJxP+9scvk/Evejs3rq8kZbBeDXE1iBcaESd9situjNaw3M6z6d9ssvP//8y8++3qsn+NulF2h6V4NAwgFwABwAB8ABcAAcAAfAAXAAHAAHwAFwABwAB8ABcAAcAAfAAXAAHAAHwAFwABwAB8ABcAAcAAfAf2j7f+tElL2PmP5hAAAAAElFTkSuQmCC" alt="US ServTech">`;

// Small inline eye / eye-off glyphs for the login password field's show/hide
// toggle — see App.toggleLoginPasswordVisibility, which swaps this markup
// directly in the DOM (no render() call) so the fields the person has
// already typed into never get touched.
const EYE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.7 21.7 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
function renderLogin() {
  return `
  <div class="login-wrap">
    <div class="login-card">
      ${LOGO_MARK}
      <h1 class="welcome">Welcome Back</h1>
      <p class="sub">Sign in to continue to your account</p>
      <form onsubmit="return App.login(event)">
        <div class="field"><label>Email Address</label><input type="email" name="email" required autocomplete="username"></div>
        <div class="field"><label>Password</label>
          <div class="pw-field-wrap">
            <input type="password" name="password" id="loginPasswordInput" required autocomplete="current-password">
            <button type="button" id="loginPwToggleBtn" class="pw-toggle" onclick="App.toggleLoginPasswordVisibility()" aria-label="Show password">${EYE_ICON}</button>
          </div>
        </div>
        <div class="login-remember"><input type="checkbox" id="loginRemember"><label for="loginRemember">Remember Me</label></div>
        <button class="btn btn-primary" type="submit" style="width:100%" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Signing in…" : "Sign In"}</button>
        <div class="error-msg">${esc(state.authError)}</div>
      </form>
    </div>
  </div>`;
}
App.toggleLoginPasswordVisibility = function () {
  const inp = document.getElementById("loginPasswordInput");
  const btn = document.getElementById("loginPwToggleBtn");
  if (!inp || !btn) return;
  const showing = inp.type === "text";
  inp.type = showing ? "password" : "text";
  btn.innerHTML = showing ? EYE_ICON : EYE_OFF_ICON;
  btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
};
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
// Turns a name/email into 1-2 letters for the sidebar/topbar avatar circle.
function initialsFor(name) {
  const s = (name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function renderShell() {
  const mod = state.module;
  const showOperations = canViewOperations();
  const showFinance = canViewFinance();
  const moduleBtns = `
    ${showOperations ? `<button class="mod-operations ${mod === "operations" ? "active" : ""}" onclick="App.switchModule('operations')" title="Operations"><span class="mod-icon">O</span><span class="sidebar-label">Operations</span></button>` : ""}
    ${showFinance ? `<button class="mod-finance ${mod === "finance" ? "active" : ""}" onclick="App.switchModule('finance')" title="Finance"><span class="mod-icon">F</span><span class="sidebar-label">Finance</span></button>` : ""}`;
  const modDef = MODULES[mod] || MODULES.operations;
  // The sidebar now holds only identity + the Operations/Finance module
  // switch — every screen *within* the active module lives in this
  // horizontal top subnav instead (subnavHtml below). For Finance, each
  // labeled cluster (Accounting, Invoices & Expenses, Reports, …) is a
  // hover dropdown off its group name rather than a row of always-visible
  // buttons — hovering (or, on touch, tapping) "Accounting" reveals Chart of
  // Accounts / Journal Entries / General Ledger / Bank Accounts beneath it.
  // A group left with exactly one screen (Overview → Dashboard) has nothing
  // to drop down to, so it's just shown as a plain top-level tab. Groups are
  // filtered down to whatever this role may actually reach
  // (financeVisibleTabIds()) — e.g. an Approver only ever sees the
  // "Invoices & Expenses" group, and only Owner sees "Team".
  let subnavHtml;
  if (modDef.groups) {
    const visibleIds = mod === "finance" ? financeVisibleTabIds() : modDef.tabs.map((t) => t.id);
    const tabById = {};
    modDef.tabs.forEach((t) => { tabById[t.id] = t; });
    const visibleGroups = modDef.groups
      .map((g) => ({ ...g, tabs: g.tabs.filter((id) => visibleIds.includes(id)) }))
      .filter((g) => g.tabs.length);
    subnavHtml = visibleGroups.map((g, gi) => {
      if (g.tabs.length === 1) {
        const id = g.tabs[0];
        return `<button class="subnav-item ${state.view === id ? "active" : ""}" onclick="App.nav('${id}')">${esc(tabById[id].label)}</button>`;
      }
      const hasActive = g.tabs.includes(state.view);
      const isOpen = state.openSubnavGroup === gi;
      return `
      <div class="subnav-dropdown ${isOpen ? "open" : ""}">
        <button class="subnav-dropdown-trigger ${hasActive ? "active" : ""}" onclick="event.stopPropagation();App.toggleSubnavGroup(${gi})">${esc(g.label)}<span class="chev">▾</span></button>
        <div class="subnav-dropdown-menu"><div class="subnav-dropdown-menu-inner">
          ${g.tabs.map((id) => `<button class="subnav-dropdown-item ${state.view === id ? "active" : ""}" onclick="App.nav('${id}')">${esc(tabById[id].label)}</button>`).join("")}
        </div></div>
      </div>`;
    }).join("");
  } else {
    subnavHtml = modDef.tabs.map((t) =>
      `<button class="subnav-item ${state.view === t.id ? "active" : ""}" onclick="App.nav('${t.id}')">${esc(t.label)}</button>`
    ).join("");
  }
  const displayName = state.profile.name || state.session.user.email;
  const crumb = (MODULES[mod] && MODULES[mod].tabs.find((t) => t.id === state.view)) || { label: "" };
  return `
  <div class="shell ${state.sidebarOpen ? "sidebar-open" : ""} ${state.sidebarCollapsed ? "sidebar-collapsed" : ""}">
    <aside class="sidebar">
      <button class="sidebar-collapse-toggle" onclick="App.toggleSidebarCollapse()" title="${state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}" aria-label="${state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}">${state.sidebarCollapsed ? "›" : "‹"}</button>
      <div class="sidebar-brand">${LOGO_MARK}<div class="brand-text"><div class="sidebar-title">US ServTech</div><div class="sidebar-tag">Operations &amp; Finance</div></div></div>
      <div class="sidebar-profile">
        <div class="avatar">${esc(initialsFor(displayName))}</div>
        <div class="who-text"><div class="who-name">${esc(displayName)}</div><div class="who-role"><span class="status-dot"></span>${esc(state.profile.role)}</div></div>
      </div>
      <div class="sidebar-modules">${moduleBtns}</div>
      <div style="flex:1"></div>
      <button class="sidebar-signout" onclick="App.logout()" title="Sign out"><span class="signout-icon">⏻</span><span class="sidebar-label">Sign out</span></button>
    </aside>
    <div class="sidebar-backdrop" onclick="App.toggleSidebar(false)"></div>
    <div class="main-col">
      <div class="topbar-mobile">
        <button class="hamburger" onclick="App.toggleSidebar(true)" aria-label="Open menu">☰</button>
        <div class="topbar-crumb">${esc(MODULES[mod] ? MODULES[mod].label : "")}${crumb.label ? " · " + esc(crumb.label) : ""}</div>
        <div class="avatar avatar-sm">${esc(initialsFor(displayName))}</div>
      </div>
      <div class="topbar"><div class="topbar-inner"><div class="subnav-scroll"><nav class="subnav">${subnavHtml}</nav></div></div></div>
      <main>${state.loading ? `<div class="empty-state">Loading…</div>` : renderView()}</main>
    </div>
  </div>
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
    case "financeinvoices": return canApproveOrManage() ? renderInvoices() : mgmtOnlyView();
    case "cashcollections": return canApproveOrManage() ? renderCashCollections() : mgmtOnlyView();
    case "expenses": return canApproveOrManage() ? renderExpenses() : mgmtOnlyView();
    case "team": return isOwner() ? renderTeam() : mgmtOnlyView();
    case "employees": return isMgmt() ? renderEmployees() : mgmtOnlyView();
    case "payroll": return isMgmt() ? renderPayroll() : mgmtOnlyView();
    case "assetregister": return isMgmt() ? renderFixedAssets() : mgmtOnlyView();
    case "assetsliabilities": return isMgmt() ? renderAssetsLiabilities() : mgmtOnlyView();
    case "financedashboard": return isMgmt() ? renderFinanceDashboard() : mgmtOnlyView();
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
    case "importdata": return isMgmt() ? renderImportData() : mgmtOnlyView();
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
            <td onclick="event.stopPropagation()"><button class="link-btn" onclick="App.toggle('customers','${c.id}')">${open ? "close" : (canOpsWrite() ? "edit" : "view")}</button></td>
          </tr>
          ${open ? `<tr><td colspan="7">${renderCustomerEditor(c)}</td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="7" class="empty-state">No customers yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function renderCustomerEditor(c) {
  const ro = !canOpsWrite();
  const dis = ro ? "disabled" : "";
  return `
  <div class="wo-detail">
    <form onsubmit="return App.updateCustomer('${c.id}',event)">
      <div class="form-row">
        <div class="field"><label>Customer name</label><input name="display_name" value="${esc(c.display_name)}" required ${dis}></div>
        <div class="field"><label>Invoice name</label><input name="invoice_name" value="${esc(c.invoice_name)}" ${dis}></div>
        <div class="field"><label>Contact</label><input name="contact" value="${esc(c.contact)}" ${dis}></div>
        <div class="field"><label>Company name</label><input name="company_name" value="${esc(c.company_name)}" ${dis}></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>Email</label><input name="email" type="email" value="${esc(c.email)}" ${dis}></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(c.phone)}" ${dis}></div>
        <div class="field"><label>Mobile</label><input name="mobile" value="${esc(c.mobile)}" ${dis}></div>
        <div class="field"><label>VAT registration no.</label><input name="vat_reg_no" value="${esc(c.vat_reg_no)}" ${dis}></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>Building no.</label><input name="building_no" value="${esc(c.building_no)}" ${dis}></div>
        <div class="field"><label>Street</label><input name="street" value="${esc(c.street)}" ${dis}></div>
        <div class="field"><label>District</label><input name="district" value="${esc(c.district)}" ${dis}></div>
        <div class="field"><label>Postal code</label><input name="postal_code" value="${esc(c.postal_code)}" ${dis}></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>City</label><input name="city" value="${esc(c.city)}" ${dis}></div>
        <div class="field"><label>State / Province</label><input name="state" value="${esc(c.state)}" ${dis}></div>
        <div class="field"><label>Country</label><input name="country" value="${esc(c.country) || "Saudi Arabia"}" ${dis}></div>
        ${ro ? "" : `<div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Save</button></div>`}
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

function renderTasksEditor(parentType, parentId, discount, accountingSystem, showStatus, wo) {
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
  const canWrite = canOpsWrite();
  const showRemoveCol = !itemsLocked && canWrite;
  // Certificate/card # and the Odoo reference # only apply to Work Order
  // items, and only bite for work orders created after the completion-gate
  // feature shipped (wo.requires_completion_gate) — see
  // enforce_wo_completion_gate(). Older work orders still show the field
  // (it's still useful to record) but nothing blocks their completion over it.
  const showCertCol = itemsLocked && showStatus;
  const gateActive = !!(wo && wo.requires_completion_gate);
  return `
  <div class="wo-detail">
    ${itemsLocked && wo ? `
    <div class="form-row" style="margin-bottom:12px">
      <div class="field"><label>Work order status</label>${statusPill(wo.status)}${gateActive ? "" : `<span class="subtle" style="margin-left:6px">— created before the completion-gate update, so it's exempt</span>`}</div>
      ${wo.accounting_system === "Odoo" ? `
      <div class="field"><label>Odoo / ZATCA invoice #${gateActive ? " *" : ""}</label>
        ${canWrite
          ? `<input value="${esc(wo.odoo_invoice_number || "")}" placeholder="${gateActive ? "Required before this order can be completed" : "Optional"}" onchange="App.updateWoOdooNumber('${wo.id}',this.value)">`
          : (esc(wo.odoo_invoice_number) || "<span class=\"subtle\">not set</span>")}
      </div>` : ""}
    </div>` : ""}
    <table>
      <thead><tr><th>Service</th><th>Description</th><th class="right">Price (SAR)</th><th class="right">Discount (SAR)</th>${showCertCol ? "<th>Cert / card #</th>" : ""}${showStatus ? "<th>Status</th>" : ""}${showRemoveCol ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${tasks.length ? tasks.map((tk) => {
          const statusLocked = showStatus && (tk.status === "Delivered" || !canWrite);
          return `
          <tr>
            <td>${esc(tk.service_type) || "—"}</td>
            <td>${esc(tk.description)}</td>
            <td class="right">${fmtMoney(tk.price)}</td>
            <td class="right">${fmtMoney(tk.discount)}</td>
            ${showCertCol ? `<td>
              ${statusLocked
                ? (esc(tk.cert_number) || "<span class=\"subtle\">—</span>")
                : `<input style="width:130px" value="${esc(tk.cert_number || "")}" placeholder="${gateActive ? "Required" : "Optional"}" onchange="App.updateTaskCertNumber('${tk.id}','${parentId}',this.value)">`}
            </td>` : ""}
            ${showStatus ? `<td>
              ${statusLocked
                ? `${statusPill(tk.status)}${tk.status === "Delivered" ? `<div class="subtle">locked — final</div>` : ""}`
                : `<select onchange="App.updateTaskStatus('${tk.id}','${parentId}',this.value)">
                    ${["In Process", "Completed", "Delivered"].map((s) => `<option value="${s}" ${s === tk.status ? "selected" : ""}>${s}</option>`).join("")}
                  </select>`}
            </td>` : ""}
            ${showRemoveCol ? `<td><button class="link-btn" onclick="App.deleteTask('${tk.id}','${parentId}')">remove</button></td>` : ""}
          </tr>`;
        }).join("") : `<tr><td colspan="${4 + (showCertCol ? 1 : 0) + (showStatus ? 1 : 0) + (showRemoveCol ? 1 : 0)}" class="empty-state">No line items yet.</td></tr>`}
      </tbody>
    </table>
    ${itemsLocked
      ? `<p class="subtle" style="margin-top:10px">Line items are fixed once a work order is created — they came from the inquiry or quotation it was converted from and can't be added to or removed by anyone.</p>`
      : (canWrite ? `<form class="form-row" style="margin-top:10px" onsubmit="return App.addTask('${parentType}','${parentId}',event)">
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
    </form>` : "")}
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
  const canWrite = canOpsWrite();
  return `
  <h2 class="page-title">Inquiries</h2>
  <p class="page-sub">Capture the customer and every service they're asking about in one go, then convert it to a quotation or straight to a work order.</p>
  ${canWrite ? `
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
      <table class="items-table">
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
            <td><input type="number" step="0.01" min="0" value="${esc(it.price)}" oninput="App.setDraftItemField(${idx},'price',this.value)"></td>
            <td><input type="number" step="0.01" min="0" value="${esc(it.discount)}" oninput="App.setDraftItemField(${idx},'discount',this.value)"></td>
            <td class="right">${d.items.length > 1 ? `<button type="button" class="link-btn" onclick="App.removeDraftItemRow(${idx})">remove</button>` : ""}</td>
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
  </div>` : ""}
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Customer</th><th>Date</th><th>System</th><th>Result</th><th></th></tr></thead>
      <tbody>
        ${state.inquiries.length ? state.inquiries.map((q) => {
          const key = "inquiries:" + q.id;
          const open = !!state.expanded[key];
          const resultLabel = q.wo_number ? `WO ${q.wo_number}` : q.quote_number ? `Quote ${q.quote_number}` : pill("Open", "pending");
          const canConvert = !q.wo_id && !q.quote_id && canWrite;
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
            <td onclick="event.stopPropagation()">${q.status === "Pending" && canOpsWrite() ? `
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
  <p class="page-sub">Work orders come from Inquiries — convert one directly, or accept its Quotation. Line items are fixed the moment a work order is created — no one can add or remove one afterward. Mark each item Delivered as it's finished; once every item on an order is Delivered, its invoice and revenue posting happen by themselves, and a Delivered item's status is then locked for good. Every item needs its own certificate/card number before it can be marked Delivered, and an Odoo-system order also needs its Odoo invoice number before it can be completed — work orders created before this update are exempt.</p>
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
            <td onclick="event.stopPropagation()">${!w.cancelled && canOpsWrite() ? `<button class="btn btn-ghost btn-sm" onclick="App.cancelWorkOrder('${w.id}')">Cancel</button>` : ""}</td>
          </tr>
          ${open ? `<tr><td colspan="6">${renderTasksEditor("Work Order", w.id, w.discount, w.accounting_system, true, w)}</td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="6" class="empty-state">No work orders yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------- Invoices

// The employee's own "cash with me" card, shown at the top of the
// Operations Invoices screen — their running custody balance of cash
// they've collected but that hasn't been confirmed/handed over yet.
function renderMyCashSummary() {
  if (!canOpsWrite()) return "";
  const mine = (state.cashCollections || []).filter((c) => c.status === "pending" && c.collected_by === state.session.user.id);
  if (!mine.length) return "";
  const total = mine.reduce((s, c) => s + Number(c.amount || 0), 0);
  return `
  <div class="card" style="margin-bottom:18px">
    <h3 style="margin-top:0">Cash with you: SAR ${fmtMoney(total)}</h3>
    <p class="subtle">${mine.length} invoice(s) you've logged as collected in cash, awaiting confirmation from Owner/Manager.</p>
    <table>
      <thead><tr><th>Invoice</th><th>Customer</th><th>Collected</th><th class="right">Amount (SAR)</th><th></th></tr></thead>
      <tbody>
        ${mine.map((c) => `
        <tr>
          <td>${esc(c.invoice ? c.invoice.invoice_number : "—")}</td>
          <td>${esc(c.invoice ? c.invoice.customer : "—")}</td>
          <td>${fmtDateTime(c.collected_at)}</td>
          <td class="right">${fmtMoney(c.amount)}</td>
          <td><button class="link-btn" onclick="App.voidCashCollection('${c.id}')">undo</button></td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>`;
}
// What goes in the invoice row's payment-action cell: a paid invoice shows
// which bank it landed in; an Unpaid one with a pending cash collection
// shows who's holding the cash (and lets them/Owner/Manager undo it); a
// plain Unpaid one offers the direct "Mark paid" bank picker (for bank
// transfers, or cash Owner/Manager collected themselves) and/or the
// "I collected cash" button (for the employee-custody flow).
function renderInvoicePaidCell(inv) {
  if (inv.payment_status !== "Unpaid") {
    return inv.paid_from ? esc((state.bankAccounts.find((b) => b.id === inv.paid_from) || {}).name || "") : "";
  }
  const pending = (state.cashCollections || []).find((c) => c.invoice_id === inv.id && c.status === "pending");
  if (pending) {
    const mine = pending.collected_by === state.session.user.id;
    return `<div class="subtle">Cash collected by ${esc(pending.collector ? pending.collector.name : "—")}<br>pending confirmation</div>
      ${(mine || isMgmt()) ? `<button class="link-btn" onclick="App.voidCashCollection('${pending.id}')">undo</button>` : ""}`;
  }
  let html = "";
  if (canApproveOrManage()) {
    html += `<select onchange="App.markInvoicePaid('${inv.id}',event)">
      <option value="">Pick bank…</option>
      ${state.bankAccounts.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
    </select>`;
  }
  if (canOpsWrite()) {
    html += `<div${canApproveOrManage() ? ' style="margin-top:6px"' : ""}><button class="btn btn-ghost btn-sm" onclick="App.logCashCollection('${inv.id}')">I collected cash</button></div>`;
  }
  return html;
}
// Every invoice's total is computed from its OWN copy of its line items
// (state.invoiceTasksByInvoice — loaded in bulk by loadInvoiceTasks, see
// loadView) minus its work order's order-level discount, if it has one.
// This is the same source invoice_total()/AR Aging use server-side, so it's
// always available here too — including for invoices imported from Zoho,
// which have no work order at all.
function invoiceDisplayTotal(inv) {
  const tasks = state.invoiceTasksByInvoice[inv.id] || [];
  if (!tasks.length) return null;
  const wo = state.workOrders.find((w) => w.id === inv.wo_id);
  return taskTotals(tasks, wo ? wo.discount : 0, inv.accounting_system).total;
}
App.exportInvoices = function () {
  const rows = state.invoices.map((inv) => {
    const wo = state.workOrders.find((w) => w.id === inv.wo_id);
    return {
      "Invoice #": inv.invoice_number,
      "Work order": wo ? wo.wo_number : "— (imported)",
      "Customer": inv.customer,
      "Date": inv.invoice_date,
      "Accounting system": inv.accounting_system || "",
      "Total (SAR)": invoiceDisplayTotal(inv) || 0,
      "Status": inv.payment_status,
      "Paid via": inv.paid_from ? ((state.bankAccounts.find((b) => b.id === inv.paid_from) || {}).name || "") : "",
      "Paid at": inv.paid_at ? fmtDateTime(inv.paid_at) : "",
    };
  });
  exportRowsToExcel(`invoices-${todayStamp()}.xlsx`, [{ name: "Invoices", rows }]);
};
function renderInvoices() {
  const showActionCol = canApproveOrManage() || canOpsWrite();
  return `
  <h2 class="page-title">Invoices</h2>
  <p class="page-sub">Invoices appear here automatically once a work order is fully delivered. Most sales are cash — log what you collect below; it's marked Paid once Owner/Manager confirms the handover on Finance → Cash Collections.</p>
  ${renderMyCashSummary()}
  <div class="card">
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn btn-ghost btn-sm" onclick="App.exportInvoices()">Export to Excel</button></div>
    <table>
      <thead><tr><th>No.</th><th>Work order</th><th>Customer</th><th>Date</th><th class="right">Total (SAR)</th><th>Status</th>${showActionCol ? "<th>Payment</th>" : ""}</tr></thead>
      <tbody>
        ${state.invoices.length ? state.invoices.map((inv) => {
          const wo = state.workOrders.find((w) => w.id === inv.wo_id);
          const total = invoiceDisplayTotal(inv);
          return `
          <tr>
            <td>${esc(inv.invoice_number)}</td><td>${wo ? esc(wo.wo_number) : "<span class=\"subtle\">— imported</span>"}</td><td>${esc(inv.customer)}</td>
            <td>${fmtDate(inv.invoice_date)}</td>
            <td class="right">${total !== null ? fmtMoney(total) : "—"}</td>
            <td>${pill(inv.payment_status, inv.payment_status === "Paid" ? "paid" : "unpaid")}${inv.paid_at ? `<div class="subtle">${fmtDateTime(inv.paid_at)}</div>` : ""}</td>
            ${showActionCol ? `<td>${renderInvoicePaidCell(inv)}</td>` : ""}
          </tr>`;
        }).join("") : `<tr><td colspan="${showActionCol ? 7 : 6}" class="empty-state">No invoices yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------- Cash Collections

function renderCashCollections() {
  const pending = (state.cashCollections || []).filter((c) => c.status === "pending");
  const confirmed = (state.cashCollections || []).filter((c) => c.status === "confirmed").slice(0, 15);
  const cashAccount = (state.bankAccounts || []).find((b) => b.is_cash_custody);
  const cashBal = cashAccount ? (state.bankBalances || []).find((b) => b.id === cashAccount.id) : null;
  const totalPending = pending.reduce((s, c) => s + Number(c.amount || 0), 0);

  const byEmployee = {};
  pending.forEach((c) => {
    const key = c.collected_by;
    if (!byEmployee[key]) byEmployee[key] = { name: c.collector ? c.collector.name : "—", rows: [] };
    byEmployee[key].rows.push(c);
  });

  const selectedIds = Object.keys(state.selectedCash || {}).filter((k) => state.selectedCash[k]);
  const selectedTotal = pending.filter((c) => selectedIds.includes(c.id)).reduce((s, c) => s + Number(c.amount || 0), 0);

  return `
  <h2 class="page-title">Cash Collections</h2>
  <p class="page-sub">Employees log cash they've collected from customers on the Invoices screen. Confirming a handover here is what actually marks those invoices Paid and moves the cash from that employee into Cash in Hand.</p>
  <div class="kpi-grid">
    <div class="kpi ${pending.length ? "accent" : ""}"><div class="label">Pending with employees</div><div class="value">${fmtMoney(totalPending)}</div></div>
    <div class="kpi"><div class="label">Cash in hand</div><div class="value">${cashBal ? fmtMoney(cashBal.current_balance) : "—"}</div><div class="hint">Confirmed cash currently with Owner/Manager</div></div>
    <div class="kpi"><div class="label">Selected to confirm</div><div class="value">${fmtMoney(selectedTotal)}</div></div>
  </div>
  ${Object.keys(byEmployee).length ? Object.entries(byEmployee).map(([empId, grp]) => {
    const allSelected = grp.rows.length > 0 && grp.rows.every((c) => state.selectedCash && state.selectedCash[c.id]);
    const empTotal = grp.rows.reduce((s, c) => s + Number(c.amount || 0), 0);
    return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <h3 style="margin:0">${esc(grp.name)} — SAR ${fmtMoney(empTotal)} pending</h3>
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" ${allSelected ? "checked" : ""} onchange="App.toggleCashSelectAllFor('${empId}')"> select all
        </label>
      </div>
      <table>
        <thead><tr><th></th><th>Invoice</th><th>Customer</th><th>Collected</th><th class="right">Amount (SAR)</th></tr></thead>
        <tbody>
          ${grp.rows.map((c) => `
          <tr>
            <td><input type="checkbox" ${state.selectedCash && state.selectedCash[c.id] ? "checked" : ""} onchange="App.toggleCashSelect('${c.id}')"></td>
            <td>${esc(c.invoice ? c.invoice.invoice_number : "—")}</td>
            <td>${esc(c.invoice ? c.invoice.customer : "—")}</td>
            <td>${fmtDateTime(c.collected_at)}</td>
            <td class="right">${fmtMoney(c.amount)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  }).join("") : `<div class="card empty-state">No pending cash collections.</div>`}
  <div class="card">
    <button class="btn btn-primary" ${selectedIds.length ? "" : "disabled"} onclick="App.confirmSelectedCash()">Confirm &amp; mark paid (${selectedIds.length})</button>
  </div>
  ${confirmed.length ? `
  <div class="card">
    <h3 style="margin-top:0">Recently confirmed</h3>
    <table>
      <thead><tr><th>Invoice</th><th>Customer</th><th>Employee</th><th>Confirmed by</th><th>Confirmed</th><th class="right">Amount (SAR)</th></tr></thead>
      <tbody>
        ${confirmed.map((c) => `
        <tr>
          <td>${esc(c.invoice ? c.invoice.invoice_number : "—")}</td>
          <td>${esc(c.invoice ? c.invoice.customer : "—")}</td>
          <td>${esc(c.collector ? c.collector.name : "—")}</td>
          <td>${esc(c.confirmer ? c.confirmer.name : "—")}</td>
          <td>${fmtDateTime(c.confirmed_at)}</td>
          <td class="right">${fmtMoney(c.amount)}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>` : ""}`;
}

// ---------------------------------------------------------- Import Data

// Historical Zoho invoices, brought in from an Excel file — Owner/Manager
// only (see import_historical_invoices()). Header names are matched
// case/spacing-insensitively against IMPORT_FIELD_MAP, so the template
// below isn't the only spelling that works, just the reliable one.
const IMPORT_FIELD_MAP = {
  customername: "customer_name", customer: "customer_name",
  invoicenumber: "invoice_number", invoiceno: "invoice_number", "invoice#": "invoice_number",
  invoicedate: "invoice_date", date: "invoice_date",
  description: "description", item: "description", serviceitem: "description",
  amount: "amount", amountsar: "amount", subtotal: "amount",
  accountingsystem: "accounting_system", system: "accounting_system",
  paymentstatus: "payment_status", status: "payment_status",
  paiddate: "paid_date",
  paidvia: "paid_via", bank: "paid_via", paidfrom: "paid_via",
  vatregno: "vat_reg_no", vatregistrationno: "vat_reg_no",
  notes: "notes", note: "notes",
};
function normalizeHeader(h) {
  return String(h || "").toLowerCase().replace(/[^a-z0-9#]/g, "");
}
function excelDateToIso(v) {
  if (!v && v !== 0) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}
function importRowIssues(r) {
  const issues = [];
  if (!r.customer_name) issues.push("missing customer");
  if (!r.invoice_number) issues.push("missing invoice #");
  if (!r.invoice_date) issues.push("missing/unreadable date");
  if (!r.amount || isNaN(Number(r.amount)) || Number(r.amount) <= 0) issues.push("missing/invalid amount");
  if (!r.accounting_system || !["Odoo", "Zoho"].includes(r.accounting_system)) issues.push("system must be Odoo or Zoho");
  const pay = r.payment_status || "Unpaid";
  if (!["Paid", "Unpaid"].includes(pay)) issues.push("payment status must be Paid or Unpaid");
  if (pay === "Paid") {
    if (!r.paid_via) issues.push("Paid rows need Paid Via");
    else if (!state.bankAccounts.some((b) => b.name.toLowerCase() === r.paid_via.toLowerCase())) issues.push(`unknown bank "${r.paid_via}"`);
  }
  return issues;
}
App.downloadImportTemplate = function () {
  exportRowsToExcel("zoho-invoice-import-template.xlsx", [{
    name: "Invoices",
    rows: [{
      "Customer Name": "Acme Factory LLC", "Invoice Number": "ZOHO-INV-00123", "Invoice Date": "2026-01-15",
      "Description": "Calibration - Torque wrench 0-200 Nm", "Amount": 850, "Accounting System": "Odoo",
      "Payment Status": "Paid", "Paid Date": "2026-01-20", "Paid Via": "BSF", "VAT Reg No": "", "Notes": "",
    }],
  }]);
};
App.handleImportFile = function (ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (typeof XLSX === "undefined") { showToast("Excel import isn't available right now — try reloading the page", true); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });
      const rows = raw.map((r) => {
        const out = {};
        Object.keys(r).forEach((k) => {
          const field = IMPORT_FIELD_MAP[normalizeHeader(k)];
          if (!field || r[k] === "") return;
          out[field] = field.includes("date") ? excelDateToIso(r[k]) : String(r[k]).trim();
        });
        return out;
      }).filter((r) => Object.keys(r).length);
      if (!rows.length) { showToast("No readable rows found in that file", true); return; }
      state.importPreview = { rows, fileName: file.name };
      state.importResult = null;
      render();
    } catch (err) {
      showToast("Couldn't read that file — make sure it's the .xlsx template", true);
    }
  };
  reader.readAsArrayBuffer(file);
  ev.target.value = "";
};
App.clearImportPreview = function () {
  state.importPreview = null;
  state.importResult = null;
  render();
};
App.confirmImport = async function () {
  if (!state.importPreview || !state.importPreview.rows.length || state.importBusy) return;
  state.importBusy = true;
  render();
  const { data, error } = await sb.rpc("import_historical_invoices", { p_rows: state.importPreview.rows });
  state.importBusy = false;
  if (error) { showToast(error.message, true); render(); return; }
  state.importResult = data;
  state.importPreview = null;
  showToast(`Imported ${data.inserted_count} invoice(s) — SAR ${fmtMoney(data.total_amount)}${data.skipped && data.skipped.length ? `, ${data.skipped.length} skipped (see below)` : ""}`, data.inserted_count === 0);
  await Promise.all([loadCustomers(), loadBankAccounts()]);
  render();
};
function renderImportData() {
  const preview = state.importPreview;
  const rowsWithIssues = preview ? preview.rows.map((r) => ({ r, issues: importRowIssues(r) })) : [];
  const okCount = rowsWithIssues.filter((x) => !x.issues.length).length;
  const sampleBank = (state.bankAccounts[0] || {}).name || "BSF";
  return `
  <h2 class="page-title">Import Data</h2>
  <p class="page-sub">Bring your historical Zoho invoices in from Excel — each row becomes a customer (matched by name, or created fresh) and a finished invoice with the right VAT and payment status already applied, exactly as if it had been entered here all along. Nothing here reopens old jobs as active work orders.</p>
  <div class="card">
    <h3 style="margin-top:0">1. Download the template</h3>
    <p class="subtle">One row per invoice. Required: Customer Name, Invoice Number, Invoice Date, Amount, Accounting System (Odoo or Zoho). Payment Status defaults to Unpaid — set it to Paid and fill in Paid Date + Paid Via (must match a bank account name exactly, e.g. "${esc(sampleBank)}" or "Cash in Hand") for invoices you've already collected.</p>
    <button class="btn btn-ghost btn-sm" onclick="App.downloadImportTemplate()">Download template (.xlsx)</button>
  </div>
  <div class="card">
    <h3 style="margin-top:0">2. Upload your filled-in file</h3>
    <input type="file" accept=".xlsx,.xls" onchange="App.handleImportFile(event)">
    ${preview ? `<p class="subtle" style="margin-top:8px">${esc(preview.fileName)} — ${preview.rows.length} row(s) read, ${okCount} look ready to import.</p>` : ""}
  </div>
  ${preview && preview.rows.length ? `
  <div class="card">
    <h3 style="margin-top:0">3. Review &amp; confirm</h3>
    <table>
      <thead><tr><th>Customer</th><th>Invoice #</th><th>Date</th><th class="right">Amount</th><th>System</th><th>Payment</th><th>Issues</th></tr></thead>
      <tbody>
        ${rowsWithIssues.map(({ r, issues }) => `
        <tr>
          <td>${esc(r.customer_name) || "—"}</td><td>${esc(r.invoice_number) || "—"}</td><td>${esc(r.invoice_date) || "—"}</td>
          <td class="right">${esc(r.amount) || "—"}</td><td>${esc(r.accounting_system) || "—"}</td>
          <td>${esc(r.payment_status || "Unpaid")}${r.paid_via ? " via " + esc(r.paid_via) : ""}</td>
          <td>${issues.length ? `<span class="subtle" style="color:#b91c1c">${esc(issues.join(", "))}</span>` : "✓ looks good"}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px">
      <button class="btn btn-primary" ${state.importBusy ? "disabled" : ""} onclick="App.confirmImport()">${state.importBusy ? "Importing…" : `Import ${preview.rows.length} row(s)`}</button>
      <button class="btn btn-ghost" onclick="App.clearImportPreview()">Cancel</button>
    </div>
    <p class="subtle" style="margin-top:8px">Flagged rows are still sent — the database does the final check and reports exactly why any row didn't import, so you can fix just those and re-upload them alone.</p>
  </div>` : ""}
  ${state.importResult ? `
  <div class="card">
    <h3 style="margin-top:0">Last import result</h3>
    <p>Imported <b>${state.importResult.inserted_count}</b> invoice(s) totalling <b>SAR ${fmtMoney(state.importResult.total_amount)}</b>.</p>
    ${state.importResult.skipped && state.importResult.skipped.length ? `
    <p class="subtle">${state.importResult.skipped.length} row(s) skipped:</p>
    <table>
      <thead><tr><th>Row</th><th>Customer</th><th>Invoice #</th><th>Reason</th></tr></thead>
      <tbody>${state.importResult.skipped.map((s) => `<tr><td>${s.row}</td><td>${esc(s.customer)}</td><td>${esc(s.invoice_number)}</td><td>${esc(s.reason)}</td></tr>`).join("")}</tbody>
    </table>` : `<p class="subtle">Every row imported cleanly.</p>`}
  </div>` : ""}`;
}

// ---------------------------------------------------------- Expenses

function expensePillCls(status) {
  return { Pending: "pending", Approved: "accepted", Rejected: "rejected" }[status] || "pending";
}
function renderExpenses() {
  const pendingCount = state.expenses.filter((e) => e.status === "Pending").length;
  const awaitingPayment = state.expenses.filter((e) => e.status === "Approved" && e.payment_status === "Unpaid").reduce((s, e) => s + Number(e.amount || 0), 0);
  const thisMonth = firstOfThisMonth();
  const paidThisMonth = state.expenses.filter((e) => e.payment_status === "Paid" && (e.paid_at || "").slice(0, 10) >= thisMonth).reduce((s, e) => s + Number(e.amount || 0), 0);
  return `
  <h2 class="page-title">Expenses</h2>
  <p class="page-sub">Every expense needs approving, then paying — paying it is what posts it to the ledger, against the account you pick below, and deducts it from the bank.</p>
  <div class="kpi-grid">
    <div class="kpi ${pendingCount ? "accent" : ""}"><div class="label">Pending approval</div><div class="value">${pendingCount}</div></div>
    <div class="kpi"><div class="label">Awaiting payment</div><div class="value">${fmtMoney(awaitingPayment)}</div></div>
    <div class="kpi"><div class="label">Paid this month</div><div class="value">${fmtMoney(paidThisMonth)}</div></div>
  </div>
  ${isApprover() ? "" : `
  <div class="card">
    <h3>New expense</h3>
    <form onsubmit="return App.addExpense(event)">
      <div class="form-row">
        <div class="field"><label>Date</label><input type="date" name="expense_date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Account *</label><select name="account_code" required>${expenseAccountOptions("5300")}</select></div>
        <div class="field"><label>Vendor</label><input name="vendor" placeholder="Who was this paid to?"></div>
        <div class="field"><label>Amount (SAR)</label><input name="amount" type="number" step="0.01" min="0.01" required></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field" style="flex:2"><label>Description</label><input name="description" placeholder="What is this expense for?"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add</button></div>
      </div>
    </form>
  </div>`}
  <div class="card">
    <div class="form-row" style="margin-bottom:12px"><div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" onclick="App.exportExpenses()">Export to Excel</button></div></div>
    <table>
      <thead><tr><th>No.</th><th>Date</th><th>Account</th><th>Vendor</th><th>Description</th><th class="right">Amount</th><th>Status</th><th>Payment</th><th></th></tr></thead>
      <tbody>
        ${state.expenses.length ? state.expenses.map((e) => `
          <tr>
            <td>${esc(e.expense_number)}</td><td>${fmtDate(e.expense_date)}</td>
            <td>${pill(accountName(e.account_code), "closed")}</td>
            <td>${esc(e.vendor) || "—"}</td><td>${esc(e.description) || "—"}</td>
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
          </tr>`).join("") : `<tr><td colspan="9" class="empty-state">No expenses yet.</td></tr>`}
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

// ------------------------------------------------------- Team (employee logins)

function roleOptions(selected) {
  return ALL_ROLES.map((r) => `<option value="${esc(r)}" ${r === selected ? "selected" : ""}>${esc(r)}</option>`).join("");
}
function roleHelpText(role) {
  return {
    Owner: "Full access to everything, including managing the team.",
    Manager: "Full access to Operations and Finance — everything but managing the team.",
    "Operations Staff": "Full Operations access (customers through invoices). No Finance access at all.",
    Approver: "Finance access limited to Invoices & Expenses — mark invoices paid, approve/reject/pay expenses. No Payroll, Journal Entries, Reports, Chart of Accounts or Employees.",
    Viewer: "Read-only access to Operations (customers through invoices). No Finance access at all.",
  }[role] || "";
}
function renderTeam() {
  const me = state.session.user.id;
  return `
  <h2 class="page-title">Team</h2>
  <p class="page-sub">Employee logins — separate from the Employees payroll roster. Each person's role decides what they can see and do; changing it here takes effect immediately. Deactivating someone signs them out and blocks sign-in until they're reactivated.</p>
  <div class="card">
    <h3>Add an employee login</h3>
    <form onsubmit="return App.createTeamMember(event)">
      <div class="form-row">
        <div class="field"><label>Name *</label><input name="name" required></div>
        <div class="field"><label>Email *</label><input name="email" type="email" required></div>
        <div class="field"><label>Role *</label><select name="role" required>
          <option value="">— pick —</option>
          ${roleOptions("")}
        </select></div>
        <div class="field"><label>Temporary password *</label><input name="password" type="text" required minlength="8" placeholder="At least 8 characters"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit" ${state.teamBusy ? "disabled" : ""}>${state.teamBusy ? "Creating…" : "Create login"}</button></div>
      </div>
      <p class="subtle" style="margin-top:6px">Share this temporary password with them directly — they can sign in with it right away. There's no reset-your-own-password email flow yet, so use "reset password" below if they lose it.</p>
    </form>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.team.length ? state.team.map((p) => `
          <tr>
            <td>${esc(p.name)}${p.id === me ? ` <span class="subtle">(you)</span>` : ""}</td>
            <td>${esc(p.email) || "—"}</td>
            <td>
              <select ${p.id === me ? "disabled title=\"You can't change your own role\"" : ""} onchange="App.changeTeamMemberRole('${p.id}',this.value)">
                ${roleOptions(p.role)}
              </select>
              <div class="subtle" style="max-width:260px">${esc(roleHelpText(p.role))}</div>
            </td>
            <td>${p.active ? pill("Active", "delivered") : pill("Deactivated", "cancelled")}</td>
            <td>
              <button class="link-btn" onclick="App.resetTeamMemberPassword('${p.id}','${esc(p.name).replace(/'/g, "\\'")}')" ${state.teamBusy ? "disabled" : ""}>reset password</button>
              ${p.id === me ? "" : (p.active
                ? `<button class="link-btn" onclick="App.deactivateTeamMember('${p.id}','${esc(p.name).replace(/'/g, "\\'")}')" ${state.teamBusy ? "disabled" : ""}>deactivate</button>`
                : `<button class="link-btn" onclick="App.reactivateTeamMember('${p.id}','${esc(p.name).replace(/'/g, "\\'")}')" ${state.teamBusy ? "disabled" : ""}>reactivate</button>`)}
            </td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty-state">Loading team…</td></tr>`}
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

// ------------------------------------------------------------ Fixed Assets (Asset Register)

function renderFixedAssets() {
  return `
  <h2 class="page-title">Asset Register</h2>
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
  const q = (state.coaSearch || "").trim().toLowerCase();
  const searching = !!q;
  const matches = (a) => !q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
  const all = state.accountBalances.slice().sort((a, b) => a.code.localeCompare(b.code));
  const groups = ACCOUNT_TYPES.map((type) => ({
    type,
    accounts: all.filter((a) => a.account_type === type && matches(a)),
  })).filter((g) => g.accounts.length || !searching);
  const coaTypeLabel = (t) => (t === "ContraAsset" ? "Contra-Asset" : t === "ContraEquity" ? "Contra-Equity" : t);
  return `
  <h2 class="page-title">Chart of Accounts</h2>
  <p class="page-sub">Every account everything else in Finance posts against, grouped by type — click a group to collapse it. Balances are live, as of right now.${owner ? " Accounts the system posts to automatically are marked (system) and can be renamed or retyped but not deleted; any other account can be deleted once it has no transactions against it." : " Only the Owner can add, edit or delete accounts."}</p>
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
            ${ACCOUNT_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}
          </select>
        </div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add</button></div>
      </div>
    </form>
  </div>` : ""}
  <div class="card">
    <div class="form-row">
      <div class="field" style="flex:2"><label>Search</label><input value="${esc(state.coaSearch)}" oninput="App.setCoaSearch(this.value)" placeholder="Account code or name"></div>
      <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" type="button" onclick="App.exportChartOfAccounts()">Export to Excel</button></div>
    </div>
  </div>
  ${!all.length ? `<div class="card"><div class="empty-state">No accounts yet.</div></div>` :
    groups.map((g) => {
      const collapsed = !searching && !!state.coaCollapsed[g.type];
      const subtotal = g.accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
      return `
      <div class="card">
        <div class="form-row" style="cursor:pointer;margin-bottom:${collapsed ? "0" : "10px"}" onclick="App.toggleCoaGroup('${g.type}')">
          <h4 style="margin:0">${collapsed ? "▸" : "▾"} ${esc(coaTypeLabel(g.type))} <span class="subtle">(${g.accounts.length})</span></h4>
          <div style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink)">${fmtMoney(subtotal)} SAR</div>
        </div>
        ${collapsed ? "" : `
        <table>
          <thead><tr><th>Code</th><th>Account</th><th class="right">Balance (SAR)</th><th></th></tr></thead>
          <tbody>
            ${g.accounts.length ? g.accounts.map((a) => {
              const isSystem = SYSTEM_ACCOUNT_CODES.includes(a.code);
              if (owner && state.coaEditingCode === a.code) {
                return `
              <tr class="coa-edit-row">
                <td>${esc(a.code)}</td>
                <td><input id="coaEditName-${esc(a.code)}" value="${esc(a.name)}" style="width:100%"></td>
                <td class="right">
                  <select id="coaEditType-${esc(a.code)}" style="width:100%">
                    ${ACCOUNT_TYPES.map((t) => `<option value="${t}" ${t === a.account_type ? "selected" : ""}>${esc(coaTypeLabel(t))}</option>`).join("")}
                  </select>
                </td>
                <td style="white-space:nowrap">
                  <button class="link-btn" onclick="App.saveChartAccount('${a.code}')">save</button>
                  &nbsp;·&nbsp;
                  <button class="link-btn" onclick="App.cancelEditChartAccount()">cancel</button>
                </td>
              </tr>`;
              }
              return `
              <tr>
                <td>${esc(a.code)}</td><td>${esc(a.name)}${isSystem ? ` <span class="subtle">(system)</span>` : ""}</td>
                <td class="right">${fmtMoney(a.balance)}</td>
                <td style="white-space:nowrap">
                  <button class="link-btn" onclick="App.viewAccountLedger('${a.code}')">view ledger</button>
                  ${owner ? `
                  &nbsp;·&nbsp;<button class="link-btn" onclick="App.startEditChartAccount('${a.code}')">edit</button>
                  ${isSystem ? "" : `&nbsp;·&nbsp;<button class="link-btn danger" onclick="App.deleteChartAccount('${a.code}','${esc(a.name).replace(/'/g, "&#39;")}')">delete</button>`}` : ""}
                </td>
              </tr>`;
            }).join("") : `<tr><td colspan="4" class="empty-state">No accounts of this type${searching ? " match this search" : ""}.</td></tr>`}
          </tbody>
        </table>`}
      </div>`;
    }).join("")}`;
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
  const editing = state.jeEditingId;
  const f = state.jeFilter;
  const all = state.journalEntries;
  const rows = filteredJournalEntries();
  const drafts = all.filter((je) => je.status === "draft").length;
  const thisMonth = firstOfThisMonth();
  const postedThisMonth = all.filter((je) => je.status === "posted" && je.je_date >= thisMonth).length;
  return `
  <h2 class="page-title">Journal Entries</h2>
  <p class="page-sub">Manual entries for anything that doesn't post itself — corrections, accruals, opening balances. A new entry saves as a Draft first; it only affects the books, and locks for good, once you post it.</p>
  <div class="kpi-grid">
    <div class="kpi"><div class="label">Total entries</div><div class="value">${all.length}</div></div>
    <div class="kpi ${drafts ? "accent" : ""}"><div class="label">Drafts awaiting posting</div><div class="value">${drafts}</div></div>
    <div class="kpi"><div class="label">Posted this month</div><div class="value">${postedThisMonth}</div></div>
  </div>
  <div class="card" id="jeForm">
    <h3>${editing ? "Editing draft entry" : "New journal entry"}</h3>
    <form onsubmit="return App.saveJournalEntryDraft(event)">
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
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">${editing ? "Save changes" : "Save as draft"}</button></div>
        ${editing ? `<div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost" type="button" onclick="App.cancelJeEdit()">Cancel</button></div>` : ""}
      </div>
      <div class="totals-line" id="jeDraftTotals">Total debit: <b>${fmtMoney(t.debit)}</b> &nbsp; Total credit: <b>${fmtMoney(t.credit)}</b> &nbsp;
        <span class="balance-flag ${t.balanced ? "ok" : "bad"}">${t.balanced ? "Balanced" : "Not balanced"}</span></div>
    </form>
  </div>
  <div class="card">
    <form class="form-row" onsubmit="return false">
      <div class="field" style="flex:2"><label>Search</label><input value="${esc(f.search)}" oninput="App.setJeFilter('search',this.value)" placeholder="Memo or entry no."></div>
      <div class="field"><label>Status</label><select onchange="App.setJeFilter('status',this.value)">
        <option value="" ${!f.status ? "selected" : ""}>All</option>
        <option value="draft" ${f.status === "draft" ? "selected" : ""}>Draft</option>
        <option value="posted" ${f.status === "posted" ? "selected" : ""}>Posted</option>
      </select></div>
      <div class="field"><label>From</label><input type="date" value="${esc(f.from)}" oninput="App.setJeFilter('from',this.value)"></div>
      <div class="field"><label>To</label><input type="date" value="${esc(f.to)}" oninput="App.setJeFilter('to',this.value)"></div>
      <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" type="button" onclick="App.exportJournalEntries()">Export to Excel</button></div>
    </form>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Date</th><th>Memo</th><th>Source</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.length ? rows.map((je) => {
          const key = "journalentries:" + je.id;
          const open = !!state.expanded[key];
          const lines = state.journalLinesByJe[je.id] || [];
          const isDraft = je.status === "draft";
          return `
          <tr class="clickable" onclick="App.toggle('journalentries','${je.id}')">
            <td>${esc(je.je_number)}</td><td>${fmtDate(je.je_date)}</td><td>${esc(je.memo)}</td>
            <td>${je.source === "manual" ? pill("Manual", "pending") : esc(je.source)}</td>
            <td>${isDraft ? pill("Draft", "unpaid") : pill("Posted", "paid")}</td>
            <td onclick="event.stopPropagation()">
              <button class="link-btn" onclick="App.toggle('journalentries','${je.id}')">${open ? "close" : "view lines"}</button>
              ${isDraft ? `
              &nbsp;·&nbsp;<button class="link-btn" onclick="App.editJournalEntryDraft('${je.id}')">edit</button>
              &nbsp;·&nbsp;<button class="link-btn" onclick="App.postJournalEntryDraft('${je.id}')">post</button>
              &nbsp;·&nbsp;<button class="link-btn" onclick="App.discardJournalEntryDraft('${je.id}')">discard</button>` : ""}
            </td>
          </tr>
          ${open ? `<tr><td colspan="6"><div class="wo-detail">
            ${isDraft ? `<p class="subtle" style="margin-top:0">Still a draft — this entry isn't reflected in any financial statement yet.</p>` : ""}
            <table>
              <thead><tr><th>Account</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead>
              <tbody>
                ${lines.length ? lines.map((l) => `<tr><td>${esc(l.account_code)}</td><td class="right">${fmtMoney(l.debit)}</td><td class="right">${fmtMoney(l.credit)}</td></tr>`).join("") : `<tr><td colspan="3" class="empty-state">Loading…</td></tr>`}
              </tbody>
            </table>
          </div></td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="6" class="empty-state">${all.length ? "No entries match this filter." : "No journal entries yet."}</td></tr>`}
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
      <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" type="button" onclick="App.exportGeneralLedger()">Export to Excel</button></div>
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

// ------------------------------------------------------------ Finance Dashboard

// Renders a multi-line chart, one line per selected KPI, sharing a single
// scale — that's what lets "select Sales and Expenses" and "select Cash on
// hand too" all land on one comparable chart, per the KPI tiles' selection.
function renderTrendChart(trend, selectedKeys) {
  const metrics = FINANCE_KPI_METRICS.filter((m) => selectedKeys.includes(m.key));
  const allVals = trend.flatMap((m) => metrics.map((k) => Number(m[k.key]) || 0));
  const maxVal = Math.max(1, ...allVals);
  const minVal = Math.min(0, ...allVals);
  const range = Math.max(1, maxVal - minVal);
  const top = 16, chartH = 140, left = 44, right = 620;
  const n = Math.max(1, trend.length);
  const stepX = trend.length > 1 ? (right - left) / (trend.length - 1) : 0;
  const xAt = (i) => left + i * stepX;
  const yAt = (v) => top + chartH - ((v - minVal) / range) * chartH;
  const zeroY = yAt(0);
  const lines = metrics.map((metric) => {
    const pts = trend.map((m, i) => [xAt(i), yAt(Number(m[metric.key]) || 0)]);
    const path = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const dots = pts.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${metric.color}"><title>${esc(trend[i].label)} — ${esc(metric.label)}: ${fmtMoney(trend[i][metric.key])}</title></circle>`).join("");
    return `<path d="${path}" fill="none" stroke="${metric.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join("");
  const xLabels = trend.map((m, i) => `<text x="${xAt(i).toFixed(1)}" y="${top + chartH + 18}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(m.label)}</text>`).join("");
  return `<svg viewBox="0 0 660 190" width="100%" style="max-width:660px;display:block" role="img" aria-label="Trailing 6-month trend for ${esc(metrics.map((m) => m.label).join(", "))}">
    <line x1="${left}" y1="${zeroY.toFixed(1)}" x2="${right}" y2="${zeroY.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
    ${lines}
    ${xLabels}
  </svg>`;
}

function renderFinanceDashboard() {
  const { from, to } = state.statementDates.financedashboard;
  const d = state.financeDashboard;
  const preset = state.financeDashboardPreset;
  const selected = state.financeDashboardMetrics;
  const currentValue = {
    revenue: d.revenue, expense: d.expense, netIncome: d.netIncome, netCashFlow: d.netCashFlow,
    cashOnHand: d.endCash, arOutstanding: d.arTotal, apOutstanding: d.apTotal,
  };
  const hint = {
    revenue: `${fmtDate(from)} – ${fmtDate(to)}`, expense: `${fmtDate(from)} – ${fmtDate(to)}`,
    netIncome: "Sales minus expenses", netCashFlow: "Cash in minus cash out",
    cashOnHand: `As of ${fmtDate(to)}`, arOutstanding: "Unpaid invoices, as of today",
    apOutstanding: "Owed to vendors & payroll, as of today",
  };
  const chartTitle = selected.length <= 3
    ? `${FINANCE_KPI_METRICS.filter((m) => selected.includes(m.key)).map((m) => m.label).join(" vs ")} — trailing 6 months`
    : `${selected.length} metrics compared — trailing 6 months`;
  return `
  <h2 class="page-title">Finance Dashboard</h2>
  <p class="page-sub">Sales, expenses and cash flow for the selected period, plus cash and AR/AP outstanding as of today. Click any figure on the right to plot it on the chart — click more than one to compare them on the same chart.</p>
  <div class="card findash-toolbar">
    <form class="statement-meta" onsubmit="return App.runFinanceDashboard(event)">
      <div class="dash-presets">
        ${FINANCE_DASH_PRESETS.map((p) => `<button type="button" class="btn btn-ghost btn-sm ${preset === p.id ? "active" : ""}" onclick="App.setFinanceDashboardPreset('${p.id}')">${p.label}</button>`).join("")}
      </div>
      <div class="dash-period-controls">
        <label class="inline-date-label">From <input type="date" value="${esc(from)}" oninput="App.setFinanceDashboardDate('from',this.value)"></label>
        <label class="inline-date-label">To <input type="date" value="${esc(to)}" oninput="App.setFinanceDashboardDate('to',this.value)"></label>
        <button class="btn btn-ghost btn-sm" type="submit">Run</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick="App.exportFinanceDashboard()">Export to Excel</button>
      </div>
    </form>
  </div>
  <div class="findash-layout">
    <div class="card trend-card findash-chart-col">
      <h3 style="margin:0 0 4px;font-size:14px;color:var(--ink)">${esc(chartTitle)}</h3>
      <div class="trend-legend">
        ${FINANCE_KPI_METRICS.filter((m) => selected.includes(m.key)).map((m) => `
          <button type="button" class="leg-item active" style="color:${m.color}" onclick="App.toggleFinanceMetric('${m.key}')"><span class="dot" style="background:${m.color}"></span>${esc(m.label)}</button>`).join("")}
      </div>
      ${renderTrendChart(d.trend, selected)}
    </div>
    <div class="findash-kpi-col">
      ${FINANCE_KPI_METRICS.map((m) => {
        const value = currentValue[m.key];
        const isNeg = (m.key === "netIncome" || m.key === "netCashFlow") && value < 0;
        const isSel = selected.includes(m.key);
        return `
      <div class="findash-kpi-row ${isSel ? "selected" : ""} ${isNeg ? "negative" : ""}" style="--kpi-color:${m.color}" onclick="App.toggleFinanceMetric('${m.key}')">
        <div class="stripe"></div>
        <div class="body">
          <div class="row-label">${esc(m.label)}</div>
          <div class="row-value">${fmtMoney(value)}</div>
          <div class="row-hint">${esc(hint[m.key])}</div>
        </div>
      </div>`;
      }).join("")}
    </div>
  </div>`;
}

function renderTrialBalance() {
  const asOf = state.statementDates.trialbalance.asOf;
  const rows = state.trialBalanceRows;
  const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
  const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
  return `
  <h2 class="page-title">Trial Balance</h2>
  <div class="kpi-grid">
    <div class="kpi"><div class="label">Total debit</div><div class="value">${fmtMoney(totalDebit)}</div></div>
    <div class="kpi"><div class="label">Total credit</div><div class="value">${fmtMoney(totalCredit)}</div></div>
    <div class="kpi accent"><div class="label">Status</div><div class="value" style="font-size:16px">${balanced ? "Balanced" : "Out of balance"}</div></div>
  </div>
  <div class="card">
    <form class="statement-meta" onsubmit="return App.runStatement('trialbalance',event)">
      <div class="field"><label>As of</label><input type="date" value="${esc(asOf)}" oninput="App.setStatementDate('trialbalance','asOf',this.value)"></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="submit">Run</button></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="button" onclick="App.exportTrialBalance()">Export to Excel</button></div>
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
  <div class="kpi-grid">
    <div class="kpi"><div class="label">Total revenue</div><div class="value">${fmtMoney(totalRevenue)}</div></div>
    <div class="kpi"><div class="label">Total expenses</div><div class="value">${fmtMoney(totalExpense)}</div></div>
    <div class="kpi accent"><div class="label">Net income</div><div class="value">${fmtMoney(netIncome)}</div></div>
  </div>
  <div class="card">
    <form class="statement-meta" onsubmit="return App.runStatement('incomestatement',event)">
      <div class="field"><label>From</label><input type="date" value="${esc(from)}" oninput="App.setStatementDate('incomestatement','from',this.value)"></div>
      <div class="field"><label>To</label><input type="date" value="${esc(to)}" oninput="App.setStatementDate('incomestatement','to',this.value)"></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="submit">Run</button></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="button" onclick="App.exportIncomeStatement()">Export to Excel</button></div>
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
  <div class="kpi-grid">
    <div class="kpi"><div class="label">Total assets</div><div class="value">${fmtMoney(totalAssets)}</div></div>
    <div class="kpi"><div class="label">Total liabilities</div><div class="value">${fmtMoney(totalLiabilities)}</div></div>
    <div class="kpi accent"><div class="label">Total equity</div><div class="value">${fmtMoney(totalEquity)}</div></div>
  </div>
  <div class="card">
    <form class="statement-meta" onsubmit="return App.runStatement('balancesheet',event)">
      <div class="field"><label>As of</label><input type="date" value="${esc(asOf)}" oninput="App.setStatementDate('balancesheet','asOf',this.value)"></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="submit">Run</button></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="button" onclick="App.exportBalanceSheet()">Export to Excel</button></div>
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
  <div class="kpi-grid">
    <div class="kpi"><div class="label">Cash at start</div><div class="value">${fmtMoney(begin)}</div></div>
    <div class="kpi"><div class="label">Net change</div><div class="value">${fmtMoney(netChange)}</div></div>
    <div class="kpi accent"><div class="label">Cash at end</div><div class="value">${fmtMoney(end)}</div></div>
  </div>
  <div class="card">
    <form class="statement-meta" onsubmit="return App.runStatement('cashflow',event)">
      <div class="field"><label>From</label><input type="date" value="${esc(from)}" oninput="App.setStatementDate('cashflow','from',this.value)"></div>
      <div class="field"><label>To</label><input type="date" value="${esc(to)}" oninput="App.setStatementDate('cashflow','to',this.value)"></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="submit">Run</button></div>
      <div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" type="button" onclick="App.exportCashFlow()">Export to Excel</button></div>
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
    <div class="form-row" style="margin-bottom:12px"><div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" onclick="App.exportARAging()">Export to Excel</button></div></div>
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
    ...state.apExpenses.map((e) => ({ type: "Expense", number: e.expense_number, who: e.vendor || accountName(e.account_code), date: e.expense_date, amount: Number(e.amount || 0) })),
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
    <div class="form-row" style="margin-bottom:12px"><div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" onclick="App.exportAPAging()">Export to Excel</button></div></div>
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

// -------------------------------------------------------- Assets & Liabilities

// Every Asset, Contra-Asset and Liability account from the Chart of Accounts
// with its live balance — the "line items" behind the Balance Sheet's totals.
// Reuses the same account_balances view as Chart of Accounts, just scoped to
// these three types instead of all seven.
function renderAssetsLiabilities() {
  const types = ["Asset", "ContraAsset", "Liability"];
  const all = state.accountBalances.filter((a) => types.includes(a.account_type)).slice().sort((a, b) => a.code.localeCompare(b.code));
  const sumType = (t) => all.filter((a) => a.account_type === t).reduce((s, a) => s + Number(a.balance || 0), 0);
  const totalAssets = sumType("Asset") - sumType("ContraAsset");
  const totalLiabilities = sumType("Liability");
  const groups = types.map((type) => ({ type, accounts: all.filter((a) => a.account_type === type) }));
  const typeLabel = (t) => (t === "ContraAsset" ? "Contra-Asset" : t);
  return `
  <h2 class="page-title">Assets & Liabilities</h2>
  <p class="page-sub">Every Asset and Liability account from the Chart of Accounts, with live balances, as of right now.</p>
  <div class="kpi-grid">
    <div class="kpi"><div class="label">Total assets</div><div class="value">${fmtMoney(totalAssets)}</div></div>
    <div class="kpi"><div class="label">Total liabilities</div><div class="value">${fmtMoney(totalLiabilities)}</div></div>
    <div class="kpi accent"><div class="label">Net (assets − liabilities)</div><div class="value">${fmtMoney(totalAssets - totalLiabilities)}</div></div>
  </div>
  <div class="card">
    <div class="form-row"><div class="field" style="flex:0"><button class="btn btn-ghost btn-sm" onclick="App.exportAssetsLiabilities()">Export to Excel</button></div></div>
  </div>
  ${groups.map((g) => {
    const subtotal = g.accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
    return `
    <div class="card">
      <div class="form-row" style="margin-bottom:10px">
        <h4 style="margin:0">${esc(typeLabel(g.type))} <span class="subtle">(${g.accounts.length})</span></h4>
        <div style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink)">${fmtMoney(subtotal)} SAR</div>
      </div>
      <table>
        <thead><tr><th>Code</th><th>Account</th><th class="right">Balance (SAR)</th><th></th></tr></thead>
        <tbody>
          ${g.accounts.length ? g.accounts.map((a) => `
            <tr>
              <td>${esc(a.code)}</td><td>${esc(a.name)}</td>
              <td class="right">${fmtMoney(a.balance)}</td>
              <td><button class="link-btn" onclick="App.viewAccountLedger('${a.code}')">view ledger</button></td>
            </tr>`).join("") : `<tr><td colspan="4" class="empty-state">No ${esc(typeLabel(g.type))} accounts yet.</td></tr>`}
        </tbody>
      </table>
    </div>`;
  }).join("")}`;
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
