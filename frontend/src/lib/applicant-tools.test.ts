import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiHttpError, verifyPaymentSlip, type ApplicantRecord } from './api.ts';
import {
  CSV_HEADERS,
  buildApplicantsCsv,
  csvField,
  matchesApplicantQuery,
  sanitizeCsvCell,
} from './applicant-tools.ts';
import {
  PAYMENT_GRACE_HOURS,
  PAYMENT_WINDOW_DAYS,
  PAYMENT_WINDOW_HOURS,
  PAYMENT_WINDOW_MS,
  describeApplicantPaymentDeadline,
  describeStaffPaymentDeadline,
  paymentDueMs,
} from './payment.ts';

function sampleApplication(overrides: Partial<ApplicantRecord> = {}): ApplicantRecord {
  return {
    id: 'CC25-TEST01',
    fullName: 'สมชาย ใจดี',
    nickname: 'ชาย',
    phone: '0812345678',
    email: 'test@example.com',
    school: 'โรงเรียนแม่โจ้',
    grade: 'ม.5',
    province: 'เชียงใหม่',
    shirtSize: 'L',
    motivation: 'อยากเข้าค่าย\nเพราะสนใจ IoT',
    allergies: '',
    medicalConditions: '',
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
      allergies: '=cmd|calc',
      medicalConditions: 'หอบหืด\nพกยาพ่น',
    }),
  ]);

  assert.ok(csv.startsWith('\uFEFF'), 'expected UTF-8 BOM for Excel');
  assert.ok(csv.includes('"\'\n=HYPERLINK(""https://evil.example"",""Click"")"'));
  assert.ok(csv.includes(",' =1+1,"));
  assert.ok(csv.includes(",'\t+1+1,"));
  assert.ok(csv.includes(",'@SUM(A1),"));
  assert.ok(csv.includes(',"อยากเข้าค่าย\nเพราะสนใจ IoT",\'=cmd|calc,"หอบหืด\nพกยาพ่น"\r\n'));
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

test('parent contact fields work in matchesApplicantQuery and buildApplicantsCsv', () => {
  const app = sampleApplication({
    parentName: 'สมศรี ใจดี',
    parentRelation: 'มารดา',
    parentPhone: '0898765432',
  });

  assert.equal(matchesApplicantQuery(app, 'สมศรี'), true);
  assert.equal(matchesApplicantQuery(app, '\u200Bมารดา'), true);
  assert.equal(matchesApplicantQuery(app, '089-876-5432'), true);
  assert.equal(matchesApplicantQuery(app, '๐๘๙๘๗๖'), true);
  assert.equal(matchesApplicantQuery(app, '0999999999'), false);

  const emailHeaderIdx = CSV_HEADERS.indexOf('อีเมล');
  assert.equal(CSV_HEADERS[emailHeaderIdx + 1], 'ชื่อผู้ปกครอง');
  assert.equal(CSV_HEADERS[emailHeaderIdx + 2], 'ความสัมพันธ์ผู้ปกครอง');
  assert.equal(CSV_HEADERS[emailHeaderIdx + 3], 'เบอร์โทรผู้ปกครอง');
  assert.equal(CSV_HEADERS[emailHeaderIdx + 4], 'โรงเรียน');

  const csv = buildApplicantsCsv([
    app,
    sampleApplication({
      id: 'CC25-TEST02',
      parentName: '=SUM(1,1)',
      parentRelation: 'บิดา',
      parentPhone: '',
    }),
  ]);

  assert.ok(csv.includes('อีเมล,ชื่อผู้ปกครอง,ความสัมพันธ์ผู้ปกครอง,เบอร์โทรผู้ปกครอง,โรงเรียน'));
  assert.ok(csv.includes(',test@example.com,สมศรี ใจดี,มารดา,"=""0898765432""",โรงเรียนแม่โจ้,'));
  assert.ok(csv.includes(',test@example.com,"\'=SUM(1,1)",บิดา,,โรงเรียนแม่โจ้,'));
});

test('Phase 5.1: no national ID column in the CSV; staff search by phone, code or name still works', () => {
  assert.deepEqual(CSV_HEADERS.slice(0, 5), ['รหัสใบสมัคร', 'ชื่อ-นามสกุล', 'ชื่อเล่น', 'เบอร์โทรศัพท์', 'อีเมล']);
  assert.ok(!CSV_HEADERS.some((h) => /ประชาชน|บัตร/.test(h)), 'no national ID header');

  const app = sampleApplication();
  const csv = buildApplicantsCsv([app]);
  const [header, row] = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(header.split(',').length, CSV_HEADERS.length);
  assert.ok(row.startsWith('CC25-TEST01,สมชาย ใจดี,ชาย,"=""0812345678""",test@example.com,'));

  assert.equal(matchesApplicantQuery(app, 'cc25-test01'), true);
  assert.equal(matchesApplicantQuery(app, 'CC25-TEST01'), true);
  assert.equal(matchesApplicantQuery(app, '081-234-5678'), true);
  assert.equal(matchesApplicantQuery(app, '๐๘๑๒๓๔'), true);
  assert.equal(matchesApplicantQuery(app, 'สมชาย'), true);
  assert.equal(matchesApplicantQuery(app, 'ชาย'), true);
  assert.equal(matchesApplicantQuery(app, '1100500000018'), false);
});

const HOUR = 60 * 60 * 1000;

test('payment window is 5 days (120h) with a 24h grace, matching the server sweep', () => {
  assert.equal(PAYMENT_WINDOW_HOURS, 120);
  assert.equal(PAYMENT_WINDOW_DAYS, 5);
  assert.equal(PAYMENT_GRACE_HOURS, 24);
  assert.equal(PAYMENT_WINDOW_MS, 120 * HOUR);
});

test('paymentDueMs = max(created + 120h, updated + 24h, rejected slip + 24h)', () => {
  const created = Date.parse('2026-11-19T02:00:00Z'); // 09:00 Asia/Bangkok, registration opening
  const iso = (ms: number) => new Date(ms).toISOString();
  assert.equal(paymentDueMs(iso(created)), created + 120 * HOUR);
  assert.equal(paymentDueMs(iso(created), iso(created)), created + 120 * HOUR);
  // A staff change at +90h ends its 24h grace before the 5-day window does: no shift.
  assert.equal(paymentDueMs(iso(created), iso(created + 90 * HOUR)), created + 120 * HOUR);
  // A staff change at +100h pushes the deadline to +124h.
  assert.equal(paymentDueMs(iso(created), iso(created + 100 * HOUR)), created + 124 * HOUR);
  // A slip rejected at +110h pushes it to +134h; a later updatedAt still wins when it is later.
  assert.equal(paymentDueMs(iso(created), iso(created), iso(created + 110 * HOUR)), created + 134 * HOUR);
  assert.equal(paymentDueMs(iso(created), iso(created + 115 * HOUR), iso(created + 110 * HOUR)), created + 139 * HOUR);
  assert.ok(Number.isNaN(paymentDueMs('not a date')));
});

test('describeApplicantPaymentDeadline pins the 120h boundary and the 24h grace', () => {
  const now = Date.parse('2026-12-01T05:00:00Z');
  const ago = (h: number) => new Date(now - h * HOUR).toISOString();

  assert.equal(describeApplicantPaymentDeadline(ago(120), ago(120), now).isOverdue, true);
  assert.equal(describeApplicantPaymentDeadline(ago(119 + 59 / 60), ago(119 + 59 / 60), now).isOverdue, false);
  assert.equal(describeApplicantPaymentDeadline(ago(130), ago(23), now).isOverdue, false);
  assert.equal(describeApplicantPaymentDeadline(ago(130), ago(25), now).isOverdue, true);

  // Same rule for staff, who also see the 24h grace after a rejected slip.
  assert.equal(describeStaffPaymentDeadline(ago(130), ago(130), ago(23), now).isOverdue, false);
  assert.equal(describeStaffPaymentDeadline(ago(130), ago(130), ago(25), now).isOverdue, true);
  assert.equal(describeStaffPaymentDeadline(ago(130), ago(130), null, now).isOverdue, true);

  const overdue = describeApplicantPaymentDeadline(ago(121), ago(121), now);
  assert.equal(overdue.remainingText, 'ครบกำหนดชำระเงินแล้ว');
  assert.doesNotMatch(overdue.remainingText, /72|3 วัน|5 วัน/);

  // Registered 19 Nov 2026 09:00 (Bangkok) -> due 24 Nov 2026 09:00 (Bangkok).
  const fresh = describeApplicantPaymentDeadline('2026-11-19T02:00:00Z', '2026-11-19T02:00:00Z', Date.parse('2026-11-19T02:00:00Z'));
  assert.match(fresh.deadlineText, /24/);
  assert.match(fresh.deadlineText, /09:00/);
  assert.equal(fresh.remainingText, 'เหลือเวลาโอนอีก 5 วัน');
});
