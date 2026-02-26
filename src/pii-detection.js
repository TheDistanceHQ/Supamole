/**
 * PII detection for GDPR review: checks column names and sample values
 * for suspected name, DOB, age, address, telephone.
 */

const MAX_EXAMPLES = 5;

const PII_RULES = [
  {
    piiType: 'name',
    columnPattern: /^(name|first_name|last_name|full_name|customer_name|user_name|display_name|contact_name|recipient_name|sender_name)$/i,
    valuePattern: /^[a-zA-Z\u00C0-\u024F\s'-]{2,80}$/,
  },
  {
    piiType: 'dob',
    columnPattern: /^(dob|date_of_birth|birth_date|birthdate|birth_day|dateofbirth)$/i,
    valuePattern: /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/,
  },
  {
    piiType: 'age',
    columnPattern: /^(age|user_age|customer_age)$/i,
    valuePattern: /^\s*(?:1[0-1]\d|[1-9]?\d|120)\s*$/,
  },
  {
    piiType: 'address',
    columnPattern: /^(address|street|address_line|city|postcode|zip|zipcode|postal_code|country|state|region)$/i,
    valuePattern: null, // optional: postcode could be \d{5}(-\d{4})? for US, etc.
  },
  {
    piiType: 'telephone',
    columnPattern: /^(phone|telephone|mobile|tel|cell|contact_number|phone_number|mobile_number)$/i,
    valuePattern: /^[\d\s\-+()]{10,20}$|^\+?[\d\s\-()]{10,}$/,
  },
];

/**
 * @param {Array<{ column_name: string, data_type?: string }>} tableColumns
 * @param {Array<Record<string, unknown>>} sampleRows
 * @returns {Array<{ column: string, piiType: string, confidence: 'column_name' | 'value', examples: string[] }>}
 */
function detectPII(tableColumns, sampleRows) {
  const findings = [];
  if (!tableColumns || tableColumns.length === 0) return findings;

  const columnNames = tableColumns.map((c) => c.column_name);

  for (const rule of PII_RULES) {
    for (const colName of columnNames) {
      if (!rule.columnPattern.test(colName)) continue;

      const examples = [];
      let confidence = 'column_name';

      if (Array.isArray(sampleRows) && sampleRows.length > 0) {
        const values = new Set();
        for (const row of sampleRows) {
          const v = row[colName];
          if (v == null || v === '') continue;
          const str = String(v).trim();
          if (rule.valuePattern && rule.valuePattern.test(str)) {
            values.add(str);
            confidence = 'value';
          } else if (!rule.valuePattern) {
            values.add(str);
          }
        }
        examples.push(...Array.from(values).slice(0, MAX_EXAMPLES));
      }

      findings.push({
        column: colName,
        piiType: rule.piiType,
        confidence,
        examples,
      });
    }
  }

  return findings;
}

export { detectPII, PII_RULES };
