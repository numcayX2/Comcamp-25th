import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiHttpError, verifyPaymentSlip, type ApplicantRecord } from './api';
import { buildApplicantsCsv, csvField, sanitizeCsvCell } from './applicant-tools';

function sampleApplication(overrides: Partial<ApplicantRecord> = {}): ApplicantRecord {
  return {
    id: 'CC25-TEST01',
    fullName: 'สมชาย ใจดี',
    nickname: 'ชาย',
    nationalId: '1100500000018',
    phone: '0812345678',
    email: 'test@example.com',
    school: 'โรงเรียนแม่โจ้',
    grade: 'ม.5',
    province: 'เชียงใหม่',
    shirtSize: 'L',
    motivation: 'อยากเข้าค่าย\nเพราะสนใจ IoT',
    status: 'PENDING',
    attendanceConfirmed: false,
    hasSlip: false,
    slipStatus: null,
    slipPaymentId: null,
    createdAt: '2026-11-16T01:00:00+07:00',
    ...overrides,
  };
}

test('F-04 sanitizeCsvCell neutralizes dangerous formula prefixes including leading whitespace and controls', () => {
  const dangerous: Array<[string, string]> = [
    ['=1+1', "'=1+1"],
    [' =1+1', "' =1+1"],
    ['\n=1+1', "'\n=1+1"],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', "'\r=1+1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\u200B=1+1', "'=1+1"],
    ['\u200C \uFEFF+1+1', "' +1+1"],
    ['-1+1', "'-1+1"],
    ['+1+1', "'+1+1"],
    ['|cmd', "'|cmd"],
    ['\u0007=cmd', "'\u0007=cmd"],
    ['\tleading-tab', "'\tleading-tab"],
    ['\rleading-cr', "'\rleading-cr"],
  ];

  for (const [input, expected] of dangerous) {
    assert.equal(sanitizeCsvCell(input), expected, `expected prefix for ${JSON.stringify(input)}`);
  }
});

test('F-04 sanitizeCsvCell & csvField keep safe free-text and multiline Thai text intact', () => {
  const multiline = 'อยากเข้าค่าย\nเพราะสนใจ IoT';
  assert.equal(sanitizeCsvCell(multiline), multiline);
  assert.equal(csvField(multiline), `"${multiline}"`);

  assert.equal(csvField('สมชาย - ม.5'), 'สมชาย - ม.5');
  assert.equal(csvField('ข้อความ "มีคำพูด"'), '"ข้อความ ""มีคำพูด"""');
  assert.equal(csvField('\n=1+1'), '"\'\n=1+1"');
  assert.equal(csvField('\r=1+1'), '"\'\r=1+1"');
});

test('F-04 buildApplicantsCsv applies BOM, RFC 4180 quoting, and formula escaping end-to-end', () => {
  const csv = buildApplicantsCsv([
    sampleApplication({
      fullName: '\n=HYPERLINK("https://evil.example","Click")',
      nickname: ' =1+1',
      school: '\t+1+1',
      province: '\u200B@SUM(A1)',
      motivation: 'อยากเข้าค่าย\nเพราะสนใจ IoT',
    }),
  ]);

  assert.ok(csv.startsWith('\uFEFF'), 'expected UTF-8 BOM for Excel');
  assert.ok(csv.includes('"\'\n=HYPERLINK(""https://evil.example"",""Click"")"'));
  assert.ok(csv.includes(",' =1+1,"));
  assert.ok(csv.includes(",'\t+1+1,"));
  assert.ok(csv.includes(",'@SUM(A1),"));
  assert.ok(csv.includes(',"อยากเข้าค่าย\nเพราะสนใจ IoT"\r\n'));
});

test('F-01 verifyPaymentSlip rejects missing or malformed paymentId before issuing a request', async () => {
  const origFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  }) as typeof fetch;

  try {
    for (const bad of ['', '   ', 'not-a-uuid', '12345678-1234-1234-1234-12345678901']) {
      await assert.rejects(
        () => verifyPaymentSlip('token', 'CC25-TEST01', true, 'ok', bad),
        (err: unknown) => err instanceof ApiHttpError && err.status === 400 && err.code === 'VALIDATION_ERROR',
      );
    }
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
