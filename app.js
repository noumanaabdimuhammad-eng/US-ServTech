// US ServTech — Operations & Accounts
// Vanilla JS single-page app. No build step, no framework.
// Backend: Supabase (Postgres + Auth + Realtime). All numbering, invoice
// generation, revenue posting and ledger balances are computed server-side
// by database triggers/functions — this file only reads/writes rows and
// calls a handful of RPCs; it never posts journal entries itself.

const SUPABASE_URL = "https://xeefkivvlhsxepezypsb.supabase.co";
const SUPABASE_KEY = "sb_publishable_KWvrmZGMETiKmEl1iGNw9A_pKLrUqhX";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// VAT is not stored anywhere in the database — it is applied here, the same
// way every screen in this app computes it, purely for display. 15% is
// Saudi Arabia's standard VAT rate. Discount is a flat SAR amount taken off
// the subtotal before VAT.
const VAT_RATE = 0.15;

const MGMT_ROLES = ["Owner", "Manager"];

const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "customers", label: "Customers" },
  { id: "inquiries", label: "Inquiries" },
  { id: "quotations", label: "Quotations" },
  { id: "workorders", label: "Work Orders" },
  { id: "invoices", label: "Invoices" },
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
function taskTotals(tasks, discount) {
  const subtotal = (tasks || []).reduce((s, t) => s + Number(t.price || 0), 0);
  const afterDiscount = Math.max(0, subtotal - Number(discount || 0));
  const tax = afterDiscount * VAT_RATE;
  const total = afterDiscount + tax;
  return { subtotal, afterDiscount, tax, total };
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
    if (view === "ledger") await Promise.all([loadLedger(), loadBankAccounts()]);
    // keep expanded rows' task lists fresh
    const openParents = Object.keys(state.expanded).filter((k) => state.expanded[k]).map((k) => k.split(":")[1]);
    await Promise.all(openParents.map(loadTasksFor));
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
  const tables = ["customers", "inquiries", "quotations", "work_orders", "tasks", "invoices", "bank_accounts", "journal_entries"];
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
  if (state.expanded[key] && !state.tasksByParent[id]) {
    loadTasksFor(id).then(render);
  }
  render();
};

// ------------------------------------------------------------ customers

App.addCustomer = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  if (!v.display_name || !v.display_name.trim()) { showToast("Customer name is required", true); return false; }
  await guard(sb.from("customers").insert({
    display_name: v.display_name.trim(),
    company_name: v.company_name || null,
    phone: v.phone || null,
    email: v.email || null,
    vat_reg_no: v.vat_reg_no || null,
    city: v.city || null,
  }), "Customer added");
  ev.target.reset();
  await loadCustomers();
  render();
  return false;
};

// ------------------------------------------------------------- inquiries

App.addInquiry = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  let customer_id = null, customer = (v.customer_name || "").trim();
  if (v.customer_id) {
    const c = state.customers.find((x) => x.id === v.customer_id);
    if (c) { customer_id = c.id; customer = c.display_name; }
  }
  if (!customer) { showToast("Pick a customer or type a name", true); return false; }
  await guard(sb.from("inquiries").insert({
    customer_id, customer,
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

App.addQuotation = async function (ev) {
  ev.preventDefault();
  const v = fd(ev.target);
  let customer_id = null, customer = (v.customer_name || "").trim();
  if (v.customer_id) {
    const c = state.customers.find((x) => x.id === v.customer_id);
    if (c) { customer_id = c.id; customer = c.display_name; }
  }
  if (!customer) { showToast("Pick a customer or type a name", true); return false; }
  await guard(sb.from("quotations").insert({
    customer_id, customer,
    quote_date: v.quote_date || new Date().toISOString().slice(0, 10),
    accounting_system: v.accounting_system || null,
    discount: Number(v.discount || 0),
  }), "Quotation added");
  ev.target.reset();
  await loadQuotations();
  render();
  return false;
};
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
  let customer_id = null, customer = (v.customer_name || "").trim();
  if (v.customer_id) {
    const c = state.customers.find((x) => x.id === v.customer_id);
    if (c) { customer_id = c.id; customer = c.display_name; }
  }
  if (!customer) { showToast("Pick a customer or type a name", true); return false; }
  await guard(sb.from("work_orders").insert({
    customer_id, customer,
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
  await guard(sb.from("tasks").insert({
    parent_type: parentType, parent_id: parentId,
    description: v.description.trim(),
    price: Number(v.price || 0),
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
    case "ledger": return isMgmt() ? renderLedger() : `<div class="empty-state">Not available for your role.</div>`;
    default: return "";
  }
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
  <p class="page-sub">${state.customers.length} customer${state.customers.length === 1 ? "" : "s"} on file.</p>
  <div class="card">
    <h3>Add a customer</h3>
    <form onsubmit="return App.addCustomer(event)">
      <div class="form-row">
        <div class="field"><label>Name *</label><input name="display_name" required></div>
        <div class="field"><label>Company</label><input name="company_name"></div>
        <div class="field"><label>VAT reg. no.</label><input name="vat_reg_no"></div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field"><label>Phone</label><input name="phone"></div>
        <div class="field"><label>Email</label><input type="email" name="email"></div>
        <div class="field"><label>City</label><input name="city"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add</button></div>
      </div>
    </form>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>No.</th><th>Name</th><th>Company</th><th>Phone</th><th>Email</th><th>City</th></tr></thead>
      <tbody>
        ${state.customers.length ? state.customers.map((c) => `
          <tr>
            <td>${esc(c.customer_number)}</td>
            <td>${esc(c.display_name)}</td>
            <td>${esc(c.company_name)}</td>
            <td>${esc(c.phone || c.mobile)}</td>
            <td>${esc(c.email)}</td>
            <td>${esc(c.city)}</td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty-state">No customers yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------- Tasks editor

function renderTasksEditor(parentType, parentId, discount, discountTable, showStatus) {
  const tasks = state.tasksByParent[parentId] || [];
  const t = taskTotals(tasks, discount);
  return `
  <div class="wo-detail">
    <table>
      <thead><tr><th>Description</th><th class="right">Price (SAR)</th>${showStatus ? "<th>Status</th>" : ""}<th></th></tr></thead>
      <tbody>
        ${tasks.length ? tasks.map((tk) => `
          <tr>
            <td>${esc(tk.description)}</td>
            <td class="right">${fmtMoney(tk.price)}</td>
            ${showStatus ? `<td>
              <select onchange="App.updateTaskStatus('${tk.id}','${parentId}',this.value)">
                ${["In Process", "Completed", "Delivered"].map((s) => `<option value="${s}" ${s === tk.status ? "selected" : ""}>${s}</option>`).join("")}
              </select>
            </td>` : ""}
            <td><button class="link-btn" onclick="App.deleteTask('${tk.id}','${parentId}')">remove</button></td>
          </tr>`).join("") : `<tr><td colspan="${showStatus ? 4 : 3}" class="empty-state">No line items yet.</td></tr>`}
      </tbody>
    </table>
    <form class="form-row" style="margin-top:10px" onsubmit="return App.addTask('${parentType}','${parentId}',event)">
      <div class="field"><label>Add item — description</label><input name="description" required></div>
      <div class="field"><label>Price (SAR)</label><input name="price" type="number" step="0.01" min="0" required></div>
      <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" type="submit">Add item</button></div>
    </form>
    <div class="totals-line">
      Subtotal: <b>${fmtMoney(t.subtotal)}</b> &nbsp; Discount: <b>${fmtMoney(discount)}</b> &nbsp;
      VAT (15%): <b>${fmtMoney(t.tax)}</b> &nbsp; Total: <b>${fmtMoney(t.total)}</b>
      <span class="subtle">— computed here for display; not stored.</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------- Inquiries

function renderInquiries() {
  return `
  <h2 class="page-title">Inquiries</h2>
  <p class="page-sub">Capture a new lead, price it with line items, then convert it to a quotation or straight to a work order.</p>
  <div class="card">
    <h3>New inquiry</h3>
    <form onsubmit="return App.addInquiry(event)">
      <div class="form-row">
        <div class="field"><label>Customer</label><select name="customer_id">${customerOptions()}</select></div>
        <div class="field"><label>...or new customer name</label><input name="customer_name"></div>
        <div class="field"><label>Date</label><input type="date" name="inquiry_date" value="${new Date().toISOString().slice(0, 10)}"></div>
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
          ${open ? `<tr><td colspan="6">${renderTasksEditor("Inquiry", q.id, q.discount, null, false)}</td></tr>` : ""}`;
        }).join("") : `<tr><td colspan="6" class="empty-state">No inquiries yet.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------- Quotations

function renderQuotations() {
  return `
  <h2 class="page-title">Quotations</h2>
  <p class="page-sub">Accepting a quotation creates its work order automatically.</p>
  <div class="card">
    <h3>New quotation</h3>
    <form onsubmit="return App.addQuotation(event)">
      <div class="form-row">
        <div class="field"><label>Customer</label><select name="customer_id">${customerOptions()}</select></div>
        <div class="field"><label>...or new customer name</label><input name="customer_name"></div>
        <div class="field"><label>Date</label><input type="date" name="quote_date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Accounting system</label><select name="accounting_system"><option value="">—</option><option>Odoo</option><option>Zoho</option></select></div>
        <div class="field"><label>Discount (SAR)</label><input name="discount" type="number" step="0.01" min="0" value="0"></div>
        <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Add</button></div>
      </div>
    </form>
  </div>
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
          ${open ? `<tr><td colspan="5">${renderTasksEditor("Quotation", q.id, q.discount, null, false)}</td></tr>` : ""}`;
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
  <p class="page-sub">Mark each item Delivered as it's finished — once every item on an order is Delivered, its invoice and revenue posting happen by themselves.</p>
  <div class="card">
    <h3>New work order</h3>
    <form onsubmit="return App.addWorkOrder(event)">
      <div class="form-row">
        <div class="field"><label>Customer</label><select name="customer_id">${customerOptions()}</select></div>
        <div class="field"><label>...or new customer name</label><input name="customer_name"></div>
        <div class="field"><label>Date</label><input type="date" name="wo_date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Accounting system</label><select name="accounting_system"><option>Odoo</option><option>Zoho</option></select></div>
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
          ${open ? `<tr><td colspan="6">${renderTasksEditor("Work Order", w.id, w.discount, null, true)}</td></tr>` : ""}`;
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
          const total = tasks ? taskTotals(tasks, wo.discount).total : null;
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
