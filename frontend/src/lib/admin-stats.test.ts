import assert from 'node:assert/strict';
import test from 'node:test';

import type { Application, ApplicationStatus } from './api.ts';
import { dailyApplications, seatBreakdown, topCounts } from './admin-stats.ts';

function sampleApplication(overrides: Partial<Application> = {}): Application {
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
    motivation: 'อยากเข้าค่าย',
    allergies: '',
    medicalConditions: '',
    status: 'PASSED',
    attendanceConfirmed: false,
    hasSlip: false,
    slipStatus: null,
    slipPaymentId: null,
    createdAt: '2026-11-19T02:00:00Z',
    ...overrides,
  };
}

test('dailyApplications returns empty array for empty input', () => {
  assert.deepEqual(dailyApplications([], Date.parse('2026-11-21T05:00:00Z')), []);
});

test('dailyApplications skips invalid dates and returns empty when none are valid', () => {
  const nowMs = Date.parse('2026-11-21T05:00:00Z');
  assert.deepEqual(
    dailyApplications(
      [
        sampleApplication({ id: 'CC25-BAD001', createdAt: '' }),
        sampleApplication({ id: 'CC25-BAD002', createdAt: 'not-a-date' }),
      ],
      nowMs,
    ),
    [],
  );

  assert.deepEqual(
    dailyApplications(
      [
        sampleApplication({ id: 'CC25-BAD001', createdAt: 'invalid' }),
        sampleApplication({ id: 'CC25-OK0001', createdAt: '2026-11-20T03:00:00Z' }),
        sampleApplication({ id: 'CC25-BAD002', createdAt: '' }),
      ],
      nowMs,
    ),
    [
      { date: '2026-11-15', count: 0, cumulative: 0 },
      { date: '2026-11-16', count: 0, cumulative: 0 },
      { date: '2026-11-17', count: 0, cumulative: 0 },
      { date: '2026-11-18', count: 0, cumulative: 0 },
      { date: '2026-11-19', count: 0, cumulative: 0 },
      { date: '2026-11-20', count: 1, cumulative: 1 },
      { date: '2026-11-21', count: 0, cumulative: 1 },
    ],
  );
});

test('dailyApplications handles Asia/Bangkok midnight boundary accurately', () => {
  // 2026-11-18T16:59:59Z = 2026-11-18 23:59:59+07:00 -> 2026-11-18
  // 2026-11-18T17:00:00Z = 2026-11-19 00:00:00+07:00 -> 2026-11-19
  // 2026-11-18T17:30:00Z = 2026-11-19 00:30:00+07:00 -> 2026-11-19
  const apps = [
    sampleApplication({ id: 'CC25-000001', createdAt: '2026-11-18T16:59:59Z' }),
    sampleApplication({ id: 'CC25-000002', createdAt: '2026-11-18T17:00:00Z' }),
    sampleApplication({ id: 'CC25-000003', createdAt: '2026-11-18T17:30:00Z' }),
  ];
  const nowMs = Date.parse('2026-11-18T17:30:00Z'); // 2026-11-19 in Bangkok

  assert.deepEqual(dailyApplications(apps, nowMs), [
    { date: '2026-11-13', count: 0, cumulative: 0 },
    { date: '2026-11-14', count: 0, cumulative: 0 },
    { date: '2026-11-15', count: 0, cumulative: 0 },
    { date: '2026-11-16', count: 0, cumulative: 0 },
    { date: '2026-11-17', count: 0, cumulative: 0 },
    { date: '2026-11-18', count: 1, cumulative: 1 },
    { date: '2026-11-19', count: 2, cumulative: 3 },
  ]);
});

test('dailyApplications zero-fills gaps, computes cumulative counts, and handles unsorted inputs', () => {
  const apps = [
    sampleApplication({ id: 'CC25-000003', createdAt: '2026-11-21T04:00:00Z' }),
    sampleApplication({ id: 'CC25-000001', createdAt: '2026-11-18T02:00:00Z' }),
    sampleApplication({ id: 'CC25-000002', createdAt: '2026-11-18T10:00:00Z' }),
  ];
  const nowMs = Date.parse('2026-11-23T05:00:00Z');

  assert.deepEqual(dailyApplications(apps, nowMs), [
    { date: '2026-11-17', count: 0, cumulative: 0 },
    { date: '2026-11-18', count: 2, cumulative: 2 },
    { date: '2026-11-19', count: 0, cumulative: 2 },
    { date: '2026-11-20', count: 0, cumulative: 2 },
    { date: '2026-11-21', count: 1, cumulative: 3 },
    { date: '2026-11-22', count: 0, cumulative: 3 },
    { date: '2026-11-23', count: 0, cumulative: 3 },
  ]);
});

test('dailyApplications extends to last createdAt when later than today and crosses year boundaries', () => {
  const apps = [
    sampleApplication({ id: 'CC25-000001', createdAt: '2026-12-26T03:00:00Z' }),
    sampleApplication({ id: 'CC25-000002', createdAt: '2027-01-02T03:00:00Z' }),
  ];
  const now = new Date('2026-12-31T03:00:00Z');

  assert.deepEqual(dailyApplications(apps, now), [
    { date: '2026-12-26', count: 1, cumulative: 1 },
    { date: '2026-12-27', count: 0, cumulative: 1 },
    { date: '2026-12-28', count: 0, cumulative: 1 },
    { date: '2026-12-29', count: 0, cumulative: 1 },
    { date: '2026-12-30', count: 0, cumulative: 1 },
    { date: '2026-12-31', count: 0, cumulative: 1 },
    { date: '2027-01-01', count: 0, cumulative: 1 },
    { date: '2027-01-02', count: 1, cumulative: 2 },
  ]);
});

test('dailyApplications pads to at least 7 consecutive days ending today with leading zeros', () => {
  const apps = [sampleApplication({ id: 'CC25-000001', createdAt: '2026-11-20T03:00:00Z' })];
  const now = Date.parse('2026-11-21T05:00:00Z');

  assert.deepEqual(dailyApplications(apps, now), [
    { date: '2026-11-15', count: 0, cumulative: 0 },
    { date: '2026-11-16', count: 0, cumulative: 0 },
    { date: '2026-11-17', count: 0, cumulative: 0 },
    { date: '2026-11-18', count: 0, cumulative: 0 },
    { date: '2026-11-19', count: 0, cumulative: 0 },
    { date: '2026-11-20', count: 1, cumulative: 1 },
    { date: '2026-11-21', count: 0, cumulative: 1 },
  ]);
});

test('dailyApplications pads across a month boundary when only today has data', () => {
  const apps = [sampleApplication({ id: 'CC25-000001', createdAt: '2026-12-02T03:00:00Z' })];
  const dates = dailyApplications(apps, new Date('2026-12-02T05:00:00Z')).map((p) => p.date);

  assert.deepEqual(dates, [
    '2026-11-26',
    '2026-11-27',
    '2026-11-28',
    '2026-11-29',
    '2026-11-30',
    '2026-12-01',
    '2026-12-02',
  ]);
});

test('dailyApplications does not pad when the span already exceeds 7 days', () => {
  const apps = [sampleApplication({ id: 'CC25-000001', createdAt: '2026-11-10T03:00:00Z' })];
  const points = dailyApplications(apps, Date.parse('2026-11-21T05:00:00Z'));

  assert.equal(points.length, 12);
  assert.equal(points[0]?.date, '2026-11-10');
  assert.equal(points[11]?.date, '2026-11-21');
});

test('topCounts returns empty array for empty input', () => {
  assert.deepEqual(topCounts([], 5), []);
  assert.deepEqual(topCounts([], 0), []);
});

test('topCounts trims values and groups empty or nullish values under emptyLabel', () => {
  assert.deepEqual(topCounts(['  เชียงใหม่  ', 'เชียงใหม่', '', '   ', null, undefined], 5), [
    { label: 'ไม่ระบุ', count: 4 },
    { label: 'เชียงใหม่', count: 2 },
  ]);

  assert.deepEqual(topCounts(['', null, ' ลำพูน '], 5, 'อื่น', 'ว่าง'), [
    { label: 'ว่าง', count: 2 },
    { label: 'ลำพูน', count: 1 },
  ]);
});

test('topCounts sorts by count descending and breaks ties using Thai collation', () => {
  // In Thai collation, เชียงใหม่ (ช) sorts after ขอนแก่น (ข) and before ลำปาง (ล),
  // unlike raw UTF-16 codepoints where เ (U+0E40) sorts after ล (U+0E25).
  const values = ['ลำปาง', 'เชียงใหม่', 'ขอนแก่น', 'แม่ฮ่องสอน', 'แม่ฮ่องสอน'];
  assert.deepEqual(topCounts(values, 10), [
    { label: 'แม่ฮ่องสอน', count: 2 },
    { label: 'ขอนแก่น', count: 1 },
    { label: 'เชียงใหม่', count: 1 },
    { label: 'ลำปาง', count: 1 },
  ]);
});

test('topCounts merges rows beyond limit into one otherLabel row appended last only when > 0', () => {
  // Exact fit: no otherLabel row appended
  assert.deepEqual(topCounts(['A', 'A', 'B'], 2), [
    { label: 'A', count: 2 },
    { label: 'B', count: 1 },
  ]);

  // Overflow: merged count (4) exceeds top row (3), still appended last
  const values = ['ก', 'ก', 'ก', 'ข', 'ข', 'ค', 'ง', 'จ', 'ฉ'];
  assert.deepEqual(topCounts(values, 2), [
    { label: 'ก', count: 3 },
    { label: 'ข', count: 2 },
    { label: 'อื่นๆ', count: 4 },
  ]);

  // Custom otherLabel and limit = 0
  assert.deepEqual(topCounts(['ก', 'ข', 'ค'], 0, 'ส่วนที่เหลือ'), [
    { label: 'ส่วนที่เหลือ', count: 3 },
  ]);
});

test('seatBreakdown handles empty input with numeric and null capacity', () => {
  assert.deepEqual(seatBreakdown([], 40), {
    capacity: 40,
    held: 0,
    confirmed: 0,
    awaiting: 0,
    free: 40,
    over: 0,
  });

  assert.deepEqual(seatBreakdown([], null), {
    capacity: null,
    held: 0,
    confirmed: 0,
    awaiting: 0,
    free: 0,
    over: 0,
  });
});

test('seatBreakdown counts seat-holding statuses via holdsSeat and separates confirmed vs awaiting', () => {
  const statuses: ApplicationStatus[] = [
    'CONFIRMED',
    'CONFIRMED',
    'PASSED',
    'PENDING',
    'RESERVE',
    'REJECTED',
    'REFUND_PENDING',
    'REFUNDED',
    'FORFEITED',
  ];
  const apps = statuses.map((status, idx) =>
    sampleApplication({ id: `CC25-00000${idx}`, status }),
  );

  assert.deepEqual(seatBreakdown(apps, 10), {
    capacity: 10,
    held: 5,
    confirmed: 2,
    awaiting: 3,
    free: 5,
    over: 0,
  });
});

test('seatBreakdown returns free = 0 and over = 0 when maxCapacity is null', () => {
  const apps = [
    sampleApplication({ id: 'CC25-000001', status: 'CONFIRMED' }),
    sampleApplication({ id: 'CC25-000002', status: 'PASSED' }),
    sampleApplication({ id: 'CC25-000003', status: 'FORFEITED' }),
  ];

  assert.deepEqual(seatBreakdown(apps, null), {
    capacity: null,
    held: 2,
    confirmed: 1,
    awaiting: 1,
    free: 0,
    over: 0,
  });
});

test('seatBreakdown handles exact capacity and over-capacity accurately', () => {
  const apps = [
    sampleApplication({ id: 'CC25-000001', status: 'CONFIRMED' }),
    sampleApplication({ id: 'CC25-000002', status: 'CONFIRMED' }),
    sampleApplication({ id: 'CC25-000003', status: 'PASSED' }),
    sampleApplication({ id: 'CC25-000004', status: 'PASSED' }),
    sampleApplication({ id: 'CC25-000005', status: 'REJECTED' }),
  ];

  assert.deepEqual(seatBreakdown(apps, 4), {
    capacity: 4,
    held: 4,
    confirmed: 2,
    awaiting: 2,
    free: 0,
    over: 0,
  });

  assert.deepEqual(seatBreakdown(apps, 2), {
    capacity: 2,
    held: 4,
    confirmed: 2,
    awaiting: 2,
    free: 0,
    over: 2,
  });
});
