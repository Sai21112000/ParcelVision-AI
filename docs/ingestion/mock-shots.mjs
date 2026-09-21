export const MOCK_SHOTS = [
  { tracking: ['LEXPU0703623961', .97], carrier: ['LEL Express (009/2021)', .95],
    recipient: ['K.Tomoya Sakai', .93], unit_raw: ['Floor 21 Marketing', .95],
    type: ['Small parcel', .94], condition: ['Appears Fine', .96], sender: ['Shopee Mall', .91],
    barcode: 'LEXPU0703623961' },
  { tracking: ['TH260330625225F', .96], carrier: ['Thailand Post (001/2021)', .92],
    recipient: ['K.Pitcha W.', .71], unit_raw: ['Floor 18 Finance', .93],
    type: ['Envelope', .95], condition: ['Appears Fine', .94], sender: ['Revenue Department', .58],
    barcode: 'TH260330625225F' },
  { tracking: ['C26072601838288', .94], carrier: ['Flash Express (004/2021)', .88],
    recipient: ['K.Priwach T.', .91], unit_raw: ['Floor 24 Engineering', .74],
    type: ['Large parcel (>5 kg)', .9], condition: ['Minor Damage', .82], sender: ['Lazada Seller', .69],
    barcode: 'C26072601838288' },
  { tracking: ['LEXPU0703471485', .95], carrier: ['LEL Express (009/2021)', .94],
    recipient: ['K.Ratchadawan P.', .92], unit_raw: ['Floor 21 marketing', .93],
    type: ['Medium parcel', .93], condition: ['Appears Fine', .95], sender: ['Shopee', .9],
    barcode: 'LEXPU0703471485' },
  { tracking: ['SCG2609187741', .68], carrier: ['SCG Express (011/2021)', .91],
    recipient: ['', .34], unit_raw: ['Floor 12', .66],
    type: ['Bag', .92], condition: ['Water Damage', .87], sender: ['', .21],
    barcode: 'SCG9999999999' },
  { tracking: ['JT2609181004TH', .93], carrier: ['J&T Express (003/2021)', .93],
    recipient: ['K.Jirayu M.', .9], unit_raw: ['Floor 9 customer service', .94],
    type: ['Small parcel', .96], condition: ['Appears Fine', .97], sender: ['TikTok Shop', .88],
    barcode: 'JT2609181004TH' },
];

export function mockToExtraction(shot) {
  const cell = (pair, extra = {}) => ({
    rawValue: pair[0] || null,
    normalizedValue: pair[0] || null,
    confidence: pair[0] ? pair[1] : 0,
    ...extra,
  });
  return {
    labelUsable: !!shot.tracking[0],
    labelCount: 1,
    carrier: cell(shot.carrier),
    trackingNumber: {
      rawValue: shot.tracking[0] || null,
      normalizedValue: shot.tracking[0] || null,
      confidence: shot.tracking[0] ? shot.tracking[1] : 0,
      visible: !!shot.tracking[0],
      barcodeMatch: null,
    },
    recipient: {
      name: { rawValue: shot.recipient[0] || null, confidence: shot.recipient[0] ? shot.recipient[1] : 0 },
      addressLines: shot.unit_raw[0] ? [{ value: shot.unit_raw[0], confidence: shot.unit_raw[1] }] : [],
      postalCode: { rawValue: null, confidence: 0 },
      phone: { rawValue: null, confidence: 0 },
    },
    sender: { name: { rawValue: shot.sender[0] || null, confidence: shot.sender[0] ? shot.sender[1] : 0 }, addressLines: [] },
    referenceNumbers: [],
    serviceType: { rawValue: null, confidence: 0 },
    additionalFields: [
      { key: 'unit_raw', value: shot.unit_raw[0] || '', confidence: shot.unit_raw[1] || 0 },
      { key: 'parcel_type', value: shot.type[0] || '', confidence: shot.type[1] || 0 },
      { key: 'condition', value: shot.condition[0] || '', confidence: shot.condition[1] || 0 },
    ],
    missingCriticalFields: [
      !shot.tracking[0] && 'trackingNumber',
      !shot.recipient[0] && 'recipient.name',
    ].filter(Boolean),
    requiresHumanReview: !shot.tracking[0] || shot.tracking[1] < 0.9 || !shot.recipient[0] || shot.recipient[1] < 0.9,
    reviewReasons: [],
  };
}
