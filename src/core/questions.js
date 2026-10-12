import { randomUUID } from 'node:crypto';

const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const now = () => new Date().toISOString();

function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw failure(`${label} 必须是不超过 ${limit} 字符的非空文本，且不能包含控制字符`);
  return value.trim();
}

export class Questions {
  constructor(harness) {
    this.harness = harness;
    this.pending = new Map();
  }

  list() {
    return this.harness.sanitize([...this.pending.values()].map(item => structuredClone(item.question)));
  }

  request(input, context) {
    const { harness } = this;
    const questionText = text(input.question, 'question', 4000);
    if (input.options !== undefined && (!Array.isArray(input.options) || input.options.length > 8)) throw failure('options 必须是最多 8 个选项的数组');
    const options = (input.options || []).map(option => text(option, 'option', 200));
    if (new Set(options).size !== options.length) throw failure('options 不能包含重复选项');
    const session = harness.session(context.sessionId);
    const active = harness.activeRuns.get(session.id);
    if (!active || active.run.id !== context.runId || harness.closed) throw failure('提问所属任务已结束', 409);
    const { signal } = active.controller;
    signal.throwIfAborted();
    const question = harness.sanitize({ id: randomUUID(), sessionId: session.id, runId: active.run.id, callId: context.callId, question: questionText, options, status: 'pending', createdAt: now() });
    active.run.status = 'waiting_input';
    return new Promise((resolve, reject) => {
      const settle = (answer, cancelled = false) => {
        if (!this.pending.has(question.id)) return;
        this.pending.delete(question.id);
        signal.removeEventListener('abort', cancel);
        question.status = cancelled ? 'cancelled' : 'answered';
        question.resolvedAt = now();
        if (!cancelled) {
          question.answer = harness.sanitize(answer);
          active.run.status = 'running';
        }
        harness.publish(session, 'question.resolved', question);
        if (cancelled) reject(signal.reason || new DOMException('提问已取消', 'AbortError'));
        else resolve({ questionId: question.id, answer: question.answer });
      };
      const cancel = () => settle(undefined, true);
      this.pending.set(question.id, { question, settle });
      signal.addEventListener('abort', cancel, { once: true });
      harness.publish(session, 'question.required', question);
    });
  }

  async answer(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'answer')) throw failure('回答必须是仅包含 answer 的对象');
    const answer = text(input.answer, 'answer', 16000);
    const pending = this.pending.get(id);
    if (!pending) throw failure('问题不存在或已处理', 404);
    pending.settle(answer);
    await this.harness.flush();
    return this.harness.sanitize(structuredClone(pending.question));
  }

  recover(session) {
    const unresolved = new Map();
    for (const event of session.events) {
      if (event.type === 'question.required') unresolved.set(event.data.id, event.data);
      if (event.type === 'question.resolved') unresolved.delete(event.data.id);
    }
    for (const question of unresolved.values()) this.harness.publish(session, 'question.resolved', { ...question, status: 'cancelled', resolvedAt: now() });
  }
}
