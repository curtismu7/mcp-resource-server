'use strict';
import { loadVertical, VerticalConfigError } from '../../src/vertical/load';
import { cleanupVerticals, writeVertical, config, GOOD_CONFIG } from './fixtures';

afterAll(cleanupVerticals);

describe('loadVertical', () => {
  it('loads a good folder', () => {
    const v = loadVertical(writeVertical());
    expect(v.name).toBe('demo');
    expect(v.tools.map((t) => t.name)).toEqual(['list_things', 'get_thing']);
    expect(v.tools[0].readOnly).toBe(true);
    expect(v.resources[0].listTool).toBe('list_things');
    expect(v.prompts[0].name).toBe('describe_thing');
    expect(v.schemaSql).toContain('CREATE TABLE');
    expect(v.seed.things).toHaveLength(2);
  });

  it('defaults resources and prompts to empty arrays', () => {
    const v = loadVertical(writeVertical({ config: config((c) => { delete (c as any).resources; delete (c as any).prompts; }) }));
    expect(v.resources).toEqual([]);
    expect(v.prompts).toEqual([]);
  });

  const failing: Array<[string, () => string, RegExp]> = [
    ['missing folder', () => '/nonexistent/vertical', /vertical\.json/],
    ['missing schema.sql', () => writeVertical({ omit: ['schema.sql'] }), /schema\.sql/],
    ['missing seed.json', () => writeVertical({ omit: ['seed.json'] }), /seed\.json/],
    ['tool without sql', () => writeVertical({ config: config((c) => { delete (c.tools[0] as any).sql; }) }), /list_things.*sql/],
    ['tool with bad result', () => writeVertical({ config: config((c) => { (c.tools[0] as any).result = 'some'; }) }), /list_things.*result/],
    ['duplicate tool name', () => writeVertical({ config: config((c) => { c.tools[1].name = 'list_things'; }) }), /duplicate tool.*list_things/],
    ['duplicate resource uri', () => writeVertical({ config: config((c) => { c.resources.push({ ...c.resources[0] }); }) }), /duplicate resource.*demo:\/\/things/],
    ['resource listTool names no tool', () => writeVertical({ config: config((c) => { c.resources[0].listTool = 'nope'; }) }), /demo:\/\/things.*nope/],
    ['required arg not in sql', () => writeVertical({ config: config((c) => { c.tools[1].sql = 'SELECT * FROM things'; }) }), /get_thing.*thing_id/],
    ['sql that does not prepare', () => writeVertical({ config: config((c) => { c.tools[0].sql = 'SELECT nope FROM missing_table'; }) }), /list_things.*missing_table/],
    ['sql that is not a SELECT', () => writeVertical({ config: config((c) => { c.tools[0].sql = 'DELETE FROM things'; }) }), /list_things.*SELECT/],
    ['sql with a colon inside a string literal', () => writeVertical({ config: config((c) => { c.tools[0].sql = "SELECT id FROM things WHERE label = 'a:b'"; }) }), /list_things/],
    ['prompt placeholder with no argument', () => writeVertical({ config: config((c) => { c.prompts[0].template = 'Use {{missing}}'; }) }), /describe_thing.*missing/],
    ['null tool entry', () => writeVertical({ config: config((c) => { (c.tools as unknown[]).push(null); }) }), /"tools" must be an object/],
    ['seed table not in schema', () => writeVertical({ seed: { ghosts: [{ id: 1 }] } }), /seed\.json.*ghosts/],
  ];
  for (const [label, dir, pattern] of failing) {
    it(`rejects: ${label}`, () => {
      expect(() => loadVertical(dir())).toThrow(VerticalConfigError);
      expect(() => loadVertical(dir())).toThrow(pattern);
    });
  }

  it('keeps GOOD_CONFIG itself valid (fixture sanity)', () => {
    expect(GOOD_CONFIG.tools).toHaveLength(2);
  });
});
