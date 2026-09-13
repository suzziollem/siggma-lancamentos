/** In-memory test double. Never connects to SIGGMA and never represents real receipts. */
export class MemoryJournal {
  records = new Map();
  async acquire() { if (this.locked) throw new Error('busy'); this.locked = true; }
  async release() { this.locked = false; }
  async get(key) { return structuredClone(this.records.get(key) || null); }
  async put(key, value) { this.records.set(key, structuredClone(value)); }
}
export class Simulator {
  kind = 'SIMULATION_ONLY';
  titles = new Map();
  settlements = new Map();
  events = [];
  sequence = 900000;
  async assertContext(tenant) { this.events.push('context'); if (!tenant) throw new Error('tenant'); }
  async findCandidates(e) {
    return { complete: true, titles: [...this.titles.values()].filter(t =>
      t.partyCode === e.partyCode && t.amountCents === e.amountCents && t.issueDate === e.issueDate && t.dueDate === e.dueDate) };
  }
  async createTitle(e) {
    this.events.push('save-title');
    const title = { ...e, id: String(++this.sequence), paidCents: 0, balanceCents: e.amountCents,
      allocationPercent: e.costCenterCode ? 100 : null, allocationCents: e.costCenterCode ? e.amountCents : null };
    this.titles.set(title.id, title);
    return structuredClone(title);
  }
  async readTitle(id) { return structuredClone(this.titles.get(id)); }
  async settleTitle(id, e) {
    this.events.push('settle-22');
    const t = this.titles.get(id);
    t.paidCents = t.amountCents; t.balanceCents = 0;
    const receipt = { id: String(++this.sequence), tableCode: '22', status: 'liquidado', amountCents: e.amountCents,
      paymentDate: e.paymentDate, balanceCents: 0, bankCode: null, paymentMethodCode: null };
    this.settlements.set(id, receipt);
    return structuredClone(receipt);
  }
  async readSettlement(id) { return structuredClone(this.settlements.get(id)); }
}
