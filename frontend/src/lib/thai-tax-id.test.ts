import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatThaiAddress,
  formatThaiTaxId,
  isValidPostcode,
  isValidThaiTaxId,
  normalizePostcode,
  normalizeThaiTaxId,
} from './thai-tax-id.ts';

test('normalizeThaiTaxId converts Thai digits and strips separators and zero-width chars', () => {
  assert.equal(normalizeThaiTaxId('๑-๑๐๑๗-๐๐๒๐๓-๔๕-๐'), '1101700203450');
  assert.equal(normalizeThaiTaxId(' 1–1017—00203−45 0\u200b\uFEFF '), '1101700203450');
  assert.equal(normalizeThaiTaxId('110170020345a'), '110170020345a');
});

test('isValidThaiTaxId validates both individual and juristic 13-digit IDs', () => {
  // Individual ID (checksum 0)
  assert.equal(isValidThaiTaxId('1101700203450'), true);
  assert.equal(isValidThaiTaxId('1-1017-00203-45-0'), true);
  assert.equal(isValidThaiTaxId('๑-๑๐๑๗-๐๐๒๐๓-๔๕-๐'), true);
  // Juristic tax ID starting with 0: sum(0,1,0,5,5,5,8,0,0,1,2,3) = 219 -> 219%11 = 10 -> check = 1
  assert.equal(isValidThaiTaxId('0105558001231'), true);
  assert.equal(isValidThaiTaxId('0-1055-58001-23-1'), true);
  // Another valid ID where (11 - sum%11) === 11 -> %10 === 1
  assert.equal(isValidThaiTaxId('0000000000001'), true);
});

test('isValidThaiTaxId rejects bad checksum, wrong length, letters and empty', () => {
  assert.equal(isValidThaiTaxId('1101700203451'), false);
  assert.equal(isValidThaiTaxId('0105558001238'), false);
  assert.equal(isValidThaiTaxId('0000000000000'), false);
  assert.equal(isValidThaiTaxId('110170020345'), false);
  assert.equal(isValidThaiTaxId('11017002034500'), false);
  assert.equal(isValidThaiTaxId('110170020345a'), false);
  assert.equal(isValidThaiTaxId(''), false);
});

test('formatThaiTaxId groups 13 digits and leaves other values untouched', () => {
  assert.equal(formatThaiTaxId('1101700203450'), '1-1017-00203-45-0');
  assert.equal(formatThaiTaxId('๐๑๐๕๕๕๘๐๐๑๒๓๑'), '0-1055-58001-23-1');
  assert.equal(formatThaiTaxId('12345'), '12345');
  assert.equal(formatThaiTaxId(''), '');
});

test('postcode normalization and validation', () => {
  assert.equal(normalizePostcode(' ๕๐๒๙๐\u200b '), '50290');
  assert.equal(isValidPostcode('50290'), true);
  assert.equal(isValidPostcode('๕๐๒๙๐'), true);
  assert.equal(isValidPostcode('5029'), false);
  assert.equal(isValidPostcode('502900'), false);
  assert.equal(isValidPostcode('50-290'), false);
  assert.equal(isValidPostcode('5029a'), false);
  assert.equal(isValidPostcode(''), false);
});

test('formatThaiAddress formats provincial and Bangkok addresses without double prefixes', () => {
  assert.equal(
    formatThaiAddress({
      addressLine: '63 หมู่ 4 ถ.เชียงใหม่-พร้าว',
      subdistrict: 'หนองหาร',
      district: 'สันทราย',
      province: 'เชียงใหม่',
      postcode: '50290',
    }),
    '63 หมู่ 4 ถ.เชียงใหม่-พร้าว ต.หนองหาร อ.สันทราย จ.เชียงใหม่ 50290',
  );
  assert.equal(
    formatThaiAddress({
      addressLine: '12/3 ถ.สุขุมวิท',
      subdistrict: 'คลองตันเหนือ',
      district: 'วัฒนา',
      province: 'กรุงเทพมหานคร',
      postcode: '10110',
    }),
    '12/3 ถ.สุขุมวิท แขวงคลองตันเหนือ เขตวัฒนา กรุงเทพมหานคร 10110',
  );
  assert.equal(
    formatThaiAddress({
      addressLine: '1',
      subdistrict: 'ตำบลสุเทพ',
      district: 'อำเภอเมืองเชียงใหม่',
      province: 'เชียงใหม่',
      postcode: '50200',
    }),
    '1 ตำบลสุเทพ อำเภอเมืองเชียงใหม่ จ.เชียงใหม่ 50200',
  );
  assert.equal(formatThaiAddress({}), '');
});
