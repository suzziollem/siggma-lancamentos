import { createHash } from 'node:crypto';

export class Stop extends Error {
  constructor(code, message) { super(message); this.name = 'Stop'; this.code = code; }
}
export const ensure = (condition, code, message) => {
  if (!condition) throw new Stop(code, message);
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = (value, optional = false) => {
  if (optional && (value == null || value === '')) return null;
  ensure(/^\d{1,12}$/.test(String(value)), 'INVALID_CODE', 'Código inválido.');
  ensure(BigInt(value) > 0n, 'INVALID_CODE', 'O código deve ser positivo.');
  return String(BigInt(value));
};
export function date(value) {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'INVALID_DATE', 'Use data ISO: AAAA-MM-DD.');
  const parsed = new Date(value + 'T00:00:00Z');
  ensure(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value,
    'INVALID_DATE', 'Data inexistente.');
  return value;
}
export function cents(value) {
  ensure(typeof value === 'number' && Number.isFinite(value), 'INVALID_AMOUNT', 'Valor deve ser numérico.');
  const n = Math.round(value * 100);
  ensure(Number.isSafeInteger(n) && n > 0 && n <= 99999999999 && Math.abs(n - value * 100) < 0.00001,
    'INVALID_AMOUNT', 'Valor positivo com no máximo duas casas decimais.');
  return n;
}
const cleanText = value => {
  ensure(value == null || typeof value === 'string', 'INVALID_TEXT', 'Texto inválido.');
  const s = (value ?? '').trim();
  ensure(s.length <= 180 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s), 'INVALID_TEXT', 'Texto inválido ou longo.');
  return s;
};
export function planBatch(payload, tenant) {
  ensure(typeof tenant === 'string' && tenant.trim().length >= 3, 'TENANT_REQUIRED', 'Identifique a empresa/ambiente.');
  ensure(payload?.schema === 'siggma-batch-v1', 'INVALID_SCHEMA', 'Formato de lote incompatível.');
  ensure(Array.isArray(payload.entries) && payload.entries.length > 0 && payload.entries.length <= 100,
    'INVALID_BATCH', 'O lote deve ter de 1 a 100 itens.');
  const keys = new Set();
  const entries = payload.entries.map(raw => {
    ensure(raw && raw.direction === 'payable', 'PAYABLE_ONLY', 'Executor exclusivo para contas a pagar.');
    ensure(['paid', 'pending'].includes(raw.status), 'INVALID_STATUS', 'Situação inválida.');
    ensure(!cleanText(raw.exception), 'EXCEPTION_REVIEW', 'Exceções em texto livre exigem revisão humana.');
    ensure(!raw.bankCode && !raw.paymentMethodCode, 'UNSUPPORTED_FIELD', 'Banco/forma de pagamento precisam de outro fluxo homologado.');
    const e = {
      partyCode: code(raw.partyCode, true), titleTableCode: code(raw.titleTableCode),
      costCenterCode: code(raw.costCenterCode, true), amountCents: cents(raw.amount),
      issueDate: date(raw.issueDate || raw.baseDate), dueDate: date(raw.dueDate || raw.baseDate),
      paymentDate: raw.status === 'paid' ? date(raw.paymentDate || raw.baseDate) : null,
      status: raw.status, historyText: cleanText(raw.historyText),
      settlementTableCode: raw.status === 'paid' ? '22' : null
    };
    if (raw.status === 'paid') ensure(!raw.settlementTableCode || code(raw.settlementTableCode) === '22',
      'SETTLEMENT_TABLE', 'Liquidação deve usar exclusivamente tabela 22.');
    // Deliberately conservative: changing name, shortcut, status or history does not bypass a duplicate.
    e.key = hash([tenant, e.partyCode, e.amountCents, e.issueDate, e.dueDate]);
    ensure(!keys.has(e.key), 'DUPLICATE_IN_BATCH', 'Itens semelhantes no lote; revisar antes de executar.');
    keys.add(e.key);
    return e;
  });
  const result = { version: 1, tenant, entries, totalCents: entries.reduce((s, e) => s + e.amountCents, 0) };
  result.digest = hash(result);
  return deepFreeze(result);
}
function deepFreeze(value) {
  Object.freeze(value);
  for (const v of Object.values(value)) if (v && typeof v === 'object') deepFreeze(v);
  return value;
}
export function verifyTitle(e, title) {
  ensure(title && /^\d+$/.test(String(title.id)), 'TITLE_RECEIPT', 'Título salvo sem código verificável.');
  for (const field of ['partyCode', 'titleTableCode', 'costCenterCode', 'amountCents', 'issueDate', 'dueDate', 'historyText']) {
    ensure(title[field] === e[field], 'TITLE_MISMATCH', `Conferência divergente no campo ${field}.`);
  }
  if (e.costCenterCode) ensure(title.allocationPercent === 100 && title.allocationCents === e.amountCents,
    'ALLOCATION_MISMATCH', 'Rateio do centro de custo divergente.');
}
function verifySettlement(e, receipt) {
  ensure(receipt && /^\d+$/.test(String(receipt.id)) && receipt.tableCode === '22' && receipt.status === 'liquidado' &&
    receipt.amountCents === e.amountCents && receipt.paymentDate === e.paymentDate &&
    receipt.balanceCents === 0 && receipt.bankCode == null && receipt.paymentMethodCode == null,
    'SETTLEMENT_MISMATCH', 'A baixa não confere com tabela 22, valor, data, saldo ou opcionais.');
}

/** No browser credentials or inferred approvals. A trusted supervisor supplies the adapter. */
export class Executor {
  constructor({ adapter, journal, now = () => Date.now(), onProgress = () => {} }) {
    this.adapter = adapter; this.journal = journal; this.now = now; this.onProgress = onProgress;
  }
  async preview(plan) {
    await this.adapter.assertContext(plan.tenant);
    const checks = [];
    for (const e of plan.entries) {
      const result = await this.adapter.findCandidates(e);
      ensure(result.complete === true && Array.isArray(result.titles), 'INCOMPLETE_SEARCH', 'Busca de duplicidades incompleta.');
      checks.push({ key: e.key, candidateIds: result.titles.map(t => String(t.id)) });
    }
    return { digest: plan.digest, quantity: plan.entries.length, totalCents: plan.totalCents, checks };
  }
  async run(plan, approval, { signal } = {}) {
    ensure(approval?.digest === plan.digest && approval.tenant === plan.tenant && approval.confirmed === true &&
      Number.isFinite(approval.expiresAt) && approval.expiresAt > this.now() && approval.expiresAt <= this.now() + 3600000,
      'APPROVAL_REQUIRED', 'Confirmação explícita do lote e destino é necessária (validade máxima: uma hora).');
    await this.journal.acquire();
    const completed = [];
    let current;
    try {
      await this.adapter.assertContext(plan.tenant);
      if (this.adapter.assertReady) await this.adapter.assertReady();
      // Inspect the entire batch before the first financial write.
      for (const e of plan.entries) {
        const previous = await this.journal.get(e.key);
        if (previous) {
          ensure(previous.entryHash === hash(e), 'CHANGED_ENTRY', 'Item mudou após reserva; revisar.');
          ensure(['TITLE_VERIFIED', 'DONE'].includes(previous.state), 'RECONCILIATION_REQUIRED',
            'Tentativa anterior inconclusiva. Conferir no SIGGMA antes de retomar.');
        } else {
          const r = await this.adapter.findCandidates(e);
          ensure(r.complete === true && Array.isArray(r.titles), 'INCOMPLETE_SEARCH', 'Consulta incompleta.');
          ensure(r.titles.length === 0, 'POSSIBLE_DUPLICATE', 'Possível duplicidade no SIGGMA; execução bloqueada.');
        }
      }
      for (const e of plan.entries) {
        current = e;
        this.gate(approval, signal);
        await this.adapter.assertContext(plan.tenant);
        let record = await this.journal.get(e.key);
        if (record?.state === 'DONE') {
          const existing = await this.adapter.readTitle(record.titleId);
          verifyTitle(e, existing);
          if (e.status === 'paid') verifySettlement(e, await this.adapter.readSettlement(record.titleId));
          else ensure(existing.balanceCents === e.amountCents && existing.paidCents === 0, 'TITLE_MISMATCH', 'Título pendente mudou.');
          completed.push({ key: e.key, titleId: record.titleId, settlementId: record.settlementId, alreadyDone: true });
          continue;
        }
        if (!record) {
          // Recheck just before reserving; no claim of distributed exactly-once without a SIGGMA API.
          const r = await this.adapter.findCandidates(e);
          ensure(r.complete === true && r.titles?.length === 0, 'POSSIBLE_DUPLICATE', 'Duplicidade ou consulta incompleta.');
          record = { state: 'TITLE_ATTEMPT', entryHash: hash(e), planDigest: plan.digest };
          await this.journal.put(e.key, record); // write-ahead, before even filling the form
          const title = await this.adapter.createTitle(e);
          verifyTitle(e, title);
          ensure(title.paidCents === 0 && title.balanceCents === e.amountCents, 'DIRECT_SETTLEMENT',
            'Título foi liquidado diretamente. Parar: não estornar automaticamente.');
          record = { ...record, state: 'TITLE_VERIFIED', titleId: String(title.id) };
          await this.journal.put(e.key, record);
          this.onProgress({ stage: record.state, key: e.key, titleId: record.titleId });
        } else {
          const title = await this.adapter.readTitle(record.titleId);
          verifyTitle(e, title);
          ensure(title.paidCents === 0 && title.balanceCents === e.amountCents, 'RECONCILIATION_REQUIRED', 'Saldo mudou; revisar antes da baixa.');
        }
        if (e.status === 'paid') {
          this.gate(approval, signal);
          await this.adapter.assertContext(plan.tenant);
          await this.journal.put(e.key, { ...record, state: 'SETTLEMENT_ATTEMPT' });
          const receipt = await this.adapter.settleTitle(record.titleId, e);
          verifySettlement(e, receipt);
          verifyTitle(e, await this.adapter.readTitle(record.titleId));
          record.settlementId = String(receipt.id);
        }
        record.state = 'DONE';
        await this.journal.put(e.key, record);
        const result = { key: e.key, titleId: record.titleId, settlementId: record.settlementId || null };
        completed.push(result);
        this.onProgress({ stage: 'DONE', ...result });
      }
      return { status: 'completed', digest: plan.digest, completed };
    } catch (error) {
      // Preserve uncertain ATTEMPT markers; never auto-delete, retry or reverse.
      return { status: 'stopped', digest: plan.digest, completed, stoppedKey: current?.key,
        reason: error instanceof Stop ? error.code : 'UNEXPECTED_ERROR' };
    } finally { await this.journal.release(); }
  }
  gate(approval, signal) {
    ensure(!signal?.aborted, 'CANCELLED', 'Execução interrompida.');
    ensure(approval.expiresAt > this.now(), 'APPROVAL_EXPIRED', 'Confirmação expirou.');
  }
}
