const activeStatuses = new Set(['running', 'waiting_approval', 'waiting_input']);
const terminalTypes = new Set(['run.completed', 'run.failed', 'run.cancelled']);

export class OrbState {
  constructor() { this.reset(); }

  reset() {
    this.runs = new Map();
    this.questions = new Map();
    this.approvals = new Map();
    this.lastResult = null;
  }

  apply(event) {
    const { type, sessionId, runId, data = {} } = event;
    if (type === 'run.started' && data.run) {
      this.runs.set(data.run.id, { ...data.run, sessionId, phase: 'running' });
      this.lastResult = null;
    }
    const run = this.runs.get(runId || data.run?.id);
    if (run) {
      if (type === 'context.compacting') run.phase = 'compacting';
      if (type === 'context.compacted') run.phase = 'running';
      if (type === 'run.step') run.steps = data.step ?? data.steps ?? run.steps;
      if (type === 'tool.started') run.tool = data.name;
      if (type === 'tool.completed' || type === 'tool.failed') run.tool = null;
      if (type === 'question.required') run.status = 'waiting_input';
      if (type === 'approval.required') run.status = 'waiting_approval';
      if (type === 'question.resolved' || type === 'approval.resolved') run.status = 'running';
    }
    if (type === 'question.required') this.questions.set(data.id, data);
    if (type === 'question.resolved') this.questions.delete(data.id);
    if (type === 'approval.required') this.approvals.set(data.id, data);
    if (type === 'approval.resolved') this.approvals.delete(data.id);
    if (terminalTypes.has(type)) {
      const id = runId || data.run?.id;
      this.runs.delete(id);
      for (const [key, item] of this.questions) if (item.runId === id) this.questions.delete(key);
      for (const [key, item] of this.approvals) if (item.runId === id) this.approvals.delete(key);
      this.lastResult = { sessionId, runId: id, status: type.slice(4), error: data.run?.error || '', timestamp: event.timestamp };
    }
    return this.snapshot();
  }

  snapshot() {
    const runs = [...this.runs.values()].filter(run => activeStatuses.has(run.status));
    const question = this.questions.values().next().value || null;
    const approval = this.approvals.values().next().value || null;
    const compacting = runs.find(run => run.phase === 'compacting');
    const current = runs.find(run => run.id === (question || approval)?.runId) || compacting || runs[0];
    const mode = question ? 'question' : approval ? 'approval' : compacting ? 'compacting' : runs.length ? 'running' : this.lastResult?.status === 'completed' ? 'completed' : this.lastResult ? 'error' : 'idle';
    return { mode, activeCount: runs.length, pendingCount: this.questions.size + this.approvals.size, sessionId: current?.sessionId || this.lastResult?.sessionId || null, runId: current?.id || this.lastResult?.runId || null, steps: current?.steps || 0, tool: current?.tool || null, question, approval: question ? null : approval, result: this.lastResult };
  }
}

export function orbBounds(bounds, area, { snap = false } = {}) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const minimumX = area.x + Math.min(8, Math.max(0, area.width - width));
  const maximumX = Math.max(minimumX, area.x + area.width - width - 8);
  const x = Math.max(minimumX, Math.min(bounds.x, maximumX));
  return {
    x: Math.round(snap ? x + width / 2 < area.x + area.width / 2 ? minimumX : maximumX : x),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))),
    width: Math.round(width),
    height: Math.round(height),
  };
}
