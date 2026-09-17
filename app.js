// US ServTech — Operations & Accounts
// Vanilla JS single-page app. No build step, no framework.
// Backend: Supabase (Postgres + Auth + Realtime). All numbering, invoice
// generation, revenue posting and ledger balances are computed server-side
// by database triggers/functions — this file only reads/writes rows and
// calls a handful of RPCs; it never posts journal entries itself.

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

const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "customers", label: "Customers" },
  { id: "inquiries", label: "Inquiries" },
  { id: "quotations", label: "Quotations" },
  { id: "workorders", label: "Work Orders" },
  { id: "invoices", label: "Invoices" },
  { id: "expenses", label: "Expenses", mgmtOnly: true },
  { id: "employees", label: "Employees", mgmtOnly: true },
  { id: "payroll", label: "Payroll", mgmtOnly: true },
  { id: "fixedassets", label: "Fixed Assets", mgmtOnly: true },
  { id: "ledger", label: "Ledger", mgmtOnly: true },
];

const state = {
  session: null,
  profile: null,
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
  tasksByParent: {},   // parent_id -> [task,...]
  expanded: {},        // "table:id" -> true
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
    if (view === "ledger") await Promise.all([loadLedger(), loadBankAccounts()]);
    // keep expanded rows' task lists (and payroll run lines) fresh
    const openParents = Object.keys(state.expanded).filter((k) => state.expanded[k]);
    await Promise.all(openParents.map((k) => {
      const [table, id] = k.split(":");
      return table === "payroll" ? loadPayrollLines(id) : loadTasksFor(id);
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
    "journal_entries", "expenses", "employees", "payroll_runs", "payroll_lines", "fixed_assets"];
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
  loadView(view);
};
App.toggle = function (table, id) {
  const key = table + ":" + id;
  state.expanded[key] = !state.expanded[key];
  if (state.expanded[key]) {
    if (table === "payroll") {
      if (!state.payrollLinesByRun[id]) loadPayrollLines(id).then(render);
    } else if (!state.tasksByParent[id]) {
      loadTasksFor(id).then(render);
    }
  }
  render();
};

// ------------------------------------------------------------ customers
//
// Customers has no standalone "add" form — it's a read-only directory. New
// customers enter the system the moment they're named on a new Inquiry (or,
// if a work order is opened for someone without going through an inquiry
// first, on that Work Order) — see resolveCustomer() below, which creates
// the customers row right then rather than leaving an orphaned free-text
// name on the inquiry/order.

// Shared by every "who is this for" form (Inquiries, Work Orders): resolves
// the chosen existing customer, or creates a brand-new customers row from
// the typed name so it shows up in the Customers directory from then on. A
// brand-new customer needs at least a Name, Invoice Name and Contact — VAT
// and the address fields are added later from the Customers directory (see
// App.updateCustomer / renderCustomerEditor below), since they're rarely
// known the moment a new lead comes in. Returns the resolved {customer_id,
// customer}, the string "invalid" if a new-customer attempt was missing a
// required field (a toast has already been shown), or null if nothing was
// picked or typed at all.
async function resolveCustomer(v) {
  if (v.customer_id) {
    const c = state.customers.find((x) => x.id === v.customer_id);
    if (c) return { customer_id: c.id, customer: c.display_name };
  }
  const name = (v.customer_name || "").trim();
  const invoiceName = (v.customer_invoice_name || "").trim();
  const contact = (v.customer_contact || "").trim();
  if (!name && !invoiceName && !contact) return null;
  if (!name || !invoiceName || !contact) {
    showToast("A new customer needs a Name, Invoice Name and Contact", true);
    return "invalid";
  }
  const created = await guard(sb.from("customers").insert({
    display_name: name, invoice_name: invoiceName, contact,
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

App.addInquiry = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  const who = await resolveCustomer(v);
  if (who === "invalid") return false;
  if (!who) { showToast("Pick a customer or enter a new one's details", true); return false; }
  await guard(sb.from("inquiries").insert({
    customer_id: who.customer_id, customer: who.customer,
    inquiry_date: v.inquiry_date || new Date().toISOString().slice(0, 10),
    contact_method: v.contact_method || null,
    accounting_system: v.accounting_system || null,
    discount: Number(v.discount || 0),
  }), "Inquiry added");
  ev.target.reset();
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

App.addWorkOrder = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  const who = await resolveCustomer(v);
  if (who === "invalid") return false;
  if (!who) { showToast("Pick a customer or enter a new one's details", true); return false; }
  await guard(sb.from("work_orders").insert({
    customer_id: who.customer_id, customer: who.customer,
    wo_date: v.wo_date || new Date().toISOString().slice(0, 10),
    accounting_system: v.accounting_system || "Odoo",
    discount: Number(v.discount || 0),
  }), "Work order created");
  ev.target.reset();
  await loadWorkOrders();
  render();
  return false;
};
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

// ====================================================================
// RENDER
// ====================================================================

function render() {
  const app = document.getElementById("app");
  if (state.loading && !state.profile && !state.session) { app.innerHTML = `<div class="empty-state">Loading…</div>`; return; }
  if (!state.session) { app.innerHTML = renderLogin(); return; }
  if (!state.profile) { app.innerHTML = `<div class="empty-state">Loading your profile…</div>`; return; }
  if (!state.profile.active) { app.innerHTML = renderDisabled(); return; }
  app.innerHTML = renderShell();
}

function renderLogin() {
  return `
  <div class="login-wrap">
    <div class="login-card">
      <h1>US ServTech</h1>
      <p class="sub">Operations &amp; Accounts — sign in with your company login.</p>
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
  const navHtml = NAV.filter((n) => !n.mgmtOnly || isMgmt()).map((n) =>
    `<button class="${state.view === n.id ? "active" : ""}" onclick="App.nav('${n.id}')">${n.label}</button>`
  ).join("");
  return `
  <div class="topbar">
    <div class="brand">US ServTech</div>
    <nav>${navHtml}</nav>
    <div class="who"><b>${esc(state.profile.name || state.session.user.email)}</b> · ${esc(state.profile.role)}
      <button class="btn btn-ghost btn-sm" onclick="App.logout()">Sign out</button>
    </div>
  </div>
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
    case "ledger": return isMgmt() ? renderLedger() : mgmtOnlyView();
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
    Payments are recorded on <b>Invoices</b>.${isMgmt() ? " Account and bank balances are on <b>Ledger</b>." : ""}</p>
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
  const mgmt = isMgmt();
  return `
  <div class="wo-detail">
    <table>
      <thead><tr><th>Service</th><th>Description</th><th class="right">Price (SAR)</th><th class="right">Discount (SAR)</th>${showStatus ? "<th>Status</th>" : ""}<th></th></tr></thead>
      <tbody>
        ${tasks.length ? tasks.map((tk) => {
          const locked = showStatus && tk.status === "Delivered" && !mgmt;
          return `
          <tr>
            <td>${esc(tk.service_type) || "—"}</td>
            <td>${esc(tk.description)}</td>
            <td class="right">${fmtMoney(tk.price)}</td>
            <td class="right">${fmtMoney(tk.discount)}</td>
            ${showStatus ? `<td>
              ${locked
                ? `${statusPill(tk.status)}<div class="subtle">locked — Owner/Manager only</div>`
                : `<select onchange="App.updateTaskStatus('${tk.id}','${parentId}',this.value)">
                    ${["In Process", "Completed", "Delivered"].map((s) => `<option value="${s}" ${s === tk.status ? "selected" : ""}>${s}</option>`).join("")}
                  </select>`}
            </td>` : ""}
            <td>${locked ? "" : `<button class="link-btn" onclick="App.deleteTask('${tk.id}','${parentId}')">remove</button>`}</td>
          </tr>`;
        }).join("") : `<tr><td colspan="${showStatus ? 6 : 5}" class="empty-state">No line items yet.</td></tr>`}
      </tbody>
    </table>
    <form class="form-row" style="margin-top:10px" onsubmit="return App.addTask('${parentType}','${parentId}',event)">
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
    </form>
    <div class="totals-line">
      Items subtotal (after item discounts): <b>${fmtMoney(t.subtotal)}</b> &nbsp; Order discount: <b>${fmtMoney(discount)}</b> &nbsp;
      VAT (${t.rate > 0 ? "15%" : "—"}): <b>${fmtMoney(t.tax)}</b> &nbsp; Total: <b>${fmtMoney(t.total)}</b>
      <span class="subtle">— computed here for display; not stored.</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------- Inquiries

function renderInquiries() {
  return `
  <h2 class="page-title">Inquiries</h2>
  <p class="page-sub">Capture a new lead, then open it below to price it with line items — pick Calibration, Inspection or Card for each, one customer can need several — before converting it to a quotation or straight to a work order.</p>
  <div class="card">
    <h3>New inquiry</h3>
    <form onsubmit="return App.addInquiry(event)">
      <div class="form-row">
        <div class="field"><label>Customer</label><select name="customer_id">${customerOptions()}</select></div>
        <div class="field"><label>Date</label><input type="date" name="inquiry_date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>…or new customer — Name</label><input name="customer_name" placeholder="Required if new"></div>
        <div class="field"><label>Invoice name</label><input name="customer_invoice_name" placeholder="Name as it appears on the invoice"></div>
        <div class="field"><label>Contact</label><input name="customer_contact" placeholder="Phone or email"></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>Contact method</label><input name="contact_method" placeholder="Phone / Email / Visit"></div>
        <div class="field"><label>Accounting system</label><select name="accounting_system"><option value="">—</option><option>Odoo</option><option>Zoho</option></select></div>
        <div class="field"><label>Discount (SAR)</label><input name="discount" type="number" step="0.01" min="0" value="0"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add inquiry</button></div>
      </div>
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
  <p class="page-sub">Mark each item Delivered as it's finished — once every item on an order is Delivered, its invoice and revenue posting happen by themselves. Once an item is Delivered, only an Owner or Manager can change or remove it.</p>
  <div class="card">
    <h3>New work order</h3>
    <form onsubmit="return App.addWorkOrder(event)">
      <div class="form-row">
        <div class="field"><label>Customer</label><select name="customer_id">${customerOptions()}</select></div>
        <div class="field"><label>Date</label><input type="date" name="wo_date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Accounting system</label><select name="accounting_system"><option>Odoo</option><option>Zoho</option></select></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>…or new customer — Name</label><input name="customer_name" placeholder="Required if new"></div>
        <div class="field"><label>Invoice name</label><input name="customer_invoice_name" placeholder="Name as it appears on the invoice"></div>
        <div class="field"><label>Contact</label><input name="customer_contact" placeholder="Phone or email"></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>Discount (SAR)</label><input name="discount" type="number" step="0.01" min="0" value="0"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add</button></div>
      </div>
    </form>
  </div>
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

// ---------------------------------------------------------- Ledger

function renderLedger() {
  return `
  <h2 class="page-title">Ledger</h2>
  <p class="page-sub">Balances update live as work orders, expenses, payroll and asset purchases are recorded — nothing here is posted by hand.</p>
  <div class="card">
    <h3>Bank accounts</h3>
    <table>
      <thead><tr><th>Account</th><th>Type</th><th>Number</th><th class="right">Current balance (SAR)</th></tr></thead>
      <tbody>
        ${state.bankBalances.length ? state.bankBalances.map((b) => {
          const acc = state.bankAccounts.find((x) => x.id === b.id) || {};
          return `<tr><td>${esc(b.name)}</td><td>${esc(acc.account_type)}</td><td>${esc(acc.account_number)}</td><td class="right">${fmtMoney(b.current_balance)}</td></tr>`;
        }).join("") : `<tr><td colspan="4" class="empty-state">No bank accounts yet.</td></tr>`}
      </tbody>
    </table>
    <form class="form-row" style="margin-top:14px" onsubmit="return App.addBankAccount(event)">
      <div class="field"><label>Add bank — name</label><input name="name" required></div>
      <div class="field"><label>Type</label><input name="account_type" placeholder="Current / Savings"></div>
      <div class="field"><label>Account number</label><input name="account_number"></div>
      <div class="field"><label>Opening balance (SAR)</label><input name="opening_balance" type="number" step="0.01" value="0"></div>
      <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" type="submit">Add</button></div>
    </form>
  </div>
  <div class="card">
    <h3>Chart of accounts — balances</h3>
    <table>
      <thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="right">Balance (SAR)</th></tr></thead>
      <tbody>
        ${state.accountBalances.length ? state.accountBalances.map((a) => `
          <tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(a.account_type)}</td><td class="right">${fmtMoney(a.balance)}</td></tr>
        `).join("") : `<tr><td colspan="4" class="empty-state">No activity posted yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// -------------------------------------------------------------------- go

init();
