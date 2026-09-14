const STORAGE_KEY = "siggma-diario-v1";
const DEFAULT_SETTLEMENT_TABLE = { code: "22", name: "PAGAMENTOS VIA BANCO" };
const DEFAULT_PATTERNS = [
  { id: "padrao-cremacao", shortcut: "Cremação", direction: "payable", partyCode: "160", partyName: "", expenseType: "Gasto", titleTableCode: "130", titleTableName: "PAGAMENTO EXTERNO", costCenterCode: "1", costCenterName: "CLÍNICA (V)", notes: "" },
  { id: "padrao-gasolina-carro", shortcut: "Gasolina carro", direction: "payable", partyCode: "136", partyName: "", expenseType: "Gasto", titleTableCode: "124", titleTableName: "", costCenterCode: "1", costCenterName: "CLÍNICA (V)", notes: "" },
  { id: "padrao-gasolina-moto", shortcut: "Gasolina moto", direction: "payable", partyCode: "136", partyName: "", expenseType: "Gasto", titleTableCode: "143", titleTableName: "", costCenterCode: "2", costCenterName: "", notes: "" },
  { id: "padrao-natalia", shortcut: "Natalia", direction: "payable", partyCode: "95", partyName: "", expenseType: "Gasto", titleTableCode: "130", titleTableName: "PAGAMENTO EXTERNO", costCenterCode: "1", costCenterName: "CLÍNICA (V)", notes: "" },
  { id: "padrao-sacolas", shortcut: "Sacolas", direction: "payable", partyCode: "200", partyName: "", expenseType: "Gasto", titleTableCode: "17", titleTableName: "", costCenterCode: "2", costCenterName: "", notes: "" },
  { id: "padrao-freelance-clinica", shortcut: "Freelance clínica", direction: "payable", partyCode: "103", partyName: "", expenseType: "Gasto", titleTableCode: "52", titleTableName: "", costCenterCode: "1", costCenterName: "CLÍNICA (V)", notes: "" },
  { id: "padrao-vt-yasmim", shortcut: "VT Yasmim", direction: "payable", partyCode: "108", partyName: "", expenseType: "Gasto", titleTableCode: "53", titleTableName: "VALE TRANSPORTE", costCenterCode: "4", costCenterName: "LOJA (F)", notes: "" },
  { id: "padrao-vt-juliana", shortcut: "VT Juliana", direction: "payable", partyCode: "104", partyName: "", expenseType: "Gasto", titleTableCode: "53", titleTableName: "VALE TRANSPORTE", costCenterCode: "4", costCenterName: "LOJA (F)", notes: "" }
];
const defaultData = {
  version: 2,
  rules: { payableSettlementTable: { ...DEFAULT_SETTLEMENT_TABLE } },
  patterns: structuredClone(DEFAULT_PATTERNS),
  batch: [],
  history: []
};

let data = loadData();
const $ = (id) => document.getElementById(id);

function loadData() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if ((parsed?.version === 1 || parsed?.version === 2) && Array.isArray(parsed.patterns)) {
      // A versão inicial salvava uma lista vazia no celular. Na primeira atualização,
      // ela recebe os padrões-base já conferidos; listas não vazias são preservadas.
      if (parsed.version === 1 && parsed.patterns.length === 0) parsed.patterns = structuredClone(DEFAULT_PATTERNS);
      parsed.version = 2;
      return applyRequiredRules(parsed);
    }
  } catch (_) {}
  return structuredClone(defaultData);
}
function applyRequiredRules(savedData) {
  savedData.rules ||= {};
  const current = savedData.rules.payableSettlementTable || {};
  savedData.rules.payableSettlementTable = {
    code: current.code || DEFAULT_SETTLEMENT_TABLE.code,
    name: current.name || DEFAULT_SETTLEMENT_TABLE.name
  };
  return savedData;
}
function saveData() { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
function money(value) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value); }
function brDate(value) { if (!value) return "—"; const [y,m,d] = value.split("-"); return `${d}/${m}/${y}`; }
function codedLabel(code, name) { return [code, name].filter(Boolean).join(" — ") || "Não informado"; }
function normalize(text) { return String(text).trim().toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function parseAmount(value) {
  const clean = String(value).replace(/\s/g, "").replace(/R\$/gi, "");
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : null;
}
function toast(message) { const el = $("toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2600); }
function download(name, contents, type = "application/json") {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".tab,.panel").forEach(el => el.classList.remove("active"));
  button.classList.add("active"); $(button.dataset.tab).classList.add("active");
}));

function renderPatternSelect() {
  const select = $("pattern"); const current = select.value;
  select.innerHTML = '<option value="">Selecione...</option>' + [...data.patterns]
    .sort((a,b) => a.shortcut.localeCompare(b.shortcut, "pt-BR"))
    .map(p => `<option value="${p.id}">${escapeHtml(p.shortcut)} — ${escapeHtml(p.partyName)}</option>`).join("");
  if (data.patterns.some(p => p.id === current)) select.value = current;
  updatePatternDetail();
}
function updatePatternDetail() {
  const p = data.patterns.find(item => item.id === $("pattern").value);
  $("pattern-detail").textContent = p ? `${p.direction === "payable" ? "A pagar" : "A receber"} • título ${codedLabel(p.titleTableCode, p.titleTableName)} • centro ${codedLabel(p.costCenterCode, p.costCenterName)}` : "Selecione um padrão cadastrado.";
}
$("pattern").addEventListener("change", updatePatternDetail);

function entryFingerprint(entry) { return [entry.patternId, entry.amount.toFixed(2), entry.issueDate, entry.dueDate, entry.status, entry.paymentDate || ""].join("|"); }
function findDuplicates() {
  const counts = new Map();
  data.batch.forEach(e => counts.set(entryFingerprint(e), (counts.get(entryFingerprint(e)) || 0) + 1));
  const historyKeys = new Set(data.history.flatMap(h => h.entries.map(entryFingerprint)));
  return data.batch.filter(e => counts.get(entryFingerprint(e)) > 1 || historyKeys.has(entryFingerprint(e)));
}

$("entry-form").addEventListener("submit", event => {
  event.preventDefault();
  const pattern = data.patterns.find(p => p.id === $("pattern").value);
  const amount = parseAmount($("amount").value); const baseDate = $("base-date").value;
  if (!pattern || !amount || !baseDate) return toast("Confira padrão, valor e data.");
  const status = $("status").value;
  if (pattern.direction === "payable" && status === "paid" && !data.rules.payableSettlementTable.code) return toast("Importe ou configure a regra de liquidação antes de adicionar uma conta paga.");
  const entry = {
    id: crypto.randomUUID(), patternId: pattern.id, shortcut: pattern.shortcut, direction: pattern.direction,
    partyCode: pattern.partyCode, partyName: pattern.partyName, expenseType: pattern.expenseType,
    titleTableCode: pattern.titleTableCode, titleTableName: pattern.titleTableName,
    costCenterCode: pattern.costCenterCode, costCenterName: pattern.costCenterName,
    settlementTableCode: pattern.direction === "payable" && status === "paid" ? data.rules.payableSettlementTable.code : null,
    settlementTableName: pattern.direction === "payable" && status === "paid" ? data.rules.payableSettlementTable.name : null,
    amount, baseDate, issueDate: $("issue-date").value || baseDate, dueDate: $("due-date").value || baseDate,
    paymentDate: status === "paid" ? ($("payment-date").value || baseDate) : null,
    status, historyText: $("history-text").value.trim(), exception: $("exception").value.trim(), createdAt: new Date().toISOString()
  };
  data.batch.push(entry); saveData(); renderBatch(); clearEntryForm(false); toast("Lançamento adicionado ao lote.");
});

function clearEntryForm(clearDate = false) {
  $("pattern").value = ""; $("amount").value = ""; $("status").value = "paid"; $("history-text").value = "";
  $("issue-date").value = ""; $("due-date").value = ""; $("payment-date").value = ""; $("exception").value = "";
  if (clearDate) $("base-date").value = new Date().toISOString().slice(0,10);
  updatePatternDetail();
}
$("clear-form").addEventListener("click", () => clearEntryForm(true));

function renderBatch() {
  $("batch-body").innerHTML = data.batch.map(e => `<tr>
    <td>${brDate(e.baseDate)}</td><td><strong>${escapeHtml(e.shortcut)}</strong></td><td>${escapeHtml(codedLabel(e.partyCode, e.partyName))}</td>
    <td class="money">${money(e.amount)}</td><td><span class="badge ${e.status === "pending" ? "pending" : ""}">${e.status === "pending" ? "Pendente" : "Pago"}</span></td>
    <td>${escapeHtml(codedLabel(e.titleTableCode, e.titleTableName))}</td><td>${escapeHtml(codedLabel(e.costCenterCode, e.costCenterName))}</td>
    <td><button class="remove" data-remove-entry="${e.id}">Excluir</button></td></tr>`).join("");
  $("empty-batch").hidden = data.batch.length > 0;
  $("item-count").textContent = data.batch.length;
  $("pay-total").textContent = money(data.batch.filter(e => e.direction === "payable").reduce((s,e) => s + e.amount, 0));
  const duplicates = findDuplicates();
  $("warnings").hidden = duplicates.length === 0;
  $("warnings").textContent = duplicates.length ? `Atenção: ${duplicates.length} item(ns) podem estar duplicados no lote ou no histórico. Confira antes de enviar.` : "";
  document.querySelectorAll("[data-remove-entry]").forEach(b => b.addEventListener("click", () => { data.batch = data.batch.filter(e => e.id !== b.dataset.removeEntry); saveData(); renderBatch(); }));
}

function batchPayload() {
  return { schema: "siggma-batch-v1", exportedAt: new Date().toISOString(), rules: data.rules, entries: data.batch.map(({id, createdAt, ...entry}) => entry) };
}
function batchMessage() {
  const lines = ["SIGGMA — executar lote após minha confirmação", "", `Quantidade: ${data.batch.length}`, `Total a pagar: ${money(data.batch.reduce((s,e)=>s+e.amount,0))}`, ""];
  data.batch.forEach((e,i) => {
    lines.push(`${i+1}. ${brDate(e.baseDate)} | ${e.shortcut} | ${money(e.amount)} | ${e.status === "paid" ? "pago" : "pendente"}`);
    lines.push(`   fornecedor/cliente ${codedLabel(e.partyCode, e.partyName)} | título ${codedLabel(e.titleTableCode, e.titleTableName)} | centro ${codedLabel(e.costCenterCode, e.costCenterName)}`);
    if (e.settlementTableCode) lines.push(`   Liquidar pela tabela ${e.settlementTableCode} — ${e.settlementTableName}; banco e forma de pagamento em branco se opcionais.`);
    if (e.historyText || e.exception) lines.push(`   Histórico: ${e.historyText || "em branco"}${e.exception ? ` | Exceção: ${e.exception}` : ""}`);
  });
  lines.push("", "Antes de gravar: verificar duplicidades e me apresentar o resumo. Depois: conferir título, baixa e saldo.");
  return lines.join("\n");
}
$("copy-batch").addEventListener("click", async () => {
  if (!data.batch.length) return toast("Adicione lançamentos ao lote.");
  try { await navigator.clipboard.writeText(batchMessage()); toast("Lote copiado. Cole na conversa comigo."); }
  catch (_) { download("SIGGMA_lote.txt", batchMessage(), "text/plain;charset=utf-8"); toast("O navegador bloqueou a cópia; baixei um arquivo de texto."); }
});
$("download-batch").addEventListener("click", () => {
  if (!data.batch.length) return toast("Adicione lançamentos ao lote.");
  download(`SIGGMA_lote_${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(batchPayload(), null, 2));
});
$("clear-batch").addEventListener("click", () => { if (data.batch.length && confirm("Excluir todos os itens deste lote?")) { data.batch = []; saveData(); renderBatch(); } });
$("finish-batch").addEventListener("click", () => {
  if (!data.batch.length) return toast("Não há itens no lote.");
  if (!confirm("Use somente depois de conferir que os itens foram lançados no SIGGMA. Marcar como concluído?")) return;
  data.history.unshift({ id: crypto.randomUUID(), completedAt: new Date().toISOString(), entries: structuredClone(data.batch) });
  data.batch = []; saveData(); renderBatch(); renderHistory(); toast("Lote guardado no histórico.");
});

function renderPatterns() {
  $("pattern-cards").innerHTML = [...data.patterns].sort((a,b)=>a.shortcut.localeCompare(b.shortcut,"pt-BR")).map(p => `<article class="pattern-card">
    <h3>${escapeHtml(p.shortcut)}</h3><p>${p.direction === "payable" ? "A pagar" : "A receber"} • ${escapeHtml(codedLabel(p.partyCode, p.partyName))}</p>
    <div class="pattern-meta"><div><span>Tabela do título</span><strong>${escapeHtml(codedLabel(p.titleTableCode, p.titleTableName))}</strong></div><div><span>Centro de custo</span><strong>${escapeHtml(codedLabel(p.costCenterCode, p.costCenterName))}</strong></div></div>
    <p>${escapeHtml(p.notes || "Sem observações.")}</p>
    <div class="actions"><button class="secondary" data-edit-pattern="${p.id}">Editar</button><button class="danger-link" data-delete-pattern="${p.id}">Excluir</button></div>
  </article>`).join("");
  document.querySelectorAll("[data-edit-pattern]").forEach(b=>b.addEventListener("click",()=>openPatternDialog(b.dataset.editPattern)));
  document.querySelectorAll("[data-delete-pattern]").forEach(b=>b.addEventListener("click",()=>deletePattern(b.dataset.deletePattern)));
  renderPatternSelect();
}
function openPatternDialog(id = null) {
  const p = data.patterns.find(item=>item.id===id);
  $("dialog-title").textContent = p ? "Editar padrão" : "Novo padrão"; $("pattern-id").value = p?.id || "";
  [["shortcut","shortcut"],["direction","direction"],["party-code","partyCode"],["party-name","partyName"],["expense-type","expenseType"],["title-table-code","titleTableCode"],["title-table-name","titleTableName"],["cost-center-code","costCenterCode"],["cost-center-name","costCenterName"],["pattern-notes","notes"]].forEach(([field,key]) => $(field).value = p?.[key] || (field === "direction" ? "payable" : field === "expense-type" ? "Gasto" : ""));
  $("pattern-error").hidden = true; $("pattern-dialog").showModal();
}
$("new-pattern").addEventListener("click",()=>openPatternDialog());
$("pattern-form").addEventListener("submit", event => {
  const submitter = event.submitter;
  if (submitter?.value === "cancel") return;
  event.preventDefault();
  const id = $("pattern-id").value || crypto.randomUUID(); const shortcut = $("shortcut").value.trim();
  if (data.patterns.some(p => p.id !== id && normalize(p.shortcut) === normalize(shortcut))) { $("pattern-error").textContent = "Esse atalho já existe. Use um nome diferente para cada opção."; $("pattern-error").hidden = false; return; }
  const p = { id, shortcut, direction: $("direction").value, partyCode: $("party-code").value.trim(), partyName: $("party-name").value.trim(), expenseType: $("expense-type").value.trim(), titleTableCode: $("title-table-code").value.trim(), titleTableName: $("title-table-name").value.trim(), costCenterCode: $("cost-center-code").value.trim(), costCenterName: $("cost-center-name").value.trim(), notes: $("pattern-notes").value.trim() };
  const index = data.patterns.findIndex(item=>item.id===id); if (index >= 0) data.patterns[index] = p; else data.patterns.push(p);
  saveData(); renderPatterns(); $("pattern-dialog").close(); toast("Padrão salvo.");
});
function deletePattern(id) {
  if (data.batch.some(e=>e.patternId===id)) return toast("Esse padrão está sendo usado no lote atual.");
  if (!confirm("Excluir este padrão?")) return; data.patterns = data.patterns.filter(p=>p.id!==id); saveData(); renderPatterns();
}

function renderHistory() {
  $("history-list").innerHTML = data.history.length ? data.history.map(h => `<article class="history-item"><h3>${new Date(h.completedAt).toLocaleString("pt-BR")}</h3><p>${h.entries.length} item(ns) • ${money(h.entries.reduce((s,e)=>s+e.amount,0))}</p><details><summary>Ver itens</summary><ul>${h.entries.map(e=>`<li>${brDate(e.baseDate)} — ${escapeHtml(e.shortcut)} — ${money(e.amount)}</li>`).join("")}</ul></details></article>`).join("") : '<p class="empty card">Nenhum lote concluído neste navegador.</p>';
}
$("backup-data").addEventListener("click",()=>download(`SIGGMA_backup_${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data,null,2)));
$("restore-data").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file) return;
  try { const restored = JSON.parse(await file.text()); if (restored?.version !== 1 || !Array.isArray(restored.patterns)) throw new Error(); if (!confirm("Substituir padrões, lote e histórico pelos dados desta cópia?")) return; data = applyRequiredRules(restored); saveData(); renderAll(); toast("Cópia restaurada."); }
  catch (_) { toast("Arquivo de cópia inválido."); } finally { event.target.value = ""; }
});
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]); }
function renderRules() {
  const rule = data.rules?.payableSettlementTable;
  $("active-settlement-rule").textContent = rule?.code ? `${rule.code} — ${rule.name || "sem descrição"}` : "não configurada";
}
function renderAll() { renderPatterns(); renderBatch(); renderHistory(); renderRules(); }

$("base-date").value = new Date().toISOString().slice(0,10);
renderAll();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("service-worker.js");
