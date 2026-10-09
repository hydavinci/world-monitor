import { describe, expect, it } from 'vitest';
import schema from '../schema';
import http from '../http';

describe('independent public contact storage', () => {
  it('contains only the contact table', () => {
    expect(Object.keys(schema.tables)).toEqual(['contactMessages']);
  });

  it('exposes only the service-authenticated contact HTTP route', () => {
    expect(http.getRoutes().map(([path, method]) => [path, method])).toEqual([
      ['/leads/submit-contact', 'POST'],
    ]);
  });
});
