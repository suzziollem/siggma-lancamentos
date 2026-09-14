import { ensure, Stop } from './core.mjs';

const brDate = iso => iso.split('-').reverse().join('/');
const isoDate = br => br.trim().split('/').reverse().join('-');
const numericCode = text => text.trim().match(/^\d+/)?.[0] ?? null;
export const moneyFromUi = text => {
  const raw = text.trim();
  const value = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  ensure(/^\d+(\.\d{1,2})?$/.test(value), 'UI_MONEY', 'Valor da grade não reconhecido.');
  return Math.round(Number(value) * 100);
};
export const moneyForFilter = cents => (cents / 100).toFixed(2);
export const HOMOLOGATED_SETTLEMENT_COLUMNS = Object.freeze({
  status: 'status', table: 'tabelaContabil.tabconCod', amount: 'valor', method: 'pagamentoTipo.tippagDes'
});

/** Browser-client Tab supplied by Codex; not a Playwright/CDP connection or credential store.
 * This candidate adapter is deliberately locked until its selectors have been homologated.
 * It does not call internal HTTP endpoints or page application objects.
 */
export class BrowserAdapter {
  constructor(tab, { tenant, visibleTenantMarker, visibleTenantMarkers, homologated = false, settlementColumns = null } = {}) {
    const markers = visibleTenantMarkers || (visibleTenantMarker ? [visibleTenantMarker] : []);
    ensure(tab?.playwright && tenant && Array.isArray(markers) && markers.length >= 2,
      'CONTEXT_REQUIRED', 'Aba, empresa e filial verificáveis são obrigatórias.');
    this.tab = tab; this.tenant = tenant; this.markers = markers;
    this.homologated = homologated;
    this.settlementColumns = settlementColumns || HOMOLOGATED_SETTLEMENT_COLUMNS;
    this.main = tab.playwright.locator('div.ajan-geral[data-id="110"]');
  }
  async assertContext(tenant) {
    const url = new URL(await this.tab.url());
    ensure(url.origin === 'https://sistema.zettabrasil.com.br' && url.pathname.startsWith('/siggma/'),
      'WRONG_DESTINATION', 'A aba não está no SIGGMA esperado.');
    const dom = await this.tab.playwright.domSnapshot();
    ensure(!/Sessão Expirada|Sessao Expirada/.test(dom) && !await this.tab.playwright.locator('input[type="password"]').filter({ visible: true }).count(),
      'AUTH_REQUIRED', 'Login necessário. Usar browserAuth; nunca fornecer senha ao executor.');
    ensure(tenant === this.tenant && this.markers.every(marker => dom.includes(marker)),
      'WRONG_TENANT', 'Empresa/filial não confere.');
    ensure(await this.main.count() === 1, 'UI_CHANGED', 'Abra uma única tela 110.');
  }
  async one(locator) {
    ensure(await locator.count() === 1 && await locator.isVisible(), 'UI_CHANGED', 'Campo ausente, duplicado ou oculto.');
    return locator;
  }
  async value(locator) { return (await locator.evaluateAll(es => es.map(e => e.value)))[0]; }
  async fill(locator, value) {
    const field = await this.one(locator);
    await field.click();
    await field.press('Control+A');
    await field.press('Backspace');
    if (String(value)) await field.fill(String(value));
    const retained = await this.value(field);
    ensure(retained === String(value) || (!String(value) && /^[\s/]*$/.test(retained)),
      'UI_VALUE', 'O campo não reteve o valor esperado.');
    await field.press('Tab');
  }
  async click(locator) { await (await this.one(locator)).click(); }
  async select(locator, value) {
    await (await this.one(locator)).selectOption(value);
    const selected = await this.value(locator);
    if (typeof value === 'string') ensure(selected === value, 'UI_VALUE', 'Filtro não aplicado.');
  }
  async selectedValues(locator) {
    return locator.evaluateAll(es => es.flatMap(e => [...e.selectedOptions].map(o => o.value)));
  }
  async clearMultiple(locator, removers) {
    let values = await this.selectedValues(locator);
    while (values.length) {
      const remove = removers.first();
      ensure(await removers.count() > 0 && await remove.isVisible(), 'EXTRA_FILTER', 'Filtro múltiplo não pode ser limpo.');
      const previous = values.length;
      await remove.click();
      values = await this.waitUntil(() => this.selectedValues(locator), current => current.length < previous);
    }
  }
  async waitUntil(read, accepted, timeout = 12000) {
    const end = Date.now() + timeout;
    do {
      const result = await read();
      if (accepted(result)) return result;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < end);
    throw new Stop('UI_TIMEOUT', 'Tela não confirmou a etapa; não repetir a ação automaticamente.');
  }
  async closeReadOnlyForm(form) {
    await this.click(form.locator('#btnCancelar'));
    try {
      await this.waitUntil(() => form.count(), n => n === 0, 3000);
    } catch (error) {
      if (!(error instanceof Stop) || error.code !== 'UI_TIMEOUT' || await form.count() === 0) throw error;
      // Repeating Cancel is safe here: this helper is used only after a read-only inspection.
      await this.click(form.locator('#btnCancelar'));
      await this.waitUntil(() => form.count(), n => n === 0, 20000);
    }
  }
  async grid(scope) {
    const grids = scope.locator('table.ui-jqgrid-btable').filter({ visible: true });
    ensure(await grids.count() === 1, 'UI_CHANGED', 'Grade ambígua.');
    return grids.evaluateAll(tables => tables.map(table => ({
      rows: [...table.querySelectorAll('tr[id]')].map(row => ({
        id: row.id,
        cells: Object.fromEntries([...row.querySelectorAll('td[aria-describedby]')]
          .map(cell => [cell.getAttribute('aria-describedby').slice(table.id.length + 1), cell.innerText.trim()]))
      }))
    }))).then(result => result[0]);
  }
  async rows() {
    const { rows } = await this.grid(this.main);
    return rows.map(({ id, cells: c }) => ({
      id, partyCode: numericCode(c.nome || ''), titleTableCode: numericCode(c['tabelaContabil.tabconCod'] || ''),
      issueDate: isoDate(c.emissao || ''), dueDate: isoDate(c.vencimento || ''),
      paymentDate: c.pagamento ? isoDate(c.pagamento) : null,
      amountCents: moneyFromUi(c.valor), paidCents: moneyFromUi(c.valorPago || '0,00'),
      balanceCents: moneyFromUi(c.valorPendente), historyText: c.historico || '',
      isPaid: c.pago === 'true', paidBank: c.pagoBanco === 'Sim', bankName: c.banDes || null,
      paymentMethodCode: c.formaPagamento || null
    }));
  }
  async query(field, value, issueDate = null) {
    await this.assertContext(this.tenant);
    ensure(await this.tab.playwright.locator('div.ajan-geral').filter({ visible: true }).count() === 1,
      'OPEN_FORM', 'Feche formulários antes da consulta.');
    await this.select(this.main.locator('#tipoConta'), 'P');
    await this.select(this.main.locator('#campo'), field);
    await this.select(this.main.locator('#operador'), 'eq');
    await this.fill(this.main.locator('#filter'), value);
    await this.select(this.main.locator('#modelo'), 'título');
    await this.select(this.main.locator('#extras'), '');
    await this.select(this.main.locator('#tipo'), '');
    await this.clearMultiple(this.main.locator('#status'),
      this.main.locator('#status + span .select2-selection__choice__remove'));
    await this.clearMultiple(this.main.locator('#tabelasContabeis'),
      this.main.locator('#tabelasContabeis + span .select2-selection__choice__remove'));
    await this.select(this.main.locator('#tipoData'), 'e.emissao');
    await this.fill(this.main.locator('input[name="periodoIni"]'), issueDate ? brDate(issueDate) : '');
    await this.fill(this.main.locator('input[name="periodoFim"]'), issueDate ? brDate(issueDate) : '');
    // Fail if unrelated supplier/bank/group filters remain; never silently accept a partial search.
    const extra = await this.main.locator('input').evaluateAll(es => es.filter(e =>
      e.type === 'text' && !e.id && !e.name && !e.readOnly && (e.offsetWidth || e.offsetHeight)).map(e => e.value));
    ensure(extra.every(v => !v || v === '1'), 'EXTRA_FILTER', 'Há filtros adicionais na consulta. Revisar.');
    ensure(!await this.value(this.main.locator('#agrupamento')), 'EXTRA_FILTER', 'Agrupamento preenchido.');
    // A stale grid cannot prove absence of duplicates: require observing the loading cycle.
    const loading = this.main.locator('.loading').filter({ visible: true });
    await this.click(this.main.locator('#btnPesquisar'));
    await this.waitUntil(() => loading.count(), n => n > 0, 2500);
    await this.waitUntil(() => loading.count(), n => n === 0);
    const rows = await this.rows();
    const footer = await this.main.innerText();
    const count = footer.match(/Ver\s+[\d\s.]+\s*-\s*[\d\s.]+\s+de\s+([\d .]+)/);
    const total = count ? Number(count[1].replace(/[\s.]/g, '')) : /Nenhum registro para visualizar/.test(footer) ? 0 : NaN;
    ensure(Number.isSafeInteger(total) && total === rows.length, 'INCOMPLETE_SEARCH', 'Consulta paginada ou sem total verificável.');
    return rows;
  }
  async findCandidates(e) {
    const rows = await this.query('e.valor', moneyForFilter(e.amountCents), e.issueDate);
    ensure(rows.every(r => r.amountCents === e.amountCents && r.issueDate === e.issueDate), 'FILTER_MISMATCH', 'Grade não corresponde aos filtros.');
    return { complete: true, titles: rows.filter(r => r.partyCode === e.partyCode && r.dueDate === e.dueDate) };
  }
  async selectTitle(id) {
    ensure(/^\d+$/.test(String(id)), 'INVALID_ID', 'Código de título inválido.');
    const rows = await this.query('e.id', String(id));
    ensure(rows.length === 1 && rows[0].id === String(id), 'TITLE_NOT_FOUND', 'Título exato não encontrado.');
    const checkbox = this.main.locator(`tr[id="${id}"] input[type="checkbox"]`);
    await (await this.one(checkbox)).setChecked(true);
    const checked = await this.main.locator('input[name^="jqg_"]').evaluateAll(es => es.filter(e => e.checked).map(e => e.name));
    ensure(checked.length === 1 && checked[0].endsWith('_' + id), 'MULTIPLE_SELECTION', 'Seleção de título ambígua.');
    return rows[0];
  }
  async lookup(trigger, requestedCode) {
    const before = await this.tab.playwright.locator('div.ajan-geral').count();
    await this.click(trigger);
    await this.waitUntil(() => this.tab.playwright.locator('div.ajan-geral').count(), n => n === before + 1);
    const popup = this.tab.playwright.locator('div.ajan-geral').last();
    await this.fill(popup.locator('input#filter'), requestedCode);
    await this.click(popup.locator('#btnPesquisar'));
    const result = await this.waitUntil(() => this.grid(popup), g => g.rows.length > 0);
    ensure(result.rows.length === 1 && Object.values(result.rows[0].cells).some(v => v === requestedCode),
      'LOOKUP_MISMATCH', 'Seleção por código não retornou um único cadastro.');
    await this.click(popup.locator(`tr[id="${result.rows[0].id}"]`));
    await this.click(popup.getByRole('button', { name: 'Selecionar', exact: true }));
    await this.waitUntil(() => this.tab.playwright.locator('div.ajan-geral').count(), n => n === before);
  }
  writable() {
    ensure(this.homologated, 'HOMOLOGATION_REQUIRED', 'Adaptador de telas ainda não homologado; gravações bloqueadas.');
    ensure(this.settlementColumns && ['status', 'table', 'amount', 'method'].every(k =>
      typeof this.settlementColumns[k] === 'string' && this.settlementColumns[k].length > 0),
      'HOMOLOGATION_REQUIRED', 'Conferência de liquidação deve ser mapeada antes de criar qualquer título.');
  }
  async assertReady() { this.writable(); }
  async createTitle(e) {
    this.writable();
    await this.click(this.main.locator('#btnNovo'));
    const form = this.tab.playwright.locator('div.ajan-geral[data-id="225"]');
    await this.waitUntil(() => form.count(), n => n === 1);
    const table = form.locator('#tabelaContabil');
    const party = form.locator('#fornecedor');
    await this.waitUntil(async () => [await table.locator('input').count(), await party.locator('input').count()],
      counts => counts[0] === 4 && counts[1] === 4, 30000);
    await this.lookup(table.locator('input[type="button"]'), e.titleTableCode);
    ensure(await this.value(table.locator('input[required]')) === e.titleTableCode, 'LOOKUP_MISMATCH', 'Tabela incorreta.');
    if (e.partyCode) {
      await this.lookup(party.locator('input[type="button"]'), e.partyCode);
      ensure(await this.value(party.locator('input.ui-autocomplete-input')) === e.partyCode,
        'LOOKUP_MISMATCH', 'Fornecedor incorreto.');
    }
    await this.fill(form.locator('#valor'), (e.amountCents / 100).toFixed(2));
    await this.fill(form.locator('input[name="emissao"]'), brDate(e.issueDate));
    await this.fill(form.locator('input[name="vencimento"]'), brDate(e.dueDate));
    if (e.status === 'paid') await this.fill(form.locator('input[name="previsaoPagamento"]'), brDate(e.paymentDate));
    await this.fill(form.locator('textarea[name="historico"]'), e.historyText);
    if (e.costCenterCode) {
      await this.click(form.getByRole('tab', { name: 'Centros de Custos', exact: true }));
      const cc = form.locator('#centroCustos');
      await this.click(cc.getByRole('button', { name: 'Novo', exact: true }));
      const editRow = cc.locator('tr.table-row');
      await this.waitUntil(() => editRow.count(), n => n === 1);
      const cells = editRow.locator(':scope > td.table-cell');
      ensure(await cells.count() === 5, 'UI_CHANGED', 'Rateio mudou.');
      await this.lookup(cells.nth(0).locator('input[type="button"]'), e.costCenterCode);
      ensure(await this.value(cells.nth(0).locator('input.ui-autocomplete-input')) === e.costCenterCode,
        'LOOKUP_MISMATCH', 'Centro de custo incorreto.');
      await this.fill(cells.nth(2).locator('input:not([type])'), (e.amountCents / 100).toFixed(2));
      await this.waitUntil(() => editRow.locator('input').count(), n => n === 0);
      const allocation = await editRow.locator(':scope > td.table-cell').evaluateAll(es => es.map(e => e.innerText.trim()));
      ensure(allocation.length === 5 && numericCode(allocation[0]) === e.costCenterCode &&
        moneyFromUi(allocation[2]) === e.amountCents && Number(allocation[3]) === 100,
        'ALLOCATION_MISMATCH', 'Rateio não confirmado.');
    }
    // The direct shortcut is intentionally never used. Never click btnBaixarTitulo.
    await this.click(form.locator('#btnPersistir'));
    await this.waitUntil(() => form.count(), n => n === 0);
    const r = await this.findCandidates(e);
    ensure(r.titles.length === 1, 'TITLE_RECEIPT', 'Gravação sem identificação única.');
    return this.readTitle(r.titles[0].id);
  }
  async readTitle(id) {
    const title = await this.selectTitle(id);
    await this.click(this.main.locator('#btnAlterar'));
    const form = this.tab.playwright.locator('div.ajan-geral[data-id="225"]');
    await this.waitUntil(() => form.count(), n => n === 1);
    const ccTab = form.getByRole('tab', { name: 'Centros de Custos', exact: true });
    await this.waitUntil(() => ccTab.count(), n => n === 1, 30000);
    await this.click(ccTab);
    const rows = form.locator('#centroCustos tr.table-row');
    let signature = null; let stableSince = 0;
    const settled = await this.waitUntil(async () => {
      const total = await form.locator('#centroCustos').innerText();
      const cells = await rows.evaluateAll(es => es.map(e =>
        [...e.querySelectorAll(':scope > td.table-cell')].map(c => c.innerText.trim())));
      const next = JSON.stringify([total.includes('Total:'), cells]);
      if (next !== signature) { signature = next; stableSince = Date.now(); }
      return { cells, stable: total.includes('Total:') && Date.now() - stableSince >= 1500 };
    }, result => result.stable, 30000);
    const cells = settled.cells;
    const allocations = cells.filter(c => /^\d+\s*-/.test(c[0] || ''));
    ensure(allocations.length <= 1, 'ALLOCATION_MISMATCH', 'Múltiplos centros precisam de revisão.');
    title.costCenterCode = allocations.length ? numericCode(allocations[0][0]) : null;
    title.allocationCents = allocations.length ? moneyFromUi(allocations[0][2]) : null;
    title.allocationPercent = allocations.length ? Number(allocations[0][3]) : null;
    await this.closeReadOnlyForm(form);
    return title;
  }
  async settleTitle(id, e) {
    this.writable();
    ensure(e.settlementTableCode === '22', 'SETTLEMENT_TABLE', 'Tabela inválida.');
    const before = await this.selectTitle(id);
    ensure(before.paidCents === 0 && before.balanceCents === e.amountCents, 'BALANCE_CHANGED', 'Saldo inesperado.');
    await this.click(this.main.locator('#btnBaixar'));
    const form = this.tab.playwright.locator('div.ajan-geral').filter({ has: this.tab.playwright.locator('#btnEfetuarBaixa') });
    await this.waitUntil(() => form.count(), n => n === 1);
    const table = form.locator('#tabelaContabil');
    await this.waitUntil(() => table.locator('input').count(), n => n === 4, 30000);
    const required = table.locator('input[required]');
    await this.lookup(table.locator('input[type="button"]'), '22');
    ensure(await this.value(required) === '22', 'SETTLEMENT_TABLE', 'A tela não reteve tabela 22.');
    await this.fill(form.locator('input[name="pagamento"]'), brDate(e.paymentDate));
    await this.fill(form.locator('input[name="previsaoPagamento"]'), brDate(e.paymentDate));
    ensure(moneyFromUi(await this.value(form.locator('#valorPago'))) === e.amountCents,
      'BALANCE_CHANGED', 'Valor da baixa divergente.');
    await this.click(form.locator('#btnEfetuarBaixa'));
    await this.waitUntil(() => form.count(), n => n === 0);
    return this.readSettlement(id);
  }
  async readSettlement(id) {
    const title = await this.selectTitle(id);
    await this.click(this.main.locator('#btnLancamentos'));
    const form = this.tab.playwright.locator('div.ajan-geral').filter({ has: this.tab.playwright.locator('input[name="filterDate"]') });
    await this.waitUntil(() => form.count(), n => n === 1);
    await this.waitUntil(() => form.locator('table.ui-jqgrid-btable').filter({ visible: true }).count(), n => n === 1, 30000);
    const { rows } = await this.waitUntil(() => this.grid(form), grid => grid.rows.length > 0);
    // Column aliases must be established from a fresh visible grid during homologation.
    const aliases = this.settlementColumns;
    ensure(aliases, 'HOMOLOGATION_REQUIRED', 'Mapeamento da grade de liquidação precisa de homologação.');
    const active = rows.filter(r => r.cells[aliases.status] === 'liquidado');
    ensure(active.length === 1, 'SETTLEMENT_MISMATCH', 'Baixa ativa ausente ou múltipla.');
    const c = active[0].cells;
    const receipt = { id: active[0].id, status: 'liquidado', tableCode: numericCode(c[aliases.table]),
      amountCents: moneyFromUi(c[aliases.amount]), paymentDate: title.paymentDate, balanceCents: title.balanceCents,
      bankCode: title.paidBank ? (title.bankName || 'VINCULADO') : null,
      paymentMethodCode: title.paymentMethodCode || c[aliases.method]?.trim() || null };
    ensure(aliases.method in c && typeof title.paidBank === 'boolean',
      'INCOMPLETE_RECEIPT', 'Banco e forma de pagamento não verificáveis.');
    await this.click(form.locator('#btnFechar'));
    return receipt;
  }
}
