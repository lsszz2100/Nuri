const test = require('node:test');
const assert = require('node:assert');
const { continueTarget, toSessionCookie } = require('../src/google-login');
const { GOOGLE_SIGNIN } = require('../src/tabs');

test('google sign-in pages are detected', () => {
  for (const u of ['https://accounts.google.com/v3/signin/identifier?continue=x', 'https://accounts.google.com/ServiceLogin?service=mail', 'https://accounts.google.com/v3/signin/rejected', 'https://accounts.google.com/AccountChooser'])
    assert.ok(GOOGLE_SIGNIN.test(u), u);
  for (const u of ['https://myaccount.google.com/', 'https://mail.google.com/mail/u/0/', 'https://www.google.com/search?q=signin'])
    assert.ok(!GOOGLE_SIGNIN.test(u), u);
});

test('continueTarget picks the page to return to', () => {
  assert.strictEqual(continueTarget('https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&service=mail'), 'https://mail.google.com/mail/');
  assert.strictEqual(continueTarget('https://accounts.google.com/v3/signin/rejected'), null);
  assert.strictEqual(continueTarget('https://accounts.google.com/ServiceLogin?continue=javascript:alert(1)'), null);
});

test('toSessionCookie converts CDP cookies', () => {
  const d = toSessionCookie({ name: 'SID', value: 'v', domain: '.google.com', path: '/', secure: true, httpOnly: false, sameSite: 'None', session: false, expires: 2000000000 });
  assert.deepStrictEqual(d, { url: 'https://google.com/', name: 'SID', value: 'v', path: '/', secure: true, httpOnly: false, domain: '.google.com', sameSite: 'no_restriction', expirationDate: 2000000000 });
  const host = toSessionCookie({ name: '__Host-GAPS', value: 'v', domain: 'accounts.google.com', path: '/', secure: true, httpOnly: true, session: true, expires: -1 });
  assert.strictEqual(host.domain, undefined);
  assert.strictEqual(host.expirationDate, undefined);
  assert.strictEqual(host.url, 'https://accounts.google.com/');
  assert.strictEqual(toSessionCookie({ name: 'x', value: 'v', domain: '.google.com', partitionKey: { topLevelSite: 'https://a.com' } }), null);
});
