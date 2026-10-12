import test from 'node:test';
import assert from 'node:assert/strict';
import { OrbState, orbBounds } from '../desktop/orb-state.js';

const started = (sessionId, runId) => ({ type: 'run.started', sessionId, runId, data: { run: { id: runId, sessionId, status: 'running' } } });

test('orb presents pending user input ahead of approvals and running tasks without losing other runs', () => {
  const state = new OrbState();
  state.apply(started('one', 'r1'));
  state.apply(started('two', 'r2'));
  state.apply({ type: 'approval.required', sessionId: 'one', runId: 'r1', data: { id: 'a', sessionId: 'one', runId: 'r1' } });
  state.apply({ type: 'question.required', sessionId: 'two', runId: 'r2', data: { id: 'q', sessionId: 'two', runId: 'r2', question: 'Choose?' } });
  assert.equal(state.snapshot().mode, 'question');
  assert.equal(state.snapshot().activeCount, 2);
  assert.equal(state.snapshot().pendingCount, 2);
  assert.equal(state.snapshot().sessionId, 'two');
  state.apply({ type: 'question.resolved', sessionId: 'two', runId: 'r2', data: { id: 'q' } });
  assert.equal(state.snapshot().mode, 'approval');
  assert.equal(state.snapshot().sessionId, 'one');
  state.apply({ type: 'run.cancelled', sessionId: 'one', runId: 'r1', data: { run: { id: 'r1', status: 'cancelled' } } });
  assert.equal(state.snapshot().mode, 'running');
  assert.equal(state.snapshot().pendingCount, 0);
  assert.equal(state.snapshot().activeCount, 1);
  assert.equal(state.snapshot().result.status, 'cancelled');
});

test('orb follows actual compaction and terminal states, then resets for a new workspace', () => {
  const state = new OrbState();
  state.apply(started('one', 'r1'));
  state.apply({ type: 'context.compacting', runId: 'r1' });
  assert.equal(state.snapshot().mode, 'compacting');
  state.apply({ type: 'tool.completed', runId: 'r1' });
  assert.equal(state.snapshot().mode, 'compacting');
  state.apply({ type: 'context.compacted', runId: 'r1' });
  assert.equal(state.snapshot().mode, 'running');
  state.apply({ type: 'run.completed', runId: 'r1', sessionId: 'one', data: { run: { status: 'completed' } } });
  assert.equal(state.snapshot().mode, 'completed');
  state.apply(started('one', 'r2'));
  assert.equal(state.snapshot().result, null);
  state.apply({ type: 'run.failed', runId: 'r2', sessionId: 'one', data: { run: { error: 'Connection interrupted' } } });
  assert.equal(state.snapshot().mode, 'error');
  assert.equal(state.snapshot().result.error, 'Connection interrupted');
  state.reset();
  assert.equal(state.snapshot().mode, 'idle');
  assert.equal(state.snapshot().result, null);
});

test('orb stays in the current work area, snaps to an edge and fits a small display', () => {
  const area = { x: -1200, y: 0, width: 1200, height: 700 };
  assert.deepEqual(orbBounds({ x: -20, y: 800, width: 132, height: 132 }, area, { snap: true }), { x: -140, y: 568, width: 132, height: 132 });
  assert.equal(orbBounds({ x: -1000, y: 12, width: 132, height: 132 }, area, { snap: true }).x, -1192);
  assert.deepEqual(orbBounds({ x: 50, y: -50, width: 396, height: 680 }, { x: 0, y: 0, width: 320, height: 500 }), { x: 0, y: 0, width: 320, height: 500 });
});
