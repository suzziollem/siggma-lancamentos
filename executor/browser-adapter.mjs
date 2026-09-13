import { ensure, Stop } from './core.mjs';

const brDate = iso => iso.split('-').reverse().join('/');
const isoDate = br => br.trim().split('/').reverse().join('-');
const numericCode = text => text.trim().match(/^\d+/)?.[0] ?? null;
const money = text => {
  const value = text.trim().replace(/\./g, '').replace(',', '.');
  ensure(/^\d+(\.\d{1,2})?$/.test(value), 'UI_MONEY', 'Valor da grade não reconhecido.');
  return Math.round(Number(value) * 100);
};

/** Browser-client Tab supplied by Codex; not a Playwright/CDP connection or credential store.
 * This candidate adapter is deliberately locked until its selectors have been homologated.
 * It does not call internal HTTP endpoints or page application objects.
 */
export class BrowserAdapter {
  constructor(tab, { tenant, visibleTenantMarker, homologated = false, settlementColumns = null } = {}) {
    ensure(tab?.playwright && tenant && visibleTenantMarker, 'CONTEXT_REQUIRED', 'Aba e empresa verificável obrigatórias.');
    this.tab = tab; this.tenant = tenant; this.marker = visibleTenantMarker;
    this.homologated = homologated;
    this.settlementColumns = settlementColumns;
    this.main = tab.playwright.locator('div.ajan-geral[data-id="110"]');
  }
  async assertContext(tenant) {
    const url = new URL(await this.tab.url());
    ensure(url.origin === 'https://sistema.zettabrasil.com.br' && url.pathname.startsWith('/siggma/'),
      'WRONG_DESTINATION', 'A aba não está no SIGGMA esperado.');
    const dom = await this.tab.playwright.domSnapshot();
    ensure(!/Sessão Expirada|Sessao Expirada/.test(dom) && !await this.tab.playwright.locator('input[type="password"]').filter({ visible: true }).count(),
      'AUTH_REQUIRED', 'Login necessário. Usar browserAuth; nunca fornecer senha ao executor.');
    ensure(tenant === this.tenant && dom.includes(this.marker), 'WRONG_TENANT', 'Empresa/filial não confere.');
    ensure(await this.main.count() === 1, 'UI_CHANGED', 'Abra uma única tela 110.');
  }
  async one(locator) {
    ensure(await locator.count() === 1 && await locator.isVisible(), 'UI_CHANGED', 'Campo ausente, duplicado ou oculto.');
    return locator;
  }
  async value(locator) { return (await locator.evaluateAll(es => es.map(e => e.value)))[0]; }
  async fill(locator, value) {
    await (await this.one(locator)).fill(String(value));
    await locator.press('Tab');
    ensure((await this.value(locator)) === String(value), 'UI_VALUE', 'O campo não reteve o valor esperado.');
  }
  async click(locator) { await (await this.one(locator)).click(); }
  async select(locator, value) {
    await (await this.one(locator)).selectOption(value);
    const selected = await this.value(locator);
    if (typeof value === 'string') ensure(selected === value, 'UI_VALUE', 'Filtro não aplicado.');
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
  async grid(scope) {
    const grids = scope.locator('table.ui-jqgrid-btable').filter({ visible: true });
    ensure(await grids.count() === 1, 'UI_CHANGED', 'Grade ambígua.');
    return grids.evaluateAll(tables => tables.map(table => ({
      rows: [...table.querySelectorAll('tr[id]')].map(row => ({
        id: row.id,
        cells: Object.fromEntries([...row.querySelectorAll('td[aria-describedby]')]
          .filter(cell => { const r = cell.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(cell).display !== 'none'; })
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
      amountCents: money(c.valor), paidCents: money(c.valorPago || '0,00'), balanceCents: money(c.valorPendente),
      historyText: c.historico || ''
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
    await this.select(this.main.locator('#status'), []);
    await this.select(this.main.locator('#tabelasContabeis'), []);
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
    const rows = await this.query('e.valor', (e.amountCents / 100).toFixed(2).replace('.', ','), e.issueDate);
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
    ensure(this.settlementColumns && ['status', 'table', 'amount', 'bank', 'method'].every(k =>
      typeof this.settlementColumns[k] === 'string' && this.settlementColumns[k].length > 0),
      'HOMOLOGATION_REQUIRED', 'Conferência de liquidação deve ser mapeada antes de criar qualquer título.');
  }
  async assertReady() { this.writable(); }
  async createTitle(e) {
    this.writable();
    await this.click(this.main.locator('#btnNovo'));
    const form = this.tab.playwright.locator('div.ajan-geral[data-id="225"]');
    await this.waitUntil(() => form.count(), n => n === 1);
    // Field positions observed on 0225; reject changed shape before filling.
    const shapes = await form.locator('input').evaluateAll(es => es.map(e => ({ type: e.type, readOnly: e.readOnly, required: e.required })));
    ensure(shapes[4]?.required && shapes[5]?.type === 'button' && shapes[6]?.readOnly && shapes[10]?.type === 'button',
      'UI_CHANGED', 'Estrutura da tela 0225 mudou.');
    await this.lookup(form.locator('input').nth(5), e.titleTableCode);
    ensure(await this.value(form.locator('input').nth(4)) === e.titleTableCode, 'LOOKUP_MISMATCH', 'Tabela incorreta.');
    if (e.partyCode) {
      await this.lookup(form.locator('input').nth(10), e.partyCode);
      ensure(await this.value(form.locator('input').nth(9)) === e.partyCode, 'LOOKUP_MISMATCH', 'Fornecedor incorreto.');
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
      ensure(await cc.locator('input').count() === 12, 'UI_CHANGED', 'Rateio mudou.');
      await this.lookup(cc.locator('input').nth(2), e.costCenterCode);
      await this.fill(cc.locator('input').nth(9), (e.amountCents / 100).toFixed(2));
      await cc.locator('input').nth(11).fill('100');
      await cc.locator('input').nth(11).press('Tab');
      const allocation = await cc.innerText();
      ensure(allocation.includes(e.costCenterCode + ' - ') && allocation.includes('100.00'), 'ALLOCATION_MISMATCH', 'Rateio não confirmado.');
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
    await this.click(form.getByRole('tab', { name: 'Centros de Custos', exact: true }));
    const cells = await form.locator('#centroCustos table tbody tr').evaluateAll(es => es.map(e =>
      [...e.querySelectorAll('td')].filter(c => c.offsetWidth || c.offsetHeight).map(c => c.innerText.trim())));
    const allocations = cells.filter(c => /^\d+\s*-/.test(c[0] || ''));
    ensure(allocations.length <= 1, 'ALLOCATION_MISMATCH', 'Múltiplos centros precisam de revisão.');
    title.costCenterCode = allocations.length ? numericCode(allocations[0][0]) : null;
    title.allocationCents = allocations.length ? Math.round(Number(allocations[0][2]) * 100) : null;
    title.allocationPercent = allocations.length ? Number(allocations[0][3]) : null;
    await this.click(form.getByRole('button', { name: 'Cancelar', exact: true }));
    await this.waitUntil(() => form.count(), n => n === 0);
    return title;
  }
  async settleTitle(id, e) {
    this.writable();
    ensure(e.settlementTableCode === '22', 'SETTLEMENT_TABLE', 'Tabela inválida.');
    const before = await this.selectTitle(id);
    ensure(before.paidCents === 0 && before.balanceCents === e.amountCents, 'BALANCE_CHANGED', 'Saldo inesperado.');
    await this.click(this.main.locator('#btnBaixar'));
    const form = this.tab.playwright.locator('div.ajan-geral').filter({ has: this.tab.playwright.getByRole('button', { name: 'Efetuar baixa', exact: true }) });
    await this.waitUntil(() => form.count(), n => n === 1);
    // First editable required input is the accounting table code, followed by its lookup.
    const required = form.locator('input[required]').first();
    const button = form.locator('input[type="button"]').first();
    await this.lookup(button, '22');
    ensure(await this.value(required) === '22', 'SETTLEMENT_TABLE', 'A tela não reteve tabela 22.');
    await this.fill(form.locator('input[name="pagamento"]'), brDate(e.paymentDate));
    await this.fill(form.locator('input[name="previsaoPagamento"]'), brDate(e.paymentDate));
    ensure(money((await this.value(form.locator('#valorPago'))).replace('.', ',')) === e.amountCents,
      'BALANCE_CHANGED', 'Valor da baixa divergente.');
    await this.click(form.getByRole('button', { name: 'Efetuar baixa', exact: true }));
    await this.waitUntil(() => form.count(), n => n === 0);
    return this.readSettlement(id);
  }
  async readSettlement(id) {
    const title = await this.selectTitle(id);
    await this.click(this.main.locator('#btnLancamentos'));
    const form = this.tab.playwright.locator('div.ajan-geral').filter({ has: this.tab.playwright.locator('input[name="filterDate"]') });
    await this.waitUntil(() => form.count(), n => n === 1);
    const { rows } = await this.grid(form);
    // Column aliases must be established from a fresh visible grid during homologation.
    const aliases = this.settlementColumns;
    ensure(aliases, 'HOMOLOGATION_REQUIRED', 'Mapeamento da grade de liquidação precisa de homologação.');
    const active = rows.filter(r => r.cells[aliases.status] === 'liquidado');
    ensure(active.length === 1, 'SETTLEMENT_MISMATCH', 'Baixa ativa ausente ou múltipla.');
    const c = active[0].cells;
    const receipt = { id: active[0].id, status: 'liquidado', tableCode: numericCode(c[aliases.table]),
      amountCents: money(c[aliases.amount]), paymentDate: title.paymentDate, balanceCents: title.balanceCents,
      bankCode: c[aliases.bank]?.trim() || null, paymentMethodCode: c[aliases.method]?.trim() || null };
    ensure(aliases.bank in c && aliases.method in c, 'INCOMPLETE_RECEIPT', 'Banco e forma de pagamento não verificáveis.');
    await this.click(form.getByRole('button', { name: 'Fechar', exact: true }));
    return receipt;
  }
}
