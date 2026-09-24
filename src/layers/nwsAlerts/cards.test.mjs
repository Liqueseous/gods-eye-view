import test from 'node:test';
import assert from 'node:assert/strict';
import { alertTypeBadge, buildAlertCard } from './cards.js';

test('alert type badges classify common NWS event families', () => {
  assert.equal(alertTypeBadge('Tornado Warning').label, 'TORNADO');
  assert.equal(alertTypeBadge('Severe Thunderstorm Warning').label, 'THUNDERSTORM');
  assert.equal(alertTypeBadge('Flash Flood Warning').label, 'FLOOD');
  assert.equal(alertTypeBadge('Winter Storm Watch').label, 'WINTER');
  assert.equal(alertTypeBadge('Excessive Heat Warning').label, 'HEAT');
  assert.equal(alertTypeBadge('Dense Fog Advisory').label, 'WEATHER');
});

test('selected alert cards carry the type badge separately from severity', () => {
  const card = buildAlertCard(
    {
      stableId: 'urn:oid:test.1',
      event: 'Flash Flood Warning',
      severity: 'Severe',
      certainty: null,
      urgency: null,
      headline: null,
      areaDesc: null,
      senderName: null,
      effective: null,
      expires: null,
      instruction: null,
    },
    Date.now(),
  );
  assert.equal(card.badge, 'FLOOD');
  assert.equal(card.badgeAccent, '#39d0ff');
  assert.equal(card.accent, '#ff7a00');
  assert.equal(card.maxWidth, 360);
});
