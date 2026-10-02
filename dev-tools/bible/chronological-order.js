// Chronological reading order for the 1-year plan.
// Each entry is "BOOK", "BOOK n" or "BOOK a-b" using the BibleWorks book codes
// found in eBible's tel2017_vpl.txt. A bare "BOOK" means every chapter.
// fetch-irv.js expands this and fails if any chapter is missing or repeated.
module.exports = [
  // Creation to the patriarchs
  'GEN 1-11', 'JOB 1-42', 'GEN 12-50',

  // Exodus, Law and wilderness
  'EXO 1-40', 'LEV 1-27', 'NUM 1-36', 'DEU 1-34', 'PSA 90',

  // Conquest and judges
  'JOS 1-24', 'JDG 1-21', 'RUT 1-4',

  // Samuel, Saul and David's flight
  '1SA 1-17',
  '1SA 18-20', 'PSA 11', 'PSA 59',
  '1SA 21-24', 'PSA 7', 'PSA 27', 'PSA 31', 'PSA 34', 'PSA 52', 'PSA 56', 'PSA 120', 'PSA 140-142',
  '1SA 25-27', 'PSA 17', 'PSA 35', 'PSA 54', 'PSA 63',
  '1SA 28-31', 'PSA 18',

  // King David
  '2SA 1-4', 'PSA 6', 'PSA 8-10', 'PSA 14', 'PSA 16', 'PSA 19', 'PSA 21',
  '1CH 1-2', 'PSA 43-45', 'PSA 49', 'PSA 84-85', 'PSA 87',
  '1CH 3-5', 'PSA 73', 'PSA 77-78',
  '1CH 6', 'PSA 81', 'PSA 88', 'PSA 92-93',
  '1CH 7-10', 'PSA 102-104',
  '2SA 5', '1CH 11-12', 'PSA 133', 'PSA 106-107',
  '1CH 13-16', 'PSA 1-2', 'PSA 15', 'PSA 22-24', 'PSA 47', 'PSA 68',
  'PSA 89', 'PSA 96', 'PSA 100-101', 'PSA 105', 'PSA 132',
  '2SA 6-7', '1CH 17', 'PSA 25', 'PSA 29', 'PSA 33', 'PSA 36', 'PSA 39',
  '2SA 8-9', '1CH 18', 'PSA 50', 'PSA 53', 'PSA 60', 'PSA 75',
  '2SA 10', '1CH 19', 'PSA 20', 'PSA 65-67', 'PSA 69-70',
  '2SA 11-12', '1CH 20', 'PSA 32', 'PSA 51', 'PSA 86', 'PSA 122',
  '2SA 13-15', 'PSA 3-4', 'PSA 12-13', 'PSA 28', 'PSA 55',
  '2SA 16-18', 'PSA 26', 'PSA 40', 'PSA 58', 'PSA 61-62', 'PSA 64',
  '2SA 19-21', 'PSA 5', 'PSA 38', 'PSA 41-42',
  '2SA 22-23', 'PSA 57', 'PSA 95', 'PSA 97-99',
  '2SA 24', '1CH 21-22', 'PSA 30',
  'PSA 108-110',
  '1CH 23-25', 'PSA 131', 'PSA 138-139', 'PSA 143-145',
  '1CH 26-29', 'PSA 127',
  'PSA 111-118',

  // Solomon
  '1KI 1-2', 'PSA 37', 'PSA 71', 'PSA 94',
  'PSA 119',
  '1KI 3-4', '2CH 1', 'PSA 72',
  'SOL 1-8', 'PRO 1-24',
  '1KI 5-6', '2CH 2-3', '1KI 7', '2CH 4', '1KI 8', '2CH 5-7', 'PSA 136',
  'PSA 134', 'PSA 146-150',
  '1KI 9', '2CH 8', 'PRO 25-29', 'ECC 1-12',
  '1KI 10-11', '2CH 9', 'PRO 30-31',

  // Divided kingdom
  '1KI 12-14', '2CH 10-12',
  '1KI 15', '2CH 13-16',
  '1KI 16', '2CH 17',
  '1KI 17-22', '2CH 18',
  '2CH 19-23', 'OBA', 'PSA 82-83',
  '2KI 1-13', '2CH 24',
  '2KI 14', '2CH 25', 'JON 1-4',
  '2KI 15', '2CH 26', 'ISA 1-8', 'AMO 1-9',
  '2CH 27', 'ISA 9-12', 'MIC 1-7',
  '2CH 28', '2KI 16-17', 'ISA 13-27',
  '2KI 18', '2CH 29-31', 'PSA 48', 'HOS 1-14',
  'ISA 28-36', '2KI 19', 'PSA 46', 'PSA 76', 'PSA 80', 'PSA 135',
  'ISA 37-39', '2KI 20', '2CH 32',
  'ISA 40-66',
  '2KI 21', '2CH 33', 'NAH 1-3',
  '2KI 22-23', '2CH 34-35', 'ZEP 1-3',

  // Fall of Jerusalem and exile
  'JER 1-40', 'PSA 74', 'PSA 79',
  '2KI 24-25', '2CH 36', 'HAB 1-3',
  'JER 41-52', 'LAM 1-5',
  'EZE 1-48', 'JOE 1-3', 'DAN 1-12',

  // Return from exile
  'EZR 1-6', 'PSA 137', 'HAG 1-2', 'ZEC 1-14',
  'EST 1-10', 'EZR 7-10', 'NEH 1-13', 'PSA 121', 'PSA 123-126', 'PSA 128-130',
  'PSA 91', 'MAL 1-4',

  // Life of Jesus
  'MAT 1-28', 'MAR 1-16', 'LUK 1-24', 'JOH 1-21',

  // Early church and the letters, placed within Acts
  'ACT 1-12', 'JAM 1-5',
  'ACT 13-14', 'GAL 1-6',
  'ACT 15-17', '1TH 1-5', '2TH 1-3',
  'ACT 18-19', '1CO 1-16', '2CO 1-13',
  'ACT 20', 'ROM 1-16',
  'ACT 21-28', 'EPH 1-6', 'PHI 1-4', 'COL 1-4', 'PHM',
  '1TI 1-6', 'TIT 1-3', '1PE 1-5', 'HEB 1-13', '2TI 1-4', '2PE 1-3', 'JUD',
  '1JO 1-5', '2JO', '3JO', 'REV 1-22',
];
