import test from 'node:test';
import assert from 'node:assert/strict';
import { createTotpVerifier, decodeBase32, generateTotp, verifyTotp } from '../src/totp.js';

// RFC 4648 base32 测试向量
test('decodeBase32 decodes RFC 4648 vectors and tolerates case and padding', () => {
  assert.equal(decodeBase32('JBSWY3DP').toString('utf8'), 'Hello');
  assert.equal(decodeBase32('MZXW6===').toString('utf8'), 'foo');
  assert.equal(decodeBase32('mzxw6===').toString('utf8'), 'foo');
  assert.equal(decodeBase32('MZXW6YTBOI======').toString('utf8'), 'foobar');
  assert.throws(() => decodeBase32('MZXW6!1='), /not valid base32/);
  assert.throws(() => decodeBase32('   '), /base32 secret is empty/);
});

// RFC 6238 附录 B 测试向量（SHA1，种子 "12345678901234567890"，取 8 位码的后 6 位）
test('generateTotp matches RFC 6238 SHA1 test vectors', () => {
  const seed = Buffer.from('12345678901234567890', 'utf8');
  assert.equal(generateTotp(seed, { counter: 1 }), '287082'); // T=59 → 94287082
  assert.equal(generateTotp(seed, { counter: 37037036 }), '081804'); // T=1111111109 → 07081804
  assert.equal(generateTotp(seed, { counter: 41152263 }), '005924'); // T=1234567890 → 89005924
  assert.equal(generateTotp(seed, { counter: 66666666 }), '279037'); // T=2000000000 → 69279037
  assert.equal(generateTotp(seed, { counter: 666666666 }), '353130'); // T=20000000000 → 65353130
});

test('verifyTotp accepts current and adjacent windows and rejects older ones', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const nowMs = 1_200_000; // current step = 40
  assert.equal(verifyTotp(secret, generateTotp(secret, { counter: 40 }), { nowMs }), 40);
  assert.equal(verifyTotp(secret, generateTotp(secret, { counter: 39 }), { nowMs }), 39);
  assert.equal(verifyTotp(secret, generateTotp(secret, { counter: 41 }), { nowMs }), 41);
  assert.equal(verifyTotp(secret, generateTotp(secret, { counter: 38 }), { nowMs }), null);
  assert.equal(verifyTotp(secret, generateTotp(secret, { counter: 42 }), { nowMs }), null);
});

test('verifyTotp rejects malformed codes and ignores whitespace', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const nowMs = 1_200_000;
  assert.equal(verifyTotp(secret, 'abcdef', { nowMs }), null);
  assert.equal(verifyTotp(secret, '12345', { nowMs }), null);
  assert.equal(verifyTotp(secret, '', { nowMs }), null);
  assert.equal(
    verifyTotp(secret, ` ${generateTotp(secret, { counter: 40 })} `, { nowMs }),
    40
  );
});

test('createTotpVerifier reuses codes within one window and invalidates older windows', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  let nowMs = 3_000_000; // step 100
  const verifier = createTotpVerifier({ secret, now: () => nowMs });

  const currentCode = generateTotp(secret, { counter: 100 });
  assert.equal(verifier.verify(currentCode), true);
  assert.equal(verifier.verify(currentCode), true); // 同窗口轮询复用

  nowMs = 3_030_000; // step 101
  const nextCode = generateTotp(secret, { counter: 101 });
  assert.equal(verifier.verify(nextCode), true);
  assert.equal(verifier.verify(currentCode), false); // 更新窗口出现后旧码作废
  assert.equal(verifier.verify(generateTotp(secret, { counter: 102 })), true);
});

test('createTotpVerifier is disabled without secret and fails closed on undecodable secret', () => {
  const disabled = createTotpVerifier({ secret: '' });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.verify('123456'), false);

  const broken = createTotpVerifier({ secret: 'not-base32!!' });
  assert.equal(broken.enabled, true);
  assert.equal(broken.verify(generateTotp('JBSWY3DPEHPK3PXP')), false);
});
