import assert from 'node:assert/strict';
import test from 'node:test';

import { bahtText, formatThaiLongDate } from './thai-baht-text.ts';

test('bahtText reads whole baht', () => {
  assert.equal(bahtText(1200), 'หนึ่งพันสองร้อยบาทถ้วน');
  assert.equal(bahtText(21), 'ยี่สิบเอ็ดบาทถ้วน');
  assert.equal(bahtText(101), 'หนึ่งร้อยเอ็ดบาทถ้วน');
  assert.equal(bahtText(11), 'สิบเอ็ดบาทถ้วน');
  assert.equal(bahtText(1), 'หนึ่งบาทถ้วน');
  assert.equal(bahtText(10), 'สิบบาทถ้วน');
  assert.equal(bahtText(20), 'ยี่สิบบาทถ้วน');
  assert.equal(bahtText(0), 'ศูนย์บาทถ้วน');
  assert.equal(bahtText(250000), 'สองแสนห้าหมื่นบาทถ้วน');
});

test('bahtText reads satang', () => {
  assert.equal(bahtText(1500.5), 'หนึ่งพันห้าร้อยบาทห้าสิบสตางค์');
  assert.equal(bahtText('1500.5'), 'หนึ่งพันห้าร้อยบาทห้าสิบสตางค์');
  assert.equal(bahtText(0.25), 'ยี่สิบห้าสตางค์');
  assert.equal(bahtText('0.01'), 'หนึ่งสตางค์');
  assert.equal(bahtText('3.21'), 'สามบาทยี่สิบเอ็ดสตางค์');
  assert.equal(bahtText('1200.00'), 'หนึ่งพันสองร้อยบาทถ้วน');
});

test('bahtText rounds to satang half-up', () => {
  assert.equal(bahtText('1.005'), 'หนึ่งบาทหนึ่งสตางค์');
  assert.equal(bahtText('0.999'), 'หนึ่งบาทถ้วน');
});

test('bahtText reads millions recursively', () => {
  assert.equal(bahtText(1_000_000), 'หนึ่งล้านบาทถ้วน');
  assert.equal(bahtText('1,000,000'), 'หนึ่งล้านบาทถ้วน');
  assert.equal(bahtText(1_000_001), 'หนึ่งล้านเอ็ดบาทถ้วน');
  assert.equal(bahtText(11_000_000), 'สิบเอ็ดล้านบาทถ้วน');
  assert.equal(bahtText(21_500_000), 'ยี่สิบเอ็ดล้านห้าแสนบาทถ้วน');
  assert.equal(bahtText('1000000000000'), 'หนึ่งล้านล้านบาทถ้วน');
  assert.equal(bahtText(10_000_000), 'สิบล้านบาทถ้วน');
});

test('bahtText returns empty for invalid input', () => {
  assert.equal(bahtText(''), '');
  assert.equal(bahtText('.'), '');
  assert.equal(bahtText('abc'), '');
  assert.equal(bahtText('-5'), '');
  assert.equal(bahtText(-5), '');
  assert.equal(bahtText(Number.NaN), '');
});

test('formatThaiLongDate uses Thai month names and the Buddhist year', () => {
  assert.equal(formatThaiLongDate('2026-11-21'), '21 พฤศจิกายน 2569');
  assert.equal(formatThaiLongDate('2027-01-05'), '5 มกราคม 2570');
  assert.equal(formatThaiLongDate(''), '');
  assert.equal(formatThaiLongDate('2026-02-30'), '');
  assert.equal(formatThaiLongDate('21/11/2026'), '');
});
