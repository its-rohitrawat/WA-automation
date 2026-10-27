import { describe, expect, it } from 'vitest';
import { createRouter } from '../../src/web/router.ts';
import type { Handler } from '../../src/web/router.ts';

const h = (): Handler => () => undefined;

describe('createRouter', () => {
  it('matches literal paths by method', () => {
    const r = createRouter();
    const a = h();
    const b = h();
    r.get('/dashboard/api/status', a);
    r.post('/dashboard/auth/logout', b);
    expect(r.match('GET', '/dashboard/api/status')).toEqual({ handler: a, params: {}, pattern: '/dashboard/api/status' });
    expect(r.match('POST', '/dashboard/auth/logout')?.handler).toBe(b);
    expect(r.match('POST', '/dashboard/api/status')).toBeUndefined();
    expect(r.match('GET', '/dashboard/auth/logout')).toBeUndefined();
    expect(r.match('DELETE', '/dashboard/api/status')).toBeUndefined();
  });

  it('answers HEAD with the GET route', () => {
    const r = createRouter();
    const a = h();
    r.get('/dashboard/api/status', a);
    expect(r.match('HEAD', '/dashboard/api/status')?.handler).toBe(a);
  });

  it('fills :param segments, decoded', () => {
    const r = createRouter();
    const a = h();
    r.get('/dashboard/api/tasks/:id/events/:kind', a);
    const m = r.match('GET', '/dashboard/api/tasks/42/events/edit%20one');
    expect(m?.handler).toBe(a);
    expect(m?.params).toEqual({ id: '42', kind: 'edit one' });
    expect(m?.pattern).toBe('/dashboard/api/tasks/:id/events/:kind');
  });

  it('needs the same number of segments, and a param never matches an empty segment', () => {
    const r = createRouter();
    r.get('/dashboard/api/tasks/:id', h());
    expect(r.match('GET', '/dashboard/api/tasks')).toBeUndefined();
    expect(r.match('GET', '/dashboard/api/tasks/')).toBeUndefined();
    expect(r.match('GET', '/dashboard/api/tasks/1/2')).toBeUndefined();
    expect(r.match('GET', 'dashboard/api/tasks/1')).toBeUndefined();
  });

  it('a param that cannot be decoded is no match, not a throw', () => {
    const r = createRouter();
    r.get('/dashboard/api/tasks/:id', h());
    expect(r.match('GET', '/dashboard/api/tasks/%E0%A4%A')).toBeUndefined();
  });

  it('literal segments are compared exactly (no regex, no case folding)', () => {
    const r = createRouter();
    r.get('/dashboard/api/status', h());
    expect(r.match('GET', '/dashboard/api/STATUS')).toBeUndefined();
    expect(r.match('GET', '/dashboard/api/statusx')).toBeUndefined();
    expect(r.match('GET', '/dashboard/api/stat.s')).toBeUndefined();
  });

  it('the first registered route wins', () => {
    const r = createRouter();
    const a = h();
    const b = h();
    r.get('/dashboard/api/tasks/new', a);
    r.get('/dashboard/api/tasks/:id', b);
    expect(r.match('GET', '/dashboard/api/tasks/new')?.handler).toBe(a);
    expect(r.match('GET', '/dashboard/api/tasks/7')?.handler).toBe(b);
  });

  it('params cannot reach the object prototype', () => {
    const r = createRouter();
    r.get('/x/:id', h());
    const m = r.match('GET', '/x/__proto__');
    expect(m?.params.id).toBe('__proto__');
    expect(Object.getPrototypeOf(m?.params)).toBeNull();
  });

  it('refuses bad patterns and duplicates', () => {
    const r = createRouter();
    expect(() => r.get('dashboard', h())).toThrow();
    expect(() => r.get('/a/(.*)', h())).toThrow();
    expect(() => r.get('/a/:', h())).toThrow();
    expect(() => r.get('/a//b', h())).toThrow();
    expect(() => r.get('/a/:id/:id', h())).toThrow();
    r.get('/a/:id', h());
    expect(() => r.get('/a/:id', h())).toThrow();
    expect(() => r.post('/a/:id', h())).not.toThrow();
  });
});
