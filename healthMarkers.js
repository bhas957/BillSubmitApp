// Blood-test markers tracked by the My Health Reports app.
//
// `key` is the stable id used everywhere (records, charts, AI context).
// `label` matches the test name as printed in Thyrocare / PharmEasy PDFs (used
// by the offline rule parser). low/high are the reference range used for
// colouring; `optimal` is an optional tighter target shown as a dashed band.
// `loinc` is the standard LOINC code, used for the FHIR export.
// `units` lists other units labs report this marker in, with the factor that
// converts them to `unit` (e.g. Apollo prints T3 in ng/mL, Thyrocare in ng/dL).
module.exports = [
  // ---- Thyroid
  { key: 'tsh', name: 'TSH (ultrasensitive)', cat: 'Thyroid', unit: 'µIU/mL', low: 0.54, high: 5.30, loinc: '3016-3', label: /TSH - ULTRASENSITIVE|THYROID STIMULATING HORMONE \(TSH\) C\.L\.I\.A/i },
  { key: 't3', name: 'Total T3', cat: 'Thyroid', unit: 'ng/dL', low: 80, high: 200, loinc: '3053-6', units: { 'ng/ml': 100 }, label: /TOTAL TRIIODOTHYRONINE \(T3\)/i },
  { key: 't4', name: 'Total T4', cat: 'Thyroid', unit: 'µg/dL', low: 4.8, high: 12.7, loinc: '3026-2', label: /TOTAL THYROXINE \(T4\)/i },
  { key: 'ft3', name: 'Free T3', cat: 'Thyroid', unit: 'pg/mL', low: 2.0, high: 4.4, loinc: '3051-0', label: /FREE TRIIODOTHYRONINE \(FT3\)/i },
  { key: 'ft4', name: 'Free T4', cat: 'Thyroid', unit: 'ng/dL', low: 0.93, high: 1.7, loinc: '3024-7', label: /FREE THYROXINE \(FT4\)/i },
  { key: 'antitpo', name: 'Anti-TPO antibodies', cat: 'Thyroid', unit: 'IU/mL', high: 9, loinc: '8099-4', label: /Anti-TPO antibody/i },
  { key: 'antitg', name: 'Anti-thyroglobulin antibodies', cat: 'Thyroid', unit: 'IU/mL', high: 4, loinc: '8098-6' },

  // ---- Sugar & insulin
  { key: 'fbs', name: 'Fasting blood sugar', cat: 'Sugar & insulin', unit: 'mg/dL', low: 70, high: 100, loinc: '1558-6', label: /FASTING BLOOD SUGAR ?(\(GLUCOSE\)|PHOTOMETRY)/i },
  { key: 'hba1c', name: 'HbA1c', cat: 'Sugar & insulin', unit: '%', high: 5.7, loinc: '4548-4', label: /(^|\s)HbA1c(\s|$)/i },
  { key: 'abg', name: 'Average blood glucose', cat: 'Sugar & insulin', unit: 'mg/dL', high: 117, loinc: '27353-2', label: /AVERAGE BLOOD GLUCOSE/i },
  { key: 'insulin', name: 'Insulin, fasting', cat: 'Sugar & insulin', unit: 'µU/mL', low: 1.9, high: 23, optimal: [2, 8], units: { 'uiu/ml': 1, 'miu/l': 1 }, label: /INSULIN - FASTING/i },
  { key: 'homair', name: 'HOMA-IR (calculated)', cat: 'Sugar & insulin', unit: '', high: 2.5, optimal: [0, 2], derived: (v) => (v.fbs && v.insulin ? +(v.fbs * v.insulin / 405).toFixed(2) : null) },

  // ---- Lipids & heart
  { key: 'chol', name: 'Total cholesterol', cat: 'Lipids & heart', unit: 'mg/dL', high: 200, loinc: '2093-3', label: /(^|\t|\s)TOTAL CHOLESTEROL/i },
  { key: 'hdl', name: 'HDL cholesterol', cat: 'Lipids & heart', unit: 'mg/dL', low: 40, high: 60, higherIsBetter: true, loinc: '2085-9', label: /HDL CHOLESTEROL - DIRECT/i },
  { key: 'ldl', name: 'LDL cholesterol', cat: 'Lipids & heart', unit: 'mg/dL', high: 100, loinc: '18262-6', label: /LDL CHOLESTEROL - DIRECT/i },
  { key: 'tg', name: 'Triglycerides', cat: 'Lipids & heart', unit: 'mg/dL', high: 150, loinc: '2571-8', label: /(^|\t|\s)TRIGLYCERIDES(\s|$)/i },
  { key: 'vldl', name: 'VLDL cholesterol', cat: 'Lipids & heart', unit: 'mg/dL', low: 5, high: 40, loinc: '13458-5', label: /VLDL CHOLESTEROL/i },
  { key: 'nonhdl', name: 'Non-HDL cholesterol', cat: 'Lipids & heart', unit: 'mg/dL', high: 160, loinc: '43396-1', label: /NON-HDL CHOLESTEROL/i },
  { key: 'tchdl', name: 'TC / HDL ratio', cat: 'Lipids & heart', unit: '', low: 3, high: 5, loinc: '9830-1', label: /TC\/ ?HDL CHOLESTEROL RATIO/i },
  { key: 'tghdl', name: 'TG / HDL ratio', cat: 'Lipids & heart', unit: '', high: 3.12, label: /TRIG \/ HDL RATIO/i },
  { key: 'ldlhdl', name: 'LDL / HDL ratio', cat: 'Lipids & heart', unit: '', low: 1.5, high: 3.5, label: /LDL \/ HDL RATIO/i },
  { key: 'apoa1', name: 'Apo A1', cat: 'Lipids & heart', unit: 'mg/dL', low: 86, high: 152, loinc: '1869-7', label: /APOLIPOPROTEIN - A1/i },
  { key: 'apob', name: 'Apo B', cat: 'Lipids & heart', unit: 'mg/dL', low: 56, high: 145, optimal: [0, 90], loinc: '1884-6', label: /APOLIPOPROTEIN - B/i },
  { key: 'apoba1', name: 'Apo B / A1 ratio', cat: 'Lipids & heart', unit: '', low: 0.4, high: 1.26, label: /APO B \/ APO A1 RATIO/i },
  { key: 'lpa', name: 'Lipoprotein (a)', cat: 'Lipids & heart', unit: 'mg/dL', high: 30, loinc: '10835-7', label: /Lipoprotein \(a\)|LIPOPROTEIN \(A\)/i },
  { key: 'hscrp', name: 'hs-CRP', cat: 'Lipids & heart', unit: 'mg/L', high: 1, loinc: '30522-7', label: /HIGH SENSITIVITY C-REACTIVE PROTEIN/i },
  { key: 'homocys', name: 'Homocysteine', cat: 'Lipids & heart', unit: 'µmol/L', high: 15, loinc: '13965-9', label: /(^|\s|\t)HOMOCYSTEINE(\s|$)/i },

  // ---- Vitamins & minerals
  { key: 'vitd', name: 'Vitamin D (25-OH)', cat: 'Vitamins & minerals', unit: 'ng/mL', low: 30, high: 100, loinc: '62292-8', label: /25-OH VITAMIN D \(TOTAL\)/i },
  { key: 'b12', name: 'Vitamin B12', cat: 'Vitamins & minerals', unit: 'pg/mL', low: 197, high: 771, optimal: [400, 771], loinc: '2132-9', label: /VITAMIN B-12/i },
  { key: 'folate', name: 'Folate', cat: 'Vitamins & minerals', unit: 'ng/mL', low: 5.38, loinc: '2284-8', label: /FOLATE|FOLIC ACID/i },
  { key: 'mg', name: 'Magnesium', cat: 'Vitamins & minerals', unit: 'mg/dL', low: 1.9, high: 3.1, loinc: '19123-9', label: /(^|\s|\t)MAGNESIUM(\s|$)/i },
  { key: 'ca', name: 'Calcium', cat: 'Vitamins & minerals', unit: 'mg/dL', low: 8.8, high: 10.6, loinc: '17861-6', label: /(^|\s|\t)CALCIUM(\s|$)/i },

  // ---- Iron
  { key: 'iron', name: 'Serum iron', cat: 'Iron', unit: 'µg/dL', low: 65, high: 175, loinc: '2498-4', label: /(^|\t|\s)IRON(\s|$)/i, notLabel: /BINDING|DEFICIENCY|STUDIES|PROFILE/i },
  { key: 'tibc', name: 'TIBC', cat: 'Iron', unit: 'µg/dL', low: 225, high: 535, loinc: '2500-7', label: /TOTAL IRON BINDING CAPACITY/i },
  { key: 'tsat', name: 'Transferrin saturation', cat: 'Iron', unit: '%', low: 13, high: 45, loinc: '2502-3', label: /% TRANSFERRIN SATURATION/i },
  { key: 'ferritin', name: 'Ferritin', cat: 'Iron', unit: 'ng/mL', low: 21.8, high: 274.7, loinc: '2276-4', label: /(^|\s|\t)FERRITIN(\s|$)/i },

  // ---- Blood count (counts: 1/mm³ and 1/µL are the same thing, so cells/cu.mm × 0.001 = ×10³/µL)
  { key: 'hb', name: 'Haemoglobin', cat: 'Blood count', unit: 'g/dL', low: 13, high: 17, loinc: '718-7', label: /(^|\s)HEMOGLOBIN(\s|$)/i },
  { key: 'rbc', name: 'Total RBC', cat: 'Blood count', unit: '×10⁶/µL', low: 4.5, high: 5.5, loinc: '789-8', units: { 'million/mm3': 1, 'x10^6/ul': 1, '10^6/ul': 1, 'mill/ul': 1 }, label: /TOTAL RBC/i },
  { key: 'pcv', name: 'Haematocrit (PCV)', cat: 'Blood count', unit: '%', low: 40, high: 50, loinc: '4544-3', label: /HEMATOCRIT\s*\(PCV\)/i },
  { key: 'mcv', name: 'MCV', cat: 'Blood count', unit: 'fL', low: 83, high: 101, loinc: '787-2', label: /MEAN CORPUSCULAR VOLUME/i },
  { key: 'rdwcv', name: 'RDW-CV', cat: 'Blood count', unit: '%', low: 11.6, high: 14, loinc: '788-0', label: /RED CELL DISTRIBUTION WIDTH \(RDW ?- ?CV\)/i },
  { key: 'wbc', name: 'Total WBC', cat: 'Blood count', unit: '×10³/µL', low: 4, high: 10, loinc: '6690-2', units: 'count', label: /TOTAL LEUCOCYTES? COUNT/i },
  { key: 'neut', name: 'Neutrophils (absolute)', cat: 'Blood count', unit: '×10³/µL', low: 2, high: 7, loinc: '751-8', units: 'count', label: /NEUTROPHILS - ABSOLUTE COUNT/i },
  { key: 'lymph', name: 'Lymphocytes (absolute)', cat: 'Blood count', unit: '×10³/µL', low: 1, high: 3, loinc: '731-0', units: 'count', label: /LYMPHOCYTES - ABSOLUTE COUNT/i },
  { key: 'eos', name: 'Eosinophils (absolute)', cat: 'Blood count', unit: '×10³/µL', low: 0.02, high: 0.5, loinc: '711-2', units: 'count', label: /EOSINOPHILS - ABSOLUTE COUNT/i },
  { key: 'plt', name: 'Platelets', cat: 'Blood count', unit: '×10³/µL', low: 150, high: 410, loinc: '777-3', units: 'count', label: /PLATELET COUNT/i },
  { key: 'esr', name: 'ESR', cat: 'Blood count', unit: 'mm/hr', high: 15, loinc: '30341-2', label: /ERYTHROCYTE SEDIMENTATION RATE|(^|\t|\s)ESR(\s|$)/i, notLabel: /ANALYSIS|USTSH|,/i },

  // ---- Liver
  { key: 'alt', name: 'ALT (SGPT)', cat: 'Liver', unit: 'U/L', high: 45, loinc: '1742-6', label: /ALANINE TRANSAMINASE \(SGPT\)/i },
  { key: 'ast', name: 'AST (SGOT)', cat: 'Liver', unit: 'U/L', high: 35, loinc: '1920-8', label: /ASPARTATE AMINOTRANSFERASE \(SGOT ?\)/i },
  { key: 'ggt', name: 'GGT', cat: 'Liver', unit: 'U/L', high: 55, loinc: '2324-2', label: /GAMMA GLUTAMYL TRANSFERASE/i },
  { key: 'alp', name: 'Alkaline phosphatase', cat: 'Liver', unit: 'U/L', low: 45, high: 129, loinc: '6768-6', label: /ALKALINE PHOSPHATASE/i },
  { key: 'bili', name: 'Bilirubin, total', cat: 'Liver', unit: 'mg/dL', low: 0.3, high: 1.2, loinc: '1975-2', label: /BILIRUBIN - TOTAL/i },
  { key: 'alb', name: 'Albumin', cat: 'Liver', unit: 'g/dL', low: 3.2, high: 4.8, loinc: '1751-7', label: /ALBUMIN - SERUM/i },

  // ---- Kidney & electrolytes
  { key: 'creat', name: 'Creatinine', cat: 'Kidney', unit: 'mg/dL', low: 0.72, high: 1.18, loinc: '2160-0', units: { 'umol/l': 1 / 88.4 }, label: /CREATININE - SERUM/i },
  { key: 'egfr', name: 'eGFR', cat: 'Kidney', unit: 'mL/min/1.73m²', low: 90, higherIsBetter: true, label: /EST\. GLOMERULAR FILTRATION RATE|ESTIMATED GLOMERULAR FILTRATION RATE|\(eGFR\)/i },
  { key: 'bun', name: 'Blood urea nitrogen', cat: 'Kidney', unit: 'mg/dL', low: 7.94, high: 20.07, loinc: '3094-0', label: /BLOOD UREA NITROGEN \(BUN\)/i },
  { key: 'uric', name: 'Uric acid', cat: 'Kidney', unit: 'mg/dL', low: 4.2, high: 7.3, loinc: '3084-1', label: /(^|\t|\s)URIC ACID(\s|$)/i },
  { key: 'na', name: 'Sodium', cat: 'Kidney', unit: 'mmol/L', low: 136, high: 145, loinc: '2951-2', units: { 'meq/l': 1 }, label: /(^|\t|\s)SODIUM(\s|$)/i },
  { key: 'k', name: 'Potassium', cat: 'Kidney', unit: 'mmol/L', low: 3.5, high: 5.1, loinc: '2823-3', units: { 'meq/l': 1 }, label: /(^|\t|\s)POTASSIUM(\s|$)/i },

  // ---- Hormones & muscle
  { key: 'testo', name: 'Testosterone (total)', cat: 'Hormones & muscle', unit: 'ng/dL', low: 280, high: 800, higherIsBetter: true, loinc: '2986-8', units: { 'ng/ml': 100 }, label: /(^|\t|\s)TESTOSTERONE(\s|$)/i },
  { key: 'cortisol', name: 'Cortisol (morning)', cat: 'Hormones & muscle', unit: 'µg/dL', low: 6.7, high: 22.6, loinc: '2143-6', label: /(^|\t|\s)CORTISOL(\s|$)/i },
  { key: 'cpk', name: 'CPK', cat: 'Hormones & muscle', unit: 'U/L', high: 190, loinc: '2157-6', label: /CREATINE PHOSPHOKINASE|(^|\t|\s)CPK(\s|$)/i },
  { key: 'psa', name: 'PSA', cat: 'Hormones & muscle', unit: 'ng/mL', high: 4, loinc: '2857-1', label: /PROSTATE SPECIFIC ANTIGEN|(^|\t|\s)PSA(\s|$)/i },

  // ---- Heavy metals
  { key: 'lead', name: 'Lead (blood)', cat: 'Heavy metals', unit: 'µg/L', high: 150, loinc: '5671-3', label: /(^|\t|\s)LEAD(\s|$)/i },
  { key: 'mercury', name: 'Mercury (blood)', cat: 'Heavy metals', unit: 'µg/L', high: 5, loinc: '5685-3', label: /(^|\t|\s)MERCURY(\s|$)/i },
  { key: 'arsenic', name: 'Arsenic (blood)', cat: 'Heavy metals', unit: 'µg/L', high: 5, loinc: '5586-2', label: /(^|\t|\s)ARSENIC(\s|$)/i },
];
