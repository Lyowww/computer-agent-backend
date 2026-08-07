import {
  generateSecureToken,
  tokenPrefix,
  hashToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  sha256,
  safeEqual,
} from './crypto.util';

describe('crypto.util', () => {
  it('generates unique tokens', () => {
    const a = generateSecureToken(32);
    const b = generateSecureToken(32);
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it('hashes and verifies tokens', async () => {
    const token = generateSecureToken();
    const hash = await hashToken(token);
    expect(await verifyToken(token, hash)).toBe(true);
    expect(await verifyToken('wrong', hash)).toBe(false);
    expect(tokenPrefix(token)).toBe(token.slice(0, 12));
  });

  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('password123');
    expect(await verifyPassword('password123', hash)).toBe(true);
    expect(await verifyPassword('nope', hash)).toBe(false);
  });

  it('sha256 and safeEqual', () => {
    expect(sha256('abc')).toHaveLength(64);
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('a', 'b')).toBe(false);
  });
});
